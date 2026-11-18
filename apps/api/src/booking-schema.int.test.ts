import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgCode } from "./db/pg-error";
import { DbService } from "./db/db.service";
import { asTenant, createTenant } from "../test/helpers";

// Schema-level proof of ADR-002 (the booking *service* arrives in M3).
describe("exclusion constraint on booking_resources", () => {
  const db = new DbService();
  let tenant: string;
  let ids: { branch: string; customer: string; service: string };
  const resourceId = randomUUID();

  beforeAll(async () => {
    tenant = await createTenant("excl");
    ids = await asTenant(tenant, async (c) => {
      const branch = (
        await c.query("INSERT INTO branches (name, timezone) VALUES ('b','UTC') RETURNING id")
      ).rows[0].id;
      const customer = (
        await c.query("INSERT INTO customers (full_name) VALUES ('c') RETURNING id")
      ).rows[0].id;
      const service = (
        await c.query("INSERT INTO services (name, duration_min) VALUES ('s', 30) RETURNING id")
      ).rows[0].id;
      return { branch, customer, service };
    });
  });
  afterAll(() => db.onModuleDestroy());

  async function book(start: string, end: string, status = "confirmed") {
    return db.withTenant(tenant, async (c) => {
      const b =
        await c.execute(sql`INSERT INTO bookings (branch_id, customer_id, service_id, status, start_at, end_at)
         VALUES (${ids.branch}::uuid, ${ids.customer}::uuid, ${ids.service}::uuid, ${status}, ${start}::timestamptz, ${end}::timestamptz) RETURNING id`);
      await c.execute(sql`INSERT INTO booking_resources (booking_id, resource_id, time_range, status)
         VALUES (${b.rows[0]!.id as string}::uuid, ${resourceId}::uuid, tstzrange(${start}::timestamptz, ${end}::timestamptz), ${status})`);
    });
  }

  it("accepts the first booking and back-to-back neighbours", async () => {
    await book("2026-12-01T09:00:00Z", "2026-12-01T09:30:00Z");
    await book("2026-12-01T09:30:00Z", "2026-12-01T10:00:00Z"); // [) ranges: touching is fine
  });

  it("rejects an overlapping booking for the same resource (23P01) and rolls back the booking row", async () => {
    await expect(book("2026-12-01T09:15:00Z", "2026-12-01T09:45:00Z")).rejects.toSatisfy(
      (e: unknown) => pgCode(e) === "23P01",
    );
    const n = await db.withTenant(
      tenant,
      async (c) => (await c.execute(sql`SELECT count(*)::int AS n FROM bookings`)).rows[0]!.n,
    );
    expect(n).toBe(2);
  });

  it("ignores released/expired rows, so a freed slot can be rebooked", async () => {
    await book("2026-12-02T09:00:00Z", "2026-12-02T09:30:00Z", "expired");
    await book("2026-12-02T09:00:00Z", "2026-12-02T09:30:00Z", "confirmed");
  });

  it("does not block a different resource at the same time", async () => {
    await db.withTenant(tenant, async (c) => {
      const b =
        await c.execute(sql`INSERT INTO bookings (branch_id, customer_id, service_id, status, start_at, end_at)
         VALUES (${ids.branch}::uuid, ${ids.customer}::uuid, ${ids.service}::uuid,'confirmed','2026-12-01T09:00Z','2026-12-01T09:30Z') RETURNING id`);
      await c.execute(sql`INSERT INTO booking_resources (booking_id, resource_id, time_range, status)
         VALUES (${b.rows[0]!.id as string}::uuid, ${randomUUID()}::uuid, tstzrange('2026-12-01T09:00Z','2026-12-01T09:30Z'),'confirmed')`);
    });
  });

  it("enforces idempotency key uniqueness per tenant", async () => {
    const ins = () =>
      db.withTenant(tenant, (c) =>
        c.execute(sql`INSERT INTO bookings (branch_id, customer_id, service_id, status, start_at, end_at, idempotency_key)
           VALUES (${ids.branch}::uuid, ${ids.customer}::uuid, ${ids.service}::uuid,'held','2026-12-05T09:00Z','2026-12-05T09:30Z','key-1')`),
      );
    await ins();
    await expect(ins()).rejects.toSatisfy((e: unknown) => pgCode(e) === "23505");
  });
});
