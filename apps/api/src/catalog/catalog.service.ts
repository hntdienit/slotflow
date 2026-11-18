import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DbService } from "../db/db.service";
import { pgCode, pgMessage } from "../db/pg-error";
import { branches, staff, staffBranches, staffServices } from "../db/schema";
import { ENTITIES, EntityDef } from "./entities";

/** Generic row access: entity tables are looked up by name at runtime, so columns are indexed dynamically. */
type DynTable = PgTable & Record<string, PgColumn>;
const uuidSchema = z.string().uuid();

function mapDbError(e: unknown): never {
  switch (pgCode(e)) {
    case "23505":
      throw new ConflictException("Duplicate value violates a unique constraint");
    case "23503":
      throw new UnprocessableEntityException(
        "Referenced row not found, or row is still referenced",
      );
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
      throw new BadRequestException(pgMessage(e));
    default:
      throw e;
  }
}

@Injectable()
export class CatalogService {
  constructor(private readonly db: DbService) {}

  private def(entity: string): EntityDef & { t: DynTable } {
    const def = ENTITIES[entity];
    if (!def) throw new NotFoundException(`Unknown entity '${entity}'`);
    return { ...def, t: def.table as DynTable };
  }

  private parse(schema: z.ZodTypeAny, body: unknown): Record<string, unknown> {
    const r = schema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues);
    return r.data as Record<string, unknown>;
  }

  private id(raw: string): string {
    if (!uuidSchema.safeParse(raw).success) throw new BadRequestException("id must be a UUID");
    return raw;
  }

  async list(tenantId: string, entity: string, query: Record<string, string | undefined>) {
    const { t, filters, orderBy } = this.def(entity);
    const conds = filters.flatMap((f) => {
      const col = t[f];
      const v = query[f];
      return col && v !== undefined ? [eq(col, v)] : [];
    });
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const order = [...orderBy.map((c) => t[c]), t.id]
      .filter((c): c is PgColumn => !!c)
      .map((c) => asc(c));
    try {
      const items = await this.db.withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(t)
          .where(and(...conds))
          .orderBy(...order)
          .limit(limit)
          .offset(offset),
      );
      return { items, limit, offset };
    } catch (e) {
      return mapDbError(e);
    }
  }

  async get(tenantId: string, entity: string, id: string) {
    const { t } = this.def(entity);
    this.id(id);
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.select().from(t).where(eq(t.id!, id)),
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  async create(tenantId: string, entity: string, body: unknown) {
    const { t, create } = this.def(entity);
    const data = this.parse(create, body);
    try {
      return await this.db.withTenant(tenantId, async (tx) => {
        await this.assertOwner(tx, data);
        const rows = await tx.insert(t).values(data).returning();
        return rows[0];
      });
    } catch (e) {
      if (e instanceof UnprocessableEntityException) throw e;
      return mapDbError(e);
    }
  }

  async update(tenantId: string, entity: string, id: string, body: unknown) {
    const { t, update } = this.def(entity);
    this.id(id);
    const data = this.parse(update, body);
    if (Object.keys(data).length === 0) throw new BadRequestException("Empty update");
    try {
      const row = await this.db.withTenant(tenantId, async (tx) => {
        await this.assertOwner(tx, data);
        return (await tx.update(t).set(data).where(eq(t.id!, id)).returning())[0];
      });
      if (!row) throw new NotFoundException();
      return row;
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof UnprocessableEntityException) throw e;
      return mapDbError(e);
    }
  }

  async remove(tenantId: string, entity: string, id: string) {
    const { t } = this.def(entity);
    this.id(id);
    try {
      const rows = await this.db.withTenant(tenantId, (tx) =>
        tx.delete(t).where(eq(t.id!, id)).returning({ id: t.id! }),
      );
      if (!rows.length) throw new NotFoundException();
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      return mapDbError(e);
    }
  }

  /** Staff <-> branch / service links are replaced wholesale (PUT semantics). */
  async setStaffLinks(
    tenantId: string,
    staffId: string,
    kind: "branches" | "services",
    body: unknown,
  ) {
    this.id(staffId);
    const key = kind === "branches" ? "branchIds" : "serviceIds";
    const parsed = this.parse(z.object({ [key]: z.array(z.string().uuid()).max(500) }), body);
    const ids = [...new Set(parsed[key] as string[])];
    try {
      return await this.db.withTenant(tenantId, async (tx) => {
        const exists = await tx.select({ id: staff.id }).from(staff).where(eq(staff.id, staffId));
        if (!exists.length) throw new NotFoundException("staff not found");
        if (kind === "branches") {
          await tx.delete(staffBranches).where(eq(staffBranches.staffId, staffId));
          if (ids.length)
            await tx.insert(staffBranches).values(ids.map((branchId) => ({ staffId, branchId })));
        } else {
          await tx.delete(staffServices).where(eq(staffServices.staffId, staffId));
          if (ids.length)
            await tx.insert(staffServices).values(ids.map((serviceId) => ({ staffId, serviceId })));
        }
        return { [key]: ids };
      });
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      return mapDbError(e);
    }
  }

  async getStaffLinks(tenantId: string, staffId: string, kind: "branches" | "services") {
    this.id(staffId);
    const rows = await this.db.withTenant(tenantId, (tx) =>
      kind === "branches"
        ? tx
            .select({ id: staffBranches.branchId })
            .from(staffBranches)
            .where(eq(staffBranches.staffId, staffId))
            .orderBy(asc(staffBranches.branchId))
        : tx
            .select({ id: staffServices.serviceId })
            .from(staffServices)
            .where(eq(staffServices.staffId, staffId))
            .orderBy(asc(staffServices.serviceId)),
    );
    return { [kind === "branches" ? "branchIds" : "serviceIds"]: rows.map((r) => r.id) };
  }

  /** working_hours / time_off point at a branch or staff row without a FK (polymorphic): check it here. */
  private async assertOwner(
    tx: Parameters<Parameters<DbService["withTenant"]>[1]>[0],
    data: Record<string, unknown>,
  ) {
    if (!data.ownerType || !data.ownerId) return;
    const ownerId = String(data.ownerId);
    const rows =
      data.ownerType === "branch"
        ? await tx
            .select({ id: branches.id })
            .from(branches)
            .where(inArray(branches.id, [ownerId]))
        : await tx
            .select({ id: staff.id })
            .from(staff)
            .where(inArray(staff.id, [ownerId]));
    if (!rows.length)
      throw new UnprocessableEntityException(`${String(data.ownerType)} ${ownerId} not found`);
  }
}
