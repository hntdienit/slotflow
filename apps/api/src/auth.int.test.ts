import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, asTenant, createTenant } from "../test/helpers";
import { AppModule } from "./app.module";
import { hashPassword, signToken } from "./auth/token";

let app: INestApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.AUTH_MODE = "jwt";
  process.env.JWT_SECRET = SECRET;
  process.env.ASSISTANT_PROVIDER = "mock";
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => {
  delete process.env.AUTH_MODE;
  await app.close();
});

const DAY = "2036-06-10";
const PW = "demo1234";

async function world(name: string) {
  const tenant = await createTenant(name);
  const hash = hashPassword(PW);
  const w = await asTenant(tenant, async (c) => {
    const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
    const branches: string[] = [];
    for (const n of ["B1", "B2"])
      branches.push(
        (
          await q(
            "INSERT INTO branches (name, timezone) VALUES ($1,'Australia/Sydney') RETURNING id",
            [n],
          )
        )[0].id,
      );
    const svc = (
      await q("INSERT INTO services (name, duration_min) VALUES ('Consult', 30) RETURNING id")
    )[0].id;
    const staff = (await q("INSERT INTO staff (full_name) VALUES ('S') RETURNING id"))[0].id;
    for (const b of branches) {
      await q("INSERT INTO staff_branches (staff_id, branch_id) VALUES ($1,$2)", [staff, b]);
      for (let wd = 1; wd <= 7; wd++) {
        await q(
          "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('branch',$1,$2,'08:00','18:00')",
          [b, wd],
        );
      }
    }
    await q("INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2)", [staff, svc]);
    for (let wd = 1; wd <= 7; wd++)
      await q(
        "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('staff',$1,$2,'09:00','12:00')",
        [staff, wd],
      );
    const user = async (role: string, email = `${role}@x.test`) =>
      (
        await q("INSERT INTO users (email, role, password_hash) VALUES ($1,$2,$3) RETURNING id", [
          email,
          role,
          hash,
        ])
      )[0].id as string;
    const customers: string[] = [];
    for (const [n, email] of [
      ["c1", "customer@x.test"],
      ["c2", "customer2@x.test"],
    ] as const) {
      const u = await user("customer", email);
      customers.push(
        (
          await q("INSERT INTO customers (full_name, user_id) VALUES ($1,$2) RETURNING id", [n, u])
        )[0].id,
      );
    }
    await user("owner");
    const mgr = await user("manager");
    await q("INSERT INTO manager_branches (user_id, branch_id) VALUES ($1,$2)", [mgr, branches[0]]);
    return { branches, svc, customers };
  });
  return { tenant, ...w };
}

const login = async (tenantId: string, email: string, password = PW) =>
  request(app.getHttpServer()).post("/auth/login").send({ tenantId, email, password });
