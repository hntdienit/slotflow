import { sql } from "drizzle-orm";
import { Client } from "pg";
import { pgCode } from "./db/pg-error";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbService } from "./db/db.service";
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
    const r = await db.db.execute(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("tenant A only sees its own rows", async () => {
    const rows = await db.withTenant(
      a,
      async (c) => (await c.execute(sql`SELECT name FROM branches`)).rows,
    );
    expect(rows.map((r) => r.name)).toEqual(["A-branch"]);
  });

  it("fails closed: no tenant context means no rows", async () => {
    const r = await db.db.execute(sql`SELECT * FROM branches`);
    expect(r.rowCount).toBe(0);
  });

  it("cannot read another tenant's row by id", async () => {
    const bId = await asTenant(
      b,
      async (c) => (await c.query("SELECT id FROM branches")).rows[0].id,
    );
    const rows = await db.withTenant(
      a,
      async (c) => (await c.execute(sql`SELECT * FROM branches WHERE id = ${bId}`)).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot insert a row for another tenant (WITH CHECK)", async () => {
    await expect(
      db.withTenant(a, (c) =>
        c.execute(
          sql`INSERT INTO branches (tenant_id, name, timezone) VALUES (${b}::uuid,'evil','UTC')`,
        ),
      ),
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === "42501");
  });

  it("cannot update or delete another tenant's row", async () => {
    const upd = await db.withTenant(a, (c) =>
      c.execute(sql`UPDATE branches SET name='hacked' WHERE name='B-branch'`),
    );
    const del = await db.withTenant(a, (c) =>
      c.execute(sql`DELETE FROM branches WHERE name='B-branch'`),
    );
    expect([upd.rowCount, del.rowCount]).toEqual([0, 0]);
    const stillThere = await asTenant(
      b,
      async (c) => (await c.query("SELECT name FROM branches")).rows,
    );
    expect(stillThere.map((r) => r.name)).toEqual(["B-branch"]);
  });

  it("tenants table only exposes the current tenant", async () => {
    const rows = await db.withTenant(
      a,
      async (c) => (await c.execute(sql`SELECT id FROM tenants`)).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([a]);
  });

  it("connects with a separate raw client too (sanity)", async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    expect((await c.query("SELECT * FROM staff")).rowCount).toBe(0);
    await c.end();
  });
});
