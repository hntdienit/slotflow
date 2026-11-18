import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbService } from "./db/db.service";
import { pgCode } from "./db/pg-error";
import { asTenant, createTenant } from "../test/helpers";

describe("row level security", () => {
  let a: string;
  let b: string;
  const db = new DbService();

  beforeAll(async () => {
    a = await createTenant("rls-a");
    b = await createTenant("rls-b");
    await asTenant(a, (c) =>
      c.query("INSERT INTO branches (name, timezone) VALUES ('A-branch','Asia/Ho_Chi_Minh')"),
    );
    await asTenant(b, (c) =>
      c.query("INSERT INTO branches (name, timezone) VALUES ('B-branch','Asia/Ho_Chi_Minh')"),
    );
  });
  afterAll(() => db.onModuleDestroy());

  it("app role is neither superuser nor BYPASSRLS", async () => {
    const r = await db.prisma.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(r[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("tenant A only sees its own rows", async () => {
    const rows = await db.withTenant(a, (tx) => tx.branch.findMany());
    expect(rows.map((r) => r.name)).toEqual(["A-branch"]);
  });

  it("fails closed: no tenant context means no rows", async () => {
    expect(await db.prisma.branch.findMany()).toHaveLength(0);
    expect(await db.prisma.staff.findMany()).toHaveLength(0);
  });

  it("cannot read another tenant's row by id", async () => {
    const bId = await asTenant(
      b,
      async (c) => (await c.query("SELECT id FROM branches")).rows[0].id as string,
    );
    const row = await db.withTenant(a, (tx) => tx.branch.findUnique({ where: { id: bId } }));
    expect(row).toBeNull();
  });

  it("cannot insert a row for another tenant (WITH CHECK)", async () => {
    await expect(
      db.withTenant(a, (tx) =>
        tx.branch.create({ data: { tenantId: b, name: "evil", timezone: "UTC" } }),
      ),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "42501");
  });

  it("cannot update or delete another tenant's row", async () => {
    const upd = await db.withTenant(a, (tx) =>
      tx.branch.updateMany({ where: { name: "B-branch" }, data: { name: "hacked" } }),
    );
    const del = await db.withTenant(a, (tx) =>
      tx.branch.deleteMany({ where: { name: "B-branch" } }),
    );
    expect([upd.count, del.count]).toEqual([0, 0]);
    const stillThere = await asTenant(
      b,
      async (c) => (await c.query("SELECT name FROM branches")).rows,
    );
    expect(stillThere.map((r) => r.name)).toEqual(["B-branch"]);
  });

  it("tenants table only exposes the current tenant", async () => {
    const rows = await db.withTenant(a, (tx) => tx.tenant.findMany());
    expect(rows.map((r) => r.id)).toEqual([a]);
  });

  it("tenant context does not leak between pooled transactions", async () => {
    await db.withTenant(a, (tx) => tx.branch.findMany());
    expect(await db.prisma.branch.findMany()).toHaveLength(0);
  });
});