const tok = async (t: string, email: string) => (await login(t, email)).body.token as string;
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+10:00`).toISOString();
const bookAs = (token: string, branch: string, svc: string, customerId: string, hhmm: string) =>
  request(app.getHttpServer())
    .post("/bookings")
    .set("authorization", `Bearer ${token}`)
    .send({ branchId: branch, serviceId: svc, customerId, startAt: at(hhmm), source: "web" });

describe("authentication", () => {
  it("logs in, rejects wrong credentials uniformly, and requires a token elsewhere", async () => {
    const w = await world("auth1");
    const ok = await login(w.tenant, "owner@x.test");
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("owner");
    const bad = await login(w.tenant, "owner@x.test", "wrong");
    const unknown = await login(w.tenant, "nobody@x.test");
    expect([bad.status, unknown.status]).toEqual([401, 401]);
    expect(bad.body.message).toBe(unknown.body.message);
    expect(
      (await request(app.getHttpServer()).get("/admin/branches").set("x-tenant-id", w.tenant))
        .status,
    ).toBe(401);
    expect((await request(app.getHttpServer()).get("/health")).status).toBe(200);
    const me = await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", `Bearer ${ok.body.token}`);
    expect(me.body).toMatchObject({ tenantId: w.tenant, role: "owner" });
  });

  it("rejects forged and expired tokens", async () => {
    const w = await world("auth2");
    const forged = signToken({ sub: "u", tid: w.tenant, role: "owner" }, "z".repeat(40), 60);
    const expired = signToken(
      { sub: "u", tid: w.tenant, role: "owner" },
      SECRET,
      60,
      Date.now() - 3_600_000,
    );
    for (const t of [forged, expired])
      expect(
        (
          await request(app.getHttpServer())
            .get("/admin/branches")
            .set("authorization", `Bearer ${t}`)
        ).status,
      ).toBe(401);
  });

  it("slows password guessing", async () => {
    const w = await world("auth3");
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login(w.tenant, "owner@x.test", "bad")).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe("authorization", () => {
  it("lets a customer book only as themselves and see only their own bookings", async () => {
    const w = await world("authz1");
    const [c1, c2] = w.customers as [string, string];
    const t1 = await tok(w.tenant, "customer@x.test");
    const t2 = await tok(w.tenant, "customer2@x.test");
    const mine = await bookAs(t1, w.branches[0]!, w.svc, c1, "09:00");
    expect(mine.status).toBe(201);
    expect((await bookAs(t1, w.branches[0]!, w.svc, c2, "10:00")).status).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/bookings/${mine.body.id}`)
          .set("authorization", `Bearer ${t2}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/bookings/${mine.body.id}/cancel`)
          .set("authorization", `Bearer ${t2}`)
      ).status,
    ).toBe(404);
    const list = await request(app.getHttpServer())
      .get("/bookings?limit=50")
      .set("authorization", `Bearer ${t2}`);
    expect(list.body).toEqual([]);
    const own = await request(app.getHttpServer())
      .get(`/bookings?customerId=${c2}`)
      .set("authorization", `Bearer ${t1}`);
    expect(own.status).toBe(403);
  });

  it("keeps customers out of staff and admin actions", async () => {
    const w = await world("authz2");
    const t1 = await tok(w.tenant, "customer@x.test");
    const mine = await bookAs(t1, w.branches[0]!, w.svc, w.customers[0]!, "09:00");
    const h = { authorization: `Bearer ${t1}` };
    expect(
      (await request(app.getHttpServer()).post(`/bookings/${mine.body.id}/check-in`).set(h)).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post("/admin/services")
          .set(h)
          .send({ name: "x", durationMin: 30 })
      ).status,
    ).toBe(403);
    expect((await request(app.getHttpServer()).get("/admin/customers").set(h)).status).toBe(403);
    expect((await request(app.getHttpServer()).get("/admin/branches").set(h)).status).toBe(200);
  });

  it("limits a manager to assigned branches and reserves branch creation for owners", async () => {
    const w = await world("authz3");
    const m = await tok(w.tenant, "manager@x.test");
    const o = await tok(w.tenant, "owner@x.test");
    const mine = await bookAs(m, w.branches[0]!, w.svc, w.customers[0]!, "09:00");
    expect(mine.status).toBe(201);
    expect((await bookAs(m, w.branches[1]!, w.svc, w.customers[0]!, "09:00")).status).toBe(403);
    const other = await bookAs(o, w.branches[1]!, w.svc, w.customers[1]!, "10:00");
    expect(other.status).toBe(201);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/bookings/${other.body.id}`)
          .set("authorization", `Bearer ${m}`)
      ).status,
    ).toBe(404);
    expect(
      (await request(app.getHttpServer()).get("/bookings").set("authorization", `Bearer ${m}`))
        .status,
    ).toBe(400); // branchId required
    const create = (t: string) =>
      request(app.getHttpServer())
        .post("/admin/branches")
        .set("authorization", `Bearer ${t}`)
        .send({ name: "B3", timezone: "UTC" });
    expect((await create(m)).status).toBe(403);
    expect((await create(o)).status).toBe(201);
  });

  it("ignores x-tenant-id and cannot reach another tenant", async () => {
    const a = await world("authz4a");
    const b = await world("authz4b");
    const ta = await tok(a.tenant, "owner@x.test");
    const tb = await tok(b.tenant, "owner@x.test");
    const bb = await bookAs(tb, b.branches[0]!, b.svc, b.customers[0]!, "09:00");
    const res = await request(app.getHttpServer())
      .get(`/bookings/${bb.body.id}`)
      .set("authorization", `Bearer ${ta}`)
      .set("x-tenant-id", b.tenant);
    expect(res.status).toBe(404);
    const branches = await request(app.getHttpServer())
      .get("/admin/branches")
      .set("authorization", `Bearer ${ta}`)
      .set("x-tenant-id", b.tenant);
    expect(branches.body.items.every((x: { tenantId: string }) => x.tenantId === a.tenant)).toBe(
      true,
    );
  });

  it("uses the token's customer for the assistant and denies staff", async () => {
    const w = await world("authz5");
    const t1 = await tok(w.tenant, "customer@x.test");
    const o = await tok(w.tenant, "owner@x.test");
    const r = await request(app.getHttpServer())
      .post("/assistant/messages")
      .set("authorization", `Bearer ${t1}`)
      .set("x-customer-id", w.customers[1]!)
      .send({ message: `Consult ${DAY.slice(8)}/06/2036 B1` });
    expect(r.status).toBe(200);
    expect(r.body.awaiting).toBe("choice");
    await request(app.getHttpServer())
      .post("/assistant/messages")
      .set("authorization", `Bearer ${t1}`)
      .send({ conversationId: r.body.conversationId, message: "1" });
    const yes = await request(app.getHttpServer())
      .post("/assistant/messages")
      .set("authorization", `Bearer ${t1}`)
      .send({ conversationId: r.body.conversationId, message: "yes" });
    expect(yes.body.booking).toBeTruthy();
    const rows = await admin(
      async (c) =>
        (await c.query("SELECT customer_id FROM bookings WHERE tenant_id=$1", [w.tenant])).rows,
    );
    expect(rows).toEqual([{ customer_id: w.customers[0] }]); // the token's customer, not the header's
    expect(
      (
        await request(app.getHttpServer())
          .post("/assistant/messages")
          .set("authorization", `Bearer ${o}`)
          .send({ message: "hi" })
      ).status,
    ).toBe(403);
  });
});
