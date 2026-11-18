import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AvailabilityModule } from "./availability/availability.module";
import { CacheModule } from "./cache/cache.module";
import { CatalogModule } from "./catalog/catalog.module";
import { DbModule } from "./db/db.module";
import { asTenant, createTenant } from "../test/helpers";

async function buildApp(redisUrl?: string): Promise<INestApplication> {
  const prev = process.env.REDIS_URL;
  if (redisUrl) process.env.REDIS_URL = redisUrl;
  const mod = await Test.createTestingModule({
    imports: [DbModule, CacheModule, CatalogModule, AvailabilityModule],
  }).compile();
  const app = mod.createNestApplication();
  await app.init();
  if (prev === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = prev;
  return app;
}

interface World {
  tenant: string;
  branch: string; // Sydney
  svc30: string;
  svcRoom: string;
  staffA: string;
  staffB: string;
  rooms: string[];
}

/** Sydney branch open every day 08:00-18:00, two staff working 09:00-11:00 every day. */
async function world(): Promise<World> {
  const tenant = await createTenant("avail");
  const w = await asTenant(tenant, async (c) => {
    const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
    const branch = (
      await q(
        "INSERT INTO branches (name, timezone) VALUES ('Syd','Australia/Sydney') RETURNING id",
      )
    )[0].id;
    const svc30 = (
      await q("INSERT INTO services (name, duration_min) VALUES ('Consult', 30) RETURNING id")
    )[0].id;
    const svcRoom = (
      await q(
        "INSERT INTO services (name, duration_min, requires_resource_type) VALUES ('Scan', 30, 'room') RETURNING id",
      )
    )[0].id;
    const staff: string[] = [];
    for (const n of ["A", "B"]) {
      const id = (await q("INSERT INTO staff (full_name) VALUES ($1) RETURNING id", [n]))[0]
        .id as string;
      staff.push(id);
      await q("INSERT INTO staff_branches (staff_id, branch_id) VALUES ($1,$2)", [id, branch]);
      await q("INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2),($1,$3)", [
        id,
        svc30,
        svcRoom,
      ]);
    }
    const rooms: string[] = [];
    for (const n of ["Room 1", "Room 2"])
      rooms.push(
        (
          await q(
            "INSERT INTO resources (branch_id, type, name) VALUES ($1,'room',$2) RETURNING id",
            [branch, n],
          )
        )[0].id,
      );
    for (let wd = 1; wd <= 7; wd++) {
      await q(
        "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('branch',$1,$2,'08:00','18:00')",
        [branch, wd],
      );
      for (const s of staff)
        await q(
          "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('staff',$1,$2,'09:00','11:00')",
          [s, wd],
        );
    }
    return { branch, svc30, svcRoom, staffA: staff[0]!, staffB: staff[1]!, rooms };
  });
  return { tenant, ...w };
}

/** Marks [start,end) busy on a resource (staff or room) with a confirmed booking. */
async function occupy(
  w: World,
  resourceId: string,
  start: string,
  end: string,
  opts: { status?: string; holdExpiresAt?: string } = {},
) {
  const status = opts.status ?? "confirmed";
  await asTenant(w.tenant, async (c) => {
    const customer = (await c.query("INSERT INTO customers (full_name) VALUES ('x') RETURNING id"))
      .rows[0].id;
    const b = (
      await c.query(
        `INSERT INTO bookings (branch_id, customer_id, service_id, status, start_at, end_at, hold_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [w.branch, customer, w.svc30, status, start, end, opts.holdExpiresAt ?? null],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO booking_resources (booking_id, resource_id, time_range, status) VALUES ($1,$2,tstzrange($3,$4),$5)",
      [b, resourceId, start, end, status],
    );
  });
}

// A Monday far in the future so "now" never filters slots out: 2036-03-03 is a Monday (AEDT, +11).
const DAY = "2036-03-03";
// Tests insert bookings straight into the DB (no invalidation, unlike the M3 booking service), so reads skip the cache.
const NO_CACHE = { "cache-control": "no-cache" };

describe("GET /branches/:id/availability", () => {
  let app: INestApplication;
  let w: World;
  const http = () => request(app.getHttpServer());
  const get = (q: Record<string, string>, tenant = w.tenant, extra: Record<string, string> = {}) =>
    http()
      .get(`/branches/${w.branch}/availability`)
      .query(q)
      .set({ "x-tenant-id": tenant, ...extra });
  const local = (res: request.Response) =>
    res.body.slots.map((s: { startLocal: string }) => s.startLocal.slice(11, 16));

  beforeAll(async () => {
    app = await buildApp();
    w = await world();
  });
  afterAll(() => app.close());

  it("returns branch-local slots with correct UTC instants (AEDT, +11)", async () => {
    const res = await get({ serviceId: w.svc30, from: DAY, to: DAY });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Australia/Sydney");
    expect(local(res)).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30"]);
    expect(res.body.slots[0].startAt).toBe("2036-03-02T22:00:00.000Z");
    expect(res.body.slots[0].startLocal).toBe("2036-03-03T09:00:00+11:00");
    expect(res.body.slots[0].staffOptions).toHaveLength(2);
  });

  it("a booked slot disappears for that staff member only; fully booked times disappear", async () => {
    await occupy(w, w.staffA, "2036-03-02T22:00:00Z", "2036-03-02T22:30:00Z"); // A: 09:00-09:30 local
    const one = await get({ serviceId: w.svc30, from: DAY, to: DAY }, w.tenant, NO_CACHE);
    expect(local(one)).toContain("09:00"); // B still free
    expect(one.body.slots[0].staffOptions).toEqual([w.staffB]);
    await occupy(w, w.staffB, "2036-03-02T22:00:00Z", "2036-03-02T22:30:00Z");
    const both = await get(
      { serviceId: w.svc30, from: DAY, to: DAY, staffId: w.staffA },
      w.tenant,
      NO_CACHE,
    );
    expect(local(both)).not.toContain("09:00");
    expect(local(both)).toContain("09:30");
  });

  it("a live hold blocks the slot, an expired hold frees it", async () => {
    const day = "2036-03-05";
    await occupy(w, w.staffA, "2036-03-04T22:00:00Z", "2036-03-04T22:30:00Z", {
      status: "held",
      holdExpiresAt: "2020-01-01T00:00:00Z",
    });
    const res = await get(
      { serviceId: w.svc30, from: day, to: day, staffId: w.staffA },
      w.tenant,
      NO_CACHE,
    );
    expect(local(res)).toContain("09:00");
    await occupy(w, w.staffA, "2036-03-04T23:00:00Z", "2036-03-04T23:30:00Z", {
      status: "held",
      holdExpiresAt: "2099-01-01T00:00:00Z",
    });
    const res2 = await get(
      { serviceId: w.svc30, from: day, to: day, staffId: w.staffA },
      w.tenant,
      { "cache-control": "no-cache" },
    );
    expect(local(res2)).not.toContain("10:00"); // live hold at 10:00 local blocks
    expect(local(res2)).toContain("09:00");
  });

  it("requires a free room at the same time and spreads load over rooms", async () => {
    const day = "2036-03-10";
    const free = await get({ serviceId: w.svcRoom, from: day, to: day });
    expect(free.body.slots[0].resourceId).toBe([...w.rooms].sort()[0]); // equal load => lowest id
    await occupy(w, w.rooms[0]!, "2036-03-09T22:00:00Z", "2036-03-09T23:00:00Z"); // room 1 busy 09:00-10:00
    await occupy(w, w.rooms[1]!, "2036-03-09T22:00:00Z", "2036-03-09T22:30:00Z"); // room 2 busy 09:00-09:30
    const res = await get({ serviceId: w.svcRoom, from: day, to: day }, w.tenant, NO_CACHE);
    expect(
      res.body.slots.find((s: { startLocal: string }) => s.startLocal.includes("T09:00")),
    ).toBeUndefined();
    const nine30 = res.body.slots.find((s: { startLocal: string }) =>
      s.startLocal.includes("T09:30"),
    );
    expect(nine30.resourceId).toBe(w.rooms[1]); // only room 2 is free at 09:30
  });

  it("branch closure and staff time off remove slots", async () => {
    const day = "2036-03-17";
    const off = await http()
      .post("/admin/time-off")
      .set({ "x-tenant-id": w.tenant })
      .send({
        ownerType: "staff",
        ownerId: w.staffA,
        startAt: "2036-03-16T22:00:00Z",
        endAt: "2036-03-17T00:00:00Z",
        reason: "leave",
      });
    expect(off.status).toBe(201);
    const res = await get({ serviceId: w.svc30, from: day, to: day });
    expect(
      res.body.slots.every((s: { staffOptions: string[] }) =>
        s.staffOptions.every((x) => x === w.staffB),
      ),
    ).toBe(true);
    await http()
      .post("/admin/time-off")
      .set({ "x-tenant-id": w.tenant })
      .send({
        ownerType: "branch",
        ownerId: w.branch,
        startAt: "2036-03-16T00:00:00Z",
        endAt: "2036-03-18T00:00:00Z",
      });
    expect((await get({ serviceId: w.svc30, from: day, to: day })).body.slots).toEqual([]);
  });

  it("handles the spring-forward night correctly (Sydney 2036-10-05 is the DST start)", async () => {
    // Night clinic 00:00-06:00 on the DST-start Sunday: 5 real hours, no 02:00 hour.
    const wn = await world();
    await asTenant(wn.tenant, async (c) => {
      await c.query("DELETE FROM working_hours");
      await c.query(
        "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('branch',$1,7,'00:00','06:00'),('staff',$2,7,'00:00','06:00')",
        [wn.branch, wn.staffA],
      );
      await c.query("UPDATE services SET duration_min = 60 WHERE id = $1", [wn.svc30]);
    });
    const res = await request(app.getHttpServer())
      .get(`/branches/${wn.branch}/availability`)
      .query({ serviceId: wn.svc30, from: "2036-10-05", to: "2036-10-05", staffId: wn.staffA })
      .set({ "x-tenant-id": wn.tenant });
    expect(res.status).toBe(200);
    // step is 15 min, so check hourly starts only
    const hourly = res.body.slots
      .map((s: { startLocal: string }) => s.startLocal.slice(11, 16))
      .filter((t: string) => t.endsWith(":00"));
    expect(hourly).toEqual(["00:00", "01:00", "03:00", "04:00", "05:00"]);
  });

  it("validates input and isolates tenants", async () => {
    expect((await get({ serviceId: "nope", from: DAY, to: DAY })).status).toBe(400);
    expect((await get({ serviceId: w.svc30, from: DAY, to: "2036-01-01" })).status).toBe(400);
    expect((await get({ serviceId: w.svc30, from: "2036-01-01", to: "2036-03-30" })).status).toBe(
      400,
    ); // > 31 days
    expect((await get({ serviceId: randomUUID(), from: DAY, to: DAY })).status).toBe(404);
    const other = await createTenant("avail-other");
    expect((await get({ serviceId: w.svc30, from: DAY, to: DAY }, other)).status).toBe(404); // branch invisible
    expect(
      (await get({ serviceId: w.svc30, from: DAY, to: DAY, staffId: randomUUID() })).status,
    ).toBe(422);
    expect(
      (
        await http()
          .get(`/branches/${w.branch}/availability`)
          .query({ serviceId: w.svc30, from: DAY, to: DAY })
      ).status,
    ).toBe(401);
  });
});

describe("availability cache", () => {
  let app: INestApplication;
  let w: World;
  const q = () => ({ serviceId: w.svc30, from: "2036-04-07", to: "2036-04-07" });
  const get = (a: INestApplication) =>
    request(a.getHttpServer())
      .get(`/branches/${w.branch}/availability`)
      .query(q())
      .set("x-tenant-id", w.tenant);

  beforeAll(async () => {
    app = await buildApp();
    w = await world();
  });
  afterAll(() => app.close());

  it("misses, then hits; catalog changes invalidate; bypass skips the cache", async () => {
    const first = await get(app);
    expect(first.headers["x-cache"]).toBe("miss");
    const second = await get(app);
    expect(second.headers["x-cache"]).toBe("hit");
    expect(second.body.slots).toEqual(first.body.slots);

    await request(app.getHttpServer())
      .post("/admin/time-off")
      .set("x-tenant-id", w.tenant)
      .send({
        ownerType: "branch",
        ownerId: w.branch,
        startAt: "2036-04-06T00:00:00Z",
        endAt: "2036-04-09T00:00:00Z",
      });
    const third = await get(app);
    expect(third.headers["x-cache"]).toBe("miss"); // version bumped
    expect(third.body.slots).toEqual([]);

    const bypass = await request(app.getHttpServer())
      .get(`/branches/${w.branch}/availability`)
      .query(q())
      .set({ "x-tenant-id": w.tenant, "cache-control": "no-cache" });
    expect(bypass.headers["x-cache"]).toBe("bypass");
  });

  it("branch-level invalidation (what M3 bookings will call) also forces a recompute", async () => {
    const w2 = await world();
    const { CacheService } = await import("./cache/cache.service");
    const cache = app.get(CacheService);
    const get2 = () =>
      request(app.getHttpServer())
        .get(`/branches/${w2.branch}/availability`)
        .query({ serviceId: w2.svc30, from: "2036-04-14", to: "2036-04-14" })
        .set("x-tenant-id", w2.tenant);
    expect((await get2()).headers["x-cache"]).toBe("miss");
    expect((await get2()).headers["x-cache"]).toBe("hit");
    // 2036-04-14 is AEST (+10): DST ended on 2036-04-06, so 09:00 local = 23:00Z the day before
    await occupy(w2, w2.staffA, "2036-04-13T23:00:00Z", "2036-04-13T23:30:00Z");
    expect((await get2()).headers["x-cache"]).toBe("hit"); // stale until invalidated: that's why M3 must bump
    await cache.bumpBranch(w2.tenant, w2.branch);
    const fresh = await get2();
    expect(fresh.headers["x-cache"]).toBe("miss");
    expect(fresh.body.slots[0].staffOptions).toEqual([w2.staffB]);
  });

  it("still answers correctly when Redis is unreachable (cache is optional)", async () => {
    const noRedis = await buildApp("redis://127.0.0.1:1");
    const w3 = await world();
    const res = await request(noRedis.getHttpServer())
      .get(`/branches/${w3.branch}/availability`)
      .query({ serviceId: w3.svc30, from: "2036-04-21", to: "2036-04-21" })
      .set("x-tenant-id", w3.tenant);
    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("miss");
    expect(res.body.slots.length).toBeGreaterThan(0);
    await noRedis.close();
  });
});
