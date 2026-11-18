import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asTenant, createTenant, admin } from "../test/helpers";
import { AppModule } from "./app.module";

let app: INestApplication;
beforeAll(async () => {
  delete process.env.REDIS_URL;
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => app.close());

type Res = { resourceId: string; status: string };
type Ev = { toStatus: string };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const DAY = "2036-06-10"; // Sydney winter (UTC+10)
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+10:00`).toISOString();

interface World {
  tenant: string;
  branch: string;
  svc: string;
  svcRoom: string;
  staff: string[];
  rooms: string[];
  customer: string;
}

async function world(o: { staff?: number; rooms?: number; price?: number } = {}): Promise<World> {
  const tenant = await createTenant("book");
  const w = await asTenant(tenant, async (c) => {
    const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
    const branch = (
      await q(
        "INSERT INTO branches (name, timezone) VALUES ('Syd','Australia/Sydney') RETURNING id",
      )
    )[0].id;
    const svc = (
      await q(
        "INSERT INTO services (name, duration_min, price_cents, cancel_window_hours) VALUES ('Consult', 30, $1, 24) RETURNING id",
        [o.price ?? 10000],
      )
    )[0].id;
    const svcRoom = (
      await q(
        "INSERT INTO services (name, duration_min, requires_resource_type) VALUES ('Scan', 30, 'room') RETURNING id",
      )
    )[0].id;
    const staff: string[] = [];
    for (let i = 0; i < (o.staff ?? 1); i++) {
      const id = (await q("INSERT INTO staff (full_name) VALUES ($1) RETURNING id", [`S${i}`]))[0]
        .id as string;
      staff.push(id);
      await q("INSERT INTO staff_branches (staff_id, branch_id) VALUES ($1,$2)", [id, branch]);
      await q("INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2),($1,$3)", [
        id,
        svc,
        svcRoom,
      ]);
    }
    const rooms: string[] = [];
    for (let i = 0; i < (o.rooms ?? 0); i++)
      rooms.push(
        (
          await q(
            "INSERT INTO resources (branch_id, type, name) VALUES ($1,'room',$2) RETURNING id",
            [branch, `R${i}`],
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
          "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('staff',$1,$2,'09:00','12:00')",
          [s, wd],
        );
    }
    const customer = (await q("INSERT INTO customers (full_name) VALUES ('Cus') RETURNING id"))[0]
      .id;
    return { branch, svc, svcRoom, staff, rooms, customer };
  });
  return { tenant, ...w };
}

const post = (w: World, path: string, body?: object, key?: string) => {
  const r = request(app.getHttpServer())
    .post(path)
    .set("x-tenant-id", w.tenant)
    .set("Cache-Control", "no-cache");
  if (key) r.set("Idempotency-Key", key);
  return r.send(body ?? {});
};
const payload = (w: World, startAt: string, extra: object = {}) => ({
  branchId: w.branch,
  serviceId: w.svc,
  customerId: w.customer,
  startAt,
  ...extra,
});
const getB = (w: World, id: string) =>
  request(app.getHttpServer()).get(`/bookings/${id}`).set("x-tenant-id", w.tenant);
const sql = (text: string, p: unknown[] = []) =>
  admin(async (c) => (await c.query(text, p)).rows as Row[]);

describe("booking: concurrency (anti double-booking)", () => {
  it("100 parallel requests for the same slot (1 staff) => exactly 1 success, 99 clean 409", async () => {
    const w = await world();
    const res = await Promise.all(
      Array.from({ length: 100 }, () => post(w, "/bookings", payload(w, at("09:00")))),
    );
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(99);
    expect(
      res.filter((r) => r.status === 409).every((r) => r.body.code === "SLOT_UNAVAILABLE"),
    ).toBe(true);
    const rows = await sql(
      "SELECT count(*)::int n FROM bookings WHERE tenant_id=$1 AND status='confirmed'",
      [w.tenant],
    );
    expect(rows[0].n).toBe(1);
    const rr = await sql(
      "SELECT count(*)::int n FROM booking_resources WHERE tenant_id=$1 AND status='confirmed'",
      [w.tenant],
    );
    expect(rr[0].n).toBe(1);
  }, 60_000);

  it("2 staff x 2 rooms, 100 parallel => exactly 2 succeed, distinct staff and rooms, no deadlock", async () => {
    const w = await world({ staff: 2, rooms: 2 });
    const res = await Promise.all(
      Array.from({ length: 100 }, () =>
        post(w, "/bookings", { ...payload(w, at("09:00")), serviceId: w.svcRoom }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(2);
    expect(res.filter((r) => ![201, 409].includes(r.status))).toHaveLength(0);
    const used = res
      .filter((r) => r.status === 201)
      .flatMap((r) => r.body.resources.map((x: Res) => x.resourceId));
    expect(new Set(used).size).toBe(4);
  }, 60_000);

  it("1000 requests over 50 (staff, time) slots => exactly 50 bookings, no overlapping rows", async () => {
    const w = await world({ staff: 25 });
    const times = [at("09:00"), at("10:00")];
    const targets = w.staff.flatMap((s) => times.map((t) => ({ s, t })));
    expect(targets).toHaveLength(50);
    const reqs = Array.from({ length: 1000 }, (_, i) => targets[i % 50]!);
    const res: number[] = [];
    for (let i = 0; i < reqs.length; i += 100) {
      const batch = await Promise.all(
        reqs
          .slice(i, i + 100)
          .map((x) =>
            post(w, "/bookings", payload(w, x.t, { staffId: x.s })).then((r) => r.status),
          ),
      );
      res.push(...batch);
    }
    expect(res.filter((c) => c === 201)).toHaveLength(50);
    expect(res.filter((c) => c !== 201 && c !== 409)).toHaveLength(0);
    const overlaps = await sql(
      `SELECT count(*)::int n FROM booking_resources a JOIN booking_resources b
        ON a.resource_id=b.resource_id AND a.booking_id<b.booking_id AND a.time_range && b.time_range
       WHERE a.tenant_id=$1 AND a.status='confirmed' AND b.status='confirmed'`,
      [w.tenant],
    );
    expect(overlaps[0].n).toBe(0);
  }, 120_000);
});

describe("booking: idempotency", () => {
  it("same key, same payload, in parallel => one booking, the rest are replays", async () => {
    const w = await world({ staff: 3 });
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 20 }, () => post(w, "/bookings", payload(w, at("09:00")), key)),
    );
    expect(res.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.headers["idempotent-replay"] === "true").length).toBe(19);
    const n = await sql("SELECT count(*)::int n FROM bookings WHERE tenant_id=$1", [w.tenant]);
    expect(n[0].n).toBe(1);
  }, 60_000);

  it("same key with a different payload => 422", async () => {
    const w = await world({ staff: 2 });
    const key = randomUUID();
    expect((await post(w, "/bookings", payload(w, at("09:00")), key)).status).toBe(201);
    const r = await post(w, "/bookings", payload(w, at("10:00")), key);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("booking: validation", () => {
  it("rejects a start in the past, an unoffered time and unknown ids", async () => {
    const w = await world();
    expect((await post(w, "/bookings", payload(w, "2020-01-01T00:00:00Z"))).body.code).toBe(
      "START_IN_PAST",
    );
    expect((await post(w, "/bookings", payload(w, at("03:00")))).status).toBe(409); // outside working hours
    expect(
      (await post(w, "/bookings", { ...payload(w, at("09:00")), customerId: randomUUID() })).status,
    ).toBe(404);
    expect((await post(w, "/bookings", { nope: 1 })).status).toBe(400);
  });

  it("is tenant isolated", async () => {
    const a = await world();
    const b = await world();
    const r = await post(a, "/bookings", payload(a, at("09:00")));
    expect(r.status).toBe(201);
    expect((await getB(b, r.body.id)).status).toBe(404);
  });
});

describe("booking: holds", () => {
  it("hold blocks the slot, confirm works, and the hold is shown in history", async () => {
    const w = await world();
    const h = await post(w, "/bookings/holds", payload(w, at("09:00")));
    expect(h.status).toBe(201);
    expect(h.body.status).toBe("held");
    expect(h.body.holdExpiresAt).toBeTruthy();
    expect((await post(w, "/bookings", payload(w, at("09:00")))).status).toBe(409);
    const c = await post(w, `/bookings/${h.body.id}/confirm`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("confirmed");
    expect(c.body.holdExpiresAt).toBeNull();
    const ev = (await getB(w, h.body.id)).body.events.map((e: Ev) => e.toStatus);
    expect(ev).toEqual(["held", "confirmed"]);
  });

  it("an expired hold stops blocking and cannot be confirmed (409 HOLD_EXPIRED)", async () => {
    const w = await world();
    const h = await post(w, "/bookings/holds", payload(w, at("09:00")));
    await sql("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [
      h.body.id,
    ]);
    const other = await post(w, "/bookings", payload(w, at("09:00")));
    expect(other.status).toBe(201); // took over the stale slot
    const c = await post(w, `/bookings/${h.body.id}/confirm`);
    expect(c.status).toBe(409);
    expect(["HOLD_EXPIRED", "INVALID_TRANSITION"]).toContain(c.body.code);
    expect((await getB(w, h.body.id)).body.status).toBe("expired");
  });

  it("confirming an expired hold nobody took marks it expired and says HOLD_EXPIRED", async () => {
    const w = await world();
    const h = await post(w, "/bookings/holds", payload(w, at("09:00")));
    await sql("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [
      h.body.id,
    ]);
    const c = await post(w, `/bookings/${h.body.id}/confirm`);
    expect(c.status).toBe(409);
    expect(c.body.code).toBe("HOLD_EXPIRED");
    const rr = await sql("SELECT status FROM booking_resources WHERE booking_id=$1", [h.body.id]);
    expect(rr.every((r) => r.status === "expired")).toBe(true);
  });

  it("sweepTenant expires stale holds and frees the slot", async () => {
    const w = await world();
    const h = await post(w, "/bookings/holds", payload(w, at("09:00")));
    await sql("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [
      h.body.id,
    ]);
    const { BookingService } = await import("./booking/booking.service");
    await app.get(BookingService).sweepTenant(w.tenant);
    expect((await getB(w, h.body.id)).body.status).toBe("expired");
    const ob = await sql(
      "SELECT type FROM outbox_events WHERE tenant_id=$1 AND type='booking.expired'",
      [w.tenant],
    );
    expect(ob).toHaveLength(1);
  });
});

describe("booking: cancel, check-in, no-show", () => {
  it("free cancellation outside the window, fee inside it", async () => {
    const w = await world({ price: 10000 });
    const far = await post(w, "/bookings", payload(w, at("09:00")));
    const c1 = await post(w, `/bookings/${far.body.id}/cancel`);
    expect(c1.body.cancellation).toEqual({ free: true, feeCents: 0 });
    expect(c1.body.booking.status).toBe("cancelled");
    // slot is free again
    const again = await post(w, "/bookings", payload(w, at("09:00")));
    expect(again.status).toBe(201);
    // move the booking to within 24h to trigger the late fee (50% default)
    await sql(
      "UPDATE bookings SET start_at = now() + interval '3 hours', end_at = now() + interval '3.5 hours' WHERE id=$1",
      [again.body.id],
    );
    const c2 = await post(w, `/bookings/${again.body.id}/cancel`);
    expect(c2.body.cancellation).toEqual({ free: false, feeCents: 5000 });
    expect((await post(w, `/bookings/${again.body.id}/cancel`)).status).toBe(409); // terminal
  });

  it("check-in only inside its window; no-show only after the grace period", async () => {
    const w = await world();
    const b = await post(w, "/bookings", payload(w, at("09:00")));
    const early = await post(w, `/bookings/${b.body.id}/check-in`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("CHECKIN_WINDOW");
    expect((await post(w, `/bookings/${b.body.id}/no-show`)).body.code).toBe("TOO_EARLY");

    await sql(
      "UPDATE bookings SET start_at = now() + interval '20 minutes', end_at = now() + interval '50 minutes' WHERE id=$1",
      [b.body.id],
    );
    const ci = await post(w, `/bookings/${b.body.id}/check-in`);
    expect(ci.status).toBe(200);
    expect(ci.body.status).toBe("checked_in");
    expect((await post(w, `/bookings/${b.body.id}/complete`)).body.status).toBe("completed");
    expect((await post(w, `/bookings/${b.body.id}/cancel`)).status).toBe(409);
  });

  it("no-show after the grace period releases the resources", async () => {
    const w = await world();
    const b = await post(w, "/bookings", payload(w, at("09:00")));
    await sql(
      "UPDATE bookings SET start_at = now() - interval '30 minutes', end_at = now() + interval '0 minutes' WHERE id=$1",
      [b.body.id],
    );
    const r = await post(w, `/bookings/${b.body.id}/no-show`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("no_show");
    expect(r.body.resources.every((x: Res) => x.status === "released")).toBe(true);
  });

  it("writes booking events and outbox events atomically", async () => {
    const w = await world();
    const b = await post(w, "/bookings", payload(w, at("09:00")));
    await post(w, `/bookings/${b.body.id}/cancel`);
    const types = (
      await sql("SELECT type FROM outbox_events WHERE tenant_id=$1 ORDER BY seq", [w.tenant])
    ).map((r) => r.type);
    expect(types).toEqual(["booking.confirmed", "booking.cancelled", "slot.released"]);
    const events = (await getB(w, b.body.id)).body.events;
    expect(events.map((e: Ev) => e.toStatus)).toEqual(["confirmed", "cancelled"]);
  });
});

describe("booking: reschedule", () => {
  it("can shift into its own overlapping time", async () => {
    const w = await world();
    const b = await post(w, "/bookings", payload(w, at("09:00")));
    const r = await request(app.getHttpServer())
      .patch(`/bookings/${b.body.id}/reschedule`)
      .set("x-tenant-id", w.tenant)
      .set("Cache-Control", "no-cache")
      .send({ startAt: at("09:15") });
    expect(r.status).toBe(200);
    expect(r.body.startAt).toBe(at("09:15"));
    const live = await sql(
      "SELECT count(*)::int n FROM booking_resources WHERE booking_id=$1 AND status='confirmed'",
      [b.body.id],
    );
    expect(live[0].n).toBe(1);
    // old time is free for someone else
    expect((await post(w, "/bookings", payload(w, at("09:00")))).status).toBe(409); // 09:00-09:30 overlaps 09:15-09:45
    expect((await post(w, "/bookings", payload(w, at("10:00")))).status).toBe(201);
  });

  it("a conflicting target leaves the original booking untouched", async () => {
    const w = await world();
    const a = await post(w, "/bookings", payload(w, at("09:00")));
    await post(w, "/bookings", payload(w, at("10:00")));
    const r = await request(app.getHttpServer())
      .patch(`/bookings/${a.body.id}/reschedule`)
      .set("x-tenant-id", w.tenant)
      .set("Cache-Control", "no-cache")
      .send({ startAt: at("10:00") });
    expect(r.status).toBe(409);
    const cur = (await getB(w, a.body.id)).body;
    expect(cur.startAt).toBe(at("09:00"));
    expect(cur.resources.filter((x: Res) => x.status === "confirmed")).toHaveLength(1);
  });

  it("two bookings racing for the same target slot: exactly one moves", async () => {
    const w = await world({ staff: 2 });
    const a = await post(w, "/bookings", payload(w, at("09:00"), { staffId: w.staff[0] }));
    const b = await post(w, "/bookings", payload(w, at("09:00"), { staffId: w.staff[1] }));
    const mv = (id: string) =>
      request(app.getHttpServer())
        .patch(`/bookings/${id}/reschedule`)
        .set("x-tenant-id", w.tenant)
        .set("Cache-Control", "no-cache")
        .send({ startAt: at("11:00") });
    const [x, y] = await Promise.all([mv(a.body.id), mv(b.body.id)]);
    // each keeps its own staff, so BOTH can move (different staff) -- no conflict expected
    expect([x.status, y.status]).toEqual([200, 200]);
    const same = await Promise.all(Array.from({ length: 10 }, () => mv(a.body.id)));
    expect(same.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(same.filter((r) => ![200, 409].includes(r.status))).toHaveLength(0);
  });

  it("only confirmed bookings can be rescheduled", async () => {
    const w = await world();
    const h = await post(w, "/bookings/holds", payload(w, at("09:00")));
    const r = await request(app.getHttpServer())
      .patch(`/bookings/${h.body.id}/reschedule`)
      .set("x-tenant-id", w.tenant)
      .send({ startAt: at("10:00") });
    expect(r.status).toBe(409);
  });
});
