import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { z } from "zod";
import { DbService, Tx } from "../db/db.service";
import { pgCode, pgMessage, prismaCode } from "../db/pg-error";
import { ENTITIES, EntityDef } from "./entities";

type Row = Record<string, unknown>;
/** Entities are resolved by name at runtime, so Prisma delegates are used through a minimal interface. */
interface Delegate {
  findMany(args: unknown): Promise<Row[]>;
  findUnique(args: unknown): Promise<Row | null>;
  create(args: unknown): Promise<Row>;
  update(args: unknown): Promise<Row>;
  delete(args: unknown): Promise<Row>;
}
const delegate = (tx: Tx, model: string) =>
  (tx as unknown as Record<string, Delegate>)[model] as Delegate;
const uuidSchema = z.string().uuid();

function mapDbError(e: unknown): never {
  if (e instanceof NotFoundException || e instanceof UnprocessableEntityException) throw e;
  const sqlstate = pgCode(e);
  const prisma = prismaCode(e);
  if (prisma === "P2025") throw new NotFoundException();
  if (sqlstate === "23505" || prisma === "P2002")
    throw new ConflictException("Duplicate value violates a unique constraint");
  if (sqlstate === "23503" || prisma === "P2003")
    throw new UnprocessableEntityException("Referenced row not found, or row is still referenced");
  if (sqlstate && ["23514", "22P02", "22007", "22008"].includes(sqlstate))
    throw new BadRequestException(pgMessage(e));
  if (prisma === "P2004") throw new BadRequestException(pgMessage(e));
  throw e;
}

@Injectable()
export class CatalogService {
  constructor(private readonly db: DbService) {}

  private def(entity: string): EntityDef {
    const def = ENTITIES[entity];
    if (!def) throw new NotFoundException(`Unknown entity '${entity}'`);
    return def;
  }

  private parse(schema: z.ZodTypeAny, body: unknown): Row {
    const r = schema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues);
    return r.data as Row;
  }

  private id(raw: string): string {
    if (!uuidSchema.safeParse(raw).success) throw new BadRequestException("id must be a UUID");
    return raw;
  }

  /** Prisma returns `time` columns as Dates; the API exposes "HH:MM". */
  private out(def: EntityDef, row: Row): Row {
    if (!def.timeFields) return row;
    const copy = { ...row };
    for (const f of def.timeFields) {
      const v = copy[f];
      if (v instanceof Date) copy[f] = v.toISOString().slice(11, 16);
    }
    return copy;
  }

  async list(tenantId: string, entity: string, query: Record<string, string | undefined>) {
    const def = this.def(entity);
    const where: Row = {};
    for (const [name, schema] of Object.entries(def.filters)) {
      if (query[name] === undefined) continue;
      const r = schema.safeParse(query[name]);
      if (!r.success) throw new BadRequestException(`invalid filter '${name}'`);
      where[name] = r.data;
    }
    const take = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const skip = Math.max(Number(query.offset ?? 0) || 0, 0);
    const orderBy = [...def.orderBy, "id"].map((c) => ({ [c]: "asc" }));
    try {
      const rows = await this.db.withTenant(tenantId, (tx) =>
        delegate(tx, def.model).findMany({ where, orderBy, take, skip }),
      );
      return { items: rows.map((r) => this.out(def, r)), limit: take, offset: skip };
    } catch (e) {
      return mapDbError(e);
    }
  }

  async get(tenantId: string, entity: string, id: string) {
    const def = this.def(entity);
    this.id(id);
    const row = await this.db.withTenant(tenantId, (tx) =>
      delegate(tx, def.model).findUnique({ where: { id } }),
    );
    if (!row) throw new NotFoundException();
    return this.out(def, row);
  }

  async create(tenantId: string, entity: string, body: unknown) {
    const def = this.def(entity);
    const data = this.parse(def.create, body);
    try {
      const row = await this.db.withTenant(tenantId, async (tx) => {
        await this.assertOwner(tx, data);
        return delegate(tx, def.model).create({ data });
      });
      return this.out(def, row);
    } catch (e) {
      return mapDbError(e);
    }
  }

  async update(tenantId: string, entity: string, id: string, body: unknown) {
    const def = this.def(entity);
    this.id(id);
    const data = this.parse(def.update, body);
    if (Object.keys(data).length === 0) throw new BadRequestException("Empty update");
    try {
      const row = await this.db.withTenant(tenantId, async (tx) => {
        await this.assertOwner(tx, data);
        return delegate(tx, def.model).update({ where: { id }, data });
      });
      return this.out(def, row);
    } catch (e) {
      return mapDbError(e);
    }
  }

  async remove(tenantId: string, entity: string, id: string) {
    const def = this.def(entity);
    this.id(id);
    try {
      await this.db.withTenant(tenantId, (tx) => delegate(tx, def.model).delete({ where: { id } }));
    } catch (e) {
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
        if (!(await tx.staff.findUnique({ where: { id: staffId } })))
          throw new NotFoundException("staff not found");
        if (kind === "branches") {
          await tx.staffBranch.deleteMany({ where: { staffId } });
          await tx.staffBranch.createMany({ data: ids.map((branchId) => ({ staffId, branchId })) });
        } else {
          await tx.staffService.deleteMany({ where: { staffId } });
          await tx.staffService.createMany({
            data: ids.map((serviceId) => ({ staffId, serviceId })),
          });
        }
        return { [key]: ids };
      });
    } catch (e) {
      return mapDbError(e);
    }
  }

  async getStaffLinks(tenantId: string, staffId: string, kind: "branches" | "services") {
    this.id(staffId);
    return this.db.withTenant(tenantId, async (tx) => {
      if (kind === "branches") {
        const rows = await tx.staffBranch.findMany({
          where: { staffId },
          orderBy: { branchId: "asc" },
        });
        return { branchIds: rows.map((r) => r.branchId) };
      }
      const rows = await tx.staffService.findMany({
        where: { staffId },
        orderBy: { serviceId: "asc" },
      });
      return { serviceIds: rows.map((r) => r.serviceId) };
    });
  }

  /** working_hours / time_off point at a branch or staff row without a FK (polymorphic): check it here. */
  private async assertOwner(tx: Tx, data: Row) {
    if (!data.ownerType || !data.ownerId) return;
    const where = { id: String(data.ownerId) };
    const found =
      data.ownerType === "branch"
        ? await tx.branch.findUnique({ where })
        : await tx.staff.findUnique({ where });
    if (!found)
      throw new UnprocessableEntityException(`${String(data.ownerType)} ${where.id} not found`);
  }
}
