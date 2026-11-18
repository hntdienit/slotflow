import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, asTenant, createTenant } from "../test/helpers";
import { AppModule } from "./app.module";
import { BookingService } from "./booking/booking.service";
import { WaitlistService } from "./waitlist/waitlist.service";

let app: INestApplication;
let wl: WaitlistService;
beforeAll(async () => {
  delete process.env.REDIS_URL;
  process.env.INTERNAL_API_KEY = "test-internal-key";
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  wl = app.get(WaitlistService);
});
afterAll(async () => app.close());

const DAY = "2036-06-10"; // Sydney winter (UTC+10)
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+10:00`).toISOString();

interface World {
  tenant: string;
  branch: string;
  svc: string;
  staff: string;
  customers: string[];
}

/** One staff member, 09:00-12:00, a 30-minute service, and four customers. */
async function world(): Promise<World> {
  const tenant = await createTenant("wl");
  const w = await asTenant(tenant, async (c) => {
    const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
    const branch = (
      await q(
        "INSERT INTO branches (name, timezone) VALUES ('Syd','Australia/Sydney') RETURNING id",
      )
    )[0].id;
    const svc = (
      await q("INSERT INTO services (name, duration_min) VALUES ('Consult', 30) RETURNING id")
    )[0].id;
    const staff = (await q("INSERT INTO staff (full_name) VALUES ('S') RETURNING id"))[0]
      .id as string;
    await q("INSERT INTO staff_branches (staff_id, branch_id) VALUES ($1,$2)", [staff, branch]);
    await q("INSERT INTO staff_services (staff_id, service_id) VALUES ($1,$2)", [staff, svc]);
    for (let wd = 1; wd <= 7; wd++) {
      await q(
        "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('branch',$1,$2,'08:00','18:00')",
        [branch, wd],
      );
      await q(
        "INSERT INTO working_hours (owner_type, owner_id, weekday, start_local, end_local) VALUES ('staff',$1,$2,'09:00','12:00')",
        [staff, wd],
      );
    }
    const customers: string[] = [];
    for (const n of ["X", "A", "B", "Y"])
      customers.push(
        (await q("INSERT INTO customers (full_name) VALUES ($1) RETURNING id", [n]))[0].id,
      );
    return { branch, svc, staff, customers };
  });
  return { tenant, ...w };
}

const api = (w: World) => ({
  post: (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set("x-tenant-id", w.tenant)
      .set("Cache-Control", "no-cache")
      .send(body),
  get: (path: string) => request(app.getHttpServer()).get(path).set("x-tenant-id", w.tenant),
  del: (path: string) => request(app.getHttpServer()).delete(path).set("x-tenant-id", w.tenant),
});
const sql = (text: string, p: unknown[] = []) =>
  admin(async (c) => (await c.query(text, p)).rows as Record<string, any>[]); // eslint-disable-line @typescript-eslint/no-explicit-any

const [X, A, B, Y] = [0, 1, 2, 3];
const book = async (w: World, customer: number, hhmm = "09:00") => {
  const r = await api(w).post("/bookings", {
    branchId: w.branch,
    serviceId: w.svc,
    customerId: w.customers[customer],
    startAt: at(hhmm),
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
};
const join = async (w: World, customer: number, from = "09:00", to = "10:00") => {
  const r = await api(w).post("/waitlist", {
    branchId: w.branch,
    serviceId: w.svc,
    customerId: w.customers[customer],
    windowStart: at(from),
    windowEnd: at(to),
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
};
const cancelBooking = (w: World, id: string) => api(w).post(`/bookings/${id}/cancel`);
const entryStatus = async (id: string) =>
  (await sql("SELECT status FROM waitlist_entries WHERE id=$1", [id]))[0]!.status as string;
const openOffers = async (w: World) =>
  sql(
    "SELECT o.id, o.entry_id, o.booking_id FROM waitlist_offers o WHERE o.tenant_id=$1 AND o.status='open'",
    [w.tenant],
  );

describe("waitlist: joining", () => {
  it("validates the window and keeps the original place on a duplicate request", async () => {
    const w = await world();
    const body = {
      branchId: w.branch,
      serviceId: w.svc,
      customerId: w.customers[A],
      windowStart: at("09:00"),
      windowEnd: at("10:00"),
    };
    const first = await api(w).post("/waitlist", body);
    const again = await api(w).post("/waitlist", body);
    expect(first.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect((await api(w).post("/waitlist", { ...body, windowEnd: at("08:00") })).body.code).toBe(
      "BAD_WINDOW",
    );
    expect(
      (
        await api(w).post("/waitlist", {
          ...body,
          windowStart: "2020-01-01T00:00:00Z",
          windowEnd: "2020-01-02T00:00:00Z",
        })
      ).body.code,
    ).toBe("BAD_WINDOW");
    expect((await api(w).post("/waitlist", { ...body, customerId: randomUUID() })).status).toBe(
      404,
    );
    expect((await api(w).post("/waitlist", { nope: 1 })).status).toBe(400);
    expect((await api(w).get("/waitlist")).body).toHaveLength(1);
  });
});

describe("waitlist: offers", () => {
  it("a cancellation is offered to the first person in line, not the second", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A);
    const b = await join(w, B);
    await cancelBooking(w, x);
    const out = await wl.release(w.tenant, x);
    expect(out.offers).toHaveLength(1);
    const offers = await openOffers(w);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.entry_id).toBe(a);
    expect([await entryStatus(a), await entryStatus(b)]).toEqual(["offered", "waiting"]);
    const hold = (await api(w).get(`/bookings/${offers[0]!.booking_id}`)).body;
    expect(hold.status).toBe("held");
    expect(hold.startAt).toBe(at("09:00"));
    expect(Date.parse(hold.holdExpiresAt) - Date.now()).toBeGreaterThan(9 * 60_000); // 10 minute offer hold
    expect((await sql("SELECT source FROM bookings WHERE id=$1", [hold.id]))[0]!.source).toBe(
      "waitlist",
    );
    expect(
      await sql("SELECT 1 FROM outbox_events WHERE tenant_id=$1 AND type='waitlist.offered'", [
        w.tenant,
      ]),
    ).toHaveLength(1);
  });

  it("many parallel releases of the same slot create exactly one open offer", async () => {
    const w = await world();
    const x = await book(w, X);
    await join(w, A);
    await join(w, B);
    await cancelBooking(w, x);
    await Promise.all(Array.from({ length: 12 }, () => wl.release(w.tenant, x)));
    expect(await openOffers(w)).toHaveLength(1);
    expect(
      await sql("SELECT 1 FROM bookings WHERE tenant_id=$1 AND status='held'", [w.tenant]),
    ).toHaveLength(1);
  });

  it("accepting confirms the booking, books the entry, and is idempotent", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A);
    await cancelBooking(w, x);
    await wl.release(w.tenant, x);
    const offer = (await openOffers(w))[0]!;
    const r = await api(w).post(`/waitlist/offers/${offer.id}/accept`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("accepted");
    expect(r.body.booking.status).toBe("confirmed");
    expect(await entryStatus(a)).toBe("booked");
    expect((await api(w).post(`/waitlist/offers/${offer.id}/accept`)).status).toBe(200);
    expect(
      await sql("SELECT 1 FROM booking_resources WHERE booking_id=$1 AND status='confirmed'", [
        offer.booking_id,
      ]),
    ).toHaveLength(1);
  });

  it("declining frees the hold and offers the slot to the next person, never back to the decliner", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A);
    const b = await join(w, B);
    await cancelBooking(w, x);
    await wl.release(w.tenant, x);
    const first = (await openOffers(w))[0]!;
    const r = await api(w).post(`/waitlist/offers/${first.id}/decline`);
    expect(r.body.status).toBe("declined");
    expect((await api(w).get(`/bookings/${first.booking_id}`)).body.status).toBe("cancelled");
    const now = await openOffers(w);
    expect(now).toHaveLength(1);
    expect(now[0]!.entry_id).toBe(b);
    expect([await entryStatus(a), await entryStatus(b)]).toEqual(["waiting", "offered"]);
  });

  it("an offer that expires goes to the next person", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A);
    const b = await join(w, B);
    await cancelBooking(w, x);
    await wl.release(w.tenant, x);
    const first = (await openOffers(w))[0]!;
    await sql("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [
      first.booking_id,
    ]);
    await app.get(BookingService).sweepTenant(w.tenant); // what the worker's sweeper does
    const out = await wl.release(w.tenant, first.booking_id); // what its booking.expired handler calls
    expect(out.offers).toHaveLength(1);
    expect(
      (await sql("SELECT status FROM waitlist_offers WHERE id=$1", [first.id]))[0]!.status,
    ).toBe("expired");
    expect((await openOffers(w))[0]!.entry_id).toBe(b);
    expect(await entryStatus(a)).toBe("waiting");
  });

  it("accepting after the hold lapsed is refused and the slot moves on", async () => {
    const w = await world();
    const x = await book(w, X);
    await join(w, A);
    const b = await join(w, B);
    await cancelBooking(w, x);
    await wl.release(w.tenant, x);
    const first = (await openOffers(w))[0]!;
    await sql("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [
      first.booking_id,
    ]);
    const r = await api(w).post(`/waitlist/offers/${first.id}/accept`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("OFFER_EXPIRED");
    expect((await openOffers(w))[0]!.entry_id).toBe(b);
  });

  it("an abandoned ordinary hold also frees the slot for the waitlist", async () => {
    const w = await world();
    const h = await api(w).post("/bookings/holds", {
      branchId: w.branch,
      serviceId: w.svc,
      customerId: w.customers[X],
      startAt: at("09:00"),
    });
    const a = await join(w, A);
    await sql("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [
      h.body.id,
    ]);
    await app.get(BookingService).sweepTenant(w.tenant);
    expect((await wl.release(w.tenant, h.body.id)).offers).toHaveLength(1);
    expect((await openOffers(w))[0]!.entry_id).toBe(a);
  });

  it("nothing is offered when the slot was taken meanwhile or lies outside the window", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A); // 09:00-10:00
    const late = await join(w, B, "10:30", "11:30");
    await cancelBooking(w, x);
    await book(w, Y); // someone books the freed slot directly
    expect((await wl.release(w.tenant, x)).offers).toHaveLength(0);
    expect([await entryStatus(a), await entryStatus(late)]).toEqual(["waiting", "waiting"]);
  });

  it("a rescheduled booking offers its OLD time", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A);
    const mv = await request(app.getHttpServer())
      .patch(`/bookings/${x}/reschedule`)
      .set("x-tenant-id", w.tenant)
      .set("Cache-Control", "no-cache")
      .send({ startAt: at("11:00") });
    expect(mv.status).toBe(200);
    const out = await wl.release(w.tenant, x, {
      startAt: new Date(at("09:00")),
      endAt: new Date(at("09:30")),
    });
    expect(out.offers).toHaveLength(1);
    expect((await openOffers(w))[0]!.entry_id).toBe(a);
  });

  it("leaving the queue while holding an offer frees it for the next person", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A);
    const b = await join(w, B);
    await cancelBooking(w, x);
    await wl.release(w.tenant, x);
    const r = await api(w).del(`/waitlist/${a}`);
    expect(r.body.status).toBe("cancelled");
    expect((await openOffers(w))[0]!.entry_id).toBe(b);
  });

  it("is tenant isolated", async () => {
    const a = await world();
    const b = await world();
    const x = await book(a, X);
    const e = await join(a, A);
    await cancelBooking(a, x);
    await wl.release(a.tenant, x);
    const offer = (await openOffers(a))[0]!;
    expect((await api(b).get(`/waitlist/offers/${offer.id}`)).status).toBe(404);
    expect((await api(b).del(`/waitlist/${e}`)).status).toBe(404);
  });
});

describe("waitlist: internal endpoint", () => {
  it("requires the shared key", async () => {
    const w = await world();
    const x = await book(w, X);
    const a = await join(w, A);
    await cancelBooking(w, x);
    const call = (key?: string) => {
      const r = request(app.getHttpServer())
        .post("/internal/waitlist/release")
        .set("x-tenant-id", w.tenant);
      if (key) r.set("x-internal-key", key);
      return r.send({ bookingId: x });
    };
    expect((await call()).status).toBe(403);
    expect((await call("wrong-key-value!")).status).toBe(403);
    const ok = await call("test-internal-key");
    expect(ok.status).toBe(200);
    expect(ok.body.offers).toHaveLength(1);
    expect((await openOffers(w))[0]!.entry_id).toBe(a);
  });
});
