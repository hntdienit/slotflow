import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationChannel, Outgoing } from "../src/channels";
import { deliverDue } from "../src/delivery";
import { dispatchOutbox, handlers, type Handler } from "../src/outbox";
import { sweepExpiredHolds } from "../src/sweeper";

let admin: pg.Pool; // superuser: arranges data
let pool: pg.Pool; // slotflow_worker: what the worker really connects as
beforeAll(() => {
  admin = new pg.Pool({ connectionString: process.env.TEST_DB_ADMIN_URL, max: 4 });
  pool = new pg.Pool({ connectionString: process.env.TEST_DB_WORKER_URL, max: 8 });
});
// Workers are global (all tenants), so each test starts from an empty queue.
beforeEach(async () => {
  await admin.query("TRUNCATE notifications, sms_messages, outbox_events CASCADE");
  await admin.query("UPDATE bookings SET status='expired' WHERE status='held'");
});
afterAll(async () => {
  await admin.end();
  await pool.end();
});

const H = 3_600_000;
const q = async (sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows;

interface World {
  tenant: string;
  branch: string;
  service: string;
  customer: string;
}
async function world(): Promise<World> {
  const tenant = randomUUID();
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await c.query("INSERT INTO tenants (id, name, slug) VALUES ($1,'t',$2)", [
      tenant,
      `t-${tenant.slice(0, 8)}`,
    ]);
    const branch = (
      await c.query(
        "INSERT INTO branches (name, timezone) VALUES ('Q1','Asia/Ho_Chi_Minh') RETURNING id",
      )
    ).rows[0].id;
    const service = (
      await c.query(
        "INSERT INTO services (name, duration_min) VALUES ('Khám','30'::int) RETURNING id",
      )
    ).rows[0].id;
    const customer = (
      await c.query(
        "INSERT INTO customers (full_name, email, phone) VALUES ('An','an@example.com','+84901234567') RETURNING id",
      )
    ).rows[0].id;
    await c.query("COMMIT");
    return { tenant, branch, service, customer };
  } finally {
    c.release();
  }
}
async function book(
  w: World,
  o: { status?: string; startInH?: number; holdExpiresInMin?: number } = {},
) {
  const start = new Date(Date.now() + (o.startInH ?? 48) * H);
  const id = (
    await q(
      `INSERT INTO bookings (tenant_id, branch_id, customer_id, service_id, status, start_at, end_at, hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        w.tenant,
        w.branch,
        w.customer,
        w.service,
        o.status ?? "confirmed",
        start,
        new Date(start.getTime() + 30 * 60_000),
        o.holdExpiresInMin === undefined
          ? null
          : new Date(Date.now() + o.holdExpiresInMin * 60_000),
      ],
    )
  )[0].id as string;
  return id;
}
const emit = (w: World, type: string, bookingId: string) =>
  q("INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1,$2,$3)", [
    w.tenant,
    type,
    JSON.stringify({ bookingId }),
  ]);
const notes = (w: World, bookingId: string) =>
  q(
    "SELECT type, channel, status, scheduled_for, attempts FROM notifications WHERE tenant_id=$1 AND booking_id=$2 ORDER BY type, channel",
    [w.tenant, bookingId],
  );
const drain = async (n = 5) => {
  for (let i = 0; i < n; i++) if ((await dispatchOutbox(pool)).done === 0) break;
};

class FakeChannel implements NotificationChannel {
  sent: Outgoing[] = [];
  constructor(
    readonly name: "email" | "sms",
    private failTimes = 0,
  ) {}
  async send(m: Outgoing) {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error("smtp down");
    }
    this.sent.push(m);
  }
}

describe("outbox -> notifications", () => {
  it("a confirmed booking schedules a confirmation and 24h/2h reminders per channel, once", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await emit(w, "booking.confirmed", b); // duplicate delivery of the same event
    await drain();
    const n = await notes(w, b);
    expect(n.map((x) => `${x.type}/${x.channel}`)).toEqual([
      "confirmation/email",
      "confirmation/sms",
      "reminder_24h/email",
      "reminder_24h/sms",
      "reminder_2h/email",
      "reminder_2h/sms",
    ]);
    const r24 = n.find((x) => x.type === "reminder_24h")!;
    const start = (await q("SELECT start_at FROM bookings WHERE id=$1", [b]))[0].start_at as Date;
    expect(r24.scheduled_for.getTime()).toBe(start.getTime() - 24 * H);
    expect(
      (
        await q(
          "SELECT count(*)::int n FROM outbox_events WHERE tenant_id=$1 AND dispatched_at IS NULL",
          [w.tenant],
        )
      )[0].n,
    ).toBe(0);
  });

  it("a booking made less than 24h ahead gets no 24h reminder", async () => {
    const w = await world();
    const b = await book(w, { startInH: 5 });
    await emit(w, "booking.confirmed", b);
    await drain();
    expect((await notes(w, b)).map((x) => x.type)).not.toContain("reminder_24h");
    expect((await notes(w, b)).map((x) => x.type)).toContain("reminder_2h");
  });

  it("rescheduling moves the reminders, re-arms a sent one and announces the change once", async () => {
    const w = await world();
    const b = await book(w, { startInH: 48 });
    await emit(w, "booking.confirmed", b);
    await drain();
    await q(
      "UPDATE notifications SET status='sent', sent_at=now() WHERE booking_id=$1 AND type='reminder_24h'",
      [b],
    );
    const newStart = new Date(Date.now() + 96 * H);
    await q("UPDATE bookings SET start_at=$2, end_at=$3 WHERE id=$1", [
      b,
      newStart,
      new Date(newStart.getTime() + 30 * 60_000),
    ]);
    await emit(w, "booking.rescheduled", b);
    await emit(w, "booking.rescheduled", b);
    await drain();
    const n = await notes(w, b);
    for (const x of n.filter((x) => x.type === "reminder_24h")) {
      expect(x.scheduled_for.getTime()).toBe(newStart.getTime() - 24 * H);
      expect(x.status).toBe("pending");
    }
    expect(n.filter((x) => x.type === "booking_rescheduled")).toHaveLength(2); // email + sms, not duplicated
  });

  it("cancelling cancels pending reminders and sends one cancellation notice", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await q("UPDATE notifications SET status='sent' WHERE booking_id=$1 AND type='confirmation'", [
      b,
    ]);
    await q("UPDATE bookings SET status='cancelled' WHERE id=$1", [b]);
    await emit(w, "booking.cancelled", b);
    await drain();
    const n = await notes(w, b);
    expect(
      n.filter((x) => x.type.startsWith("reminder")).every((x) => x.status === "cancelled"),
    ).toBe(true);
    expect(n.filter((x) => x.type === "booking_cancelled")).toHaveLength(2);
    const email = new FakeChannel("email");
    const sms = new FakeChannel("sms");
    await deliverDue(pool, [email, sms]);
    expect(email.sent.map((m) => m.subject)).toEqual(["Lịch hẹn đã được hủy"]);
    expect(sms.sent).toHaveLength(1);
  });

  it("an unconfirmed (held) booking that expires never gets a cancellation email", async () => {
    const w = await world();
    const b = await book(w, { status: "held", holdExpiresInMin: -1 });
    await emit(w, "booking.expired", b);
    await q("UPDATE bookings SET status='expired' WHERE id=$1", [b]);
    await drain();
    expect(await notes(w, b)).toHaveLength(0);
  });
});

describe("delivery, retry and dead letter", () => {
  it("sends due notifications once, leaves future reminders alone", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    const email = new FakeChannel("email");
    const sms = new FakeChannel("sms");
    const first = await deliverDue(pool, [email, sms]);
    expect(first.sent).toBe(2);
    expect(email.sent[0]!.to).toBe("an@example.com");
    expect(email.sent[0]!.body).toContain("Xin chào An"); // Vietnam branch => Vietnamese
    const second = await deliverDue(pool, [email, sms]);
    expect(second.sent).toBe(0);
    expect((await notes(w, b)).filter((x) => x.status === "pending")).toHaveLength(4); // 2 reminders x 2 channels
  });

  it("retries with backoff then succeeds; attempts are counted", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    const email = new FakeChannel("email", 1);
    const sms = new FakeChannel("sms");
    const opts = { backoffBaseMs: 0 };
    expect((await deliverDue(pool, [email, sms], opts)).retried).toBe(1);
    expect(
      (await notes(w, b)).find((x) => x.type === "confirmation" && x.channel === "email")!.status,
    ).toBe("failed");
    expect((await deliverDue(pool, [email, sms], opts)).sent).toBe(1);
    const row = (await notes(w, b)).find(
      (x) => x.type === "confirmation" && x.channel === "email",
    )!;
    expect([row.status, row.attempts]).toEqual(["sent", 2]);
  });

  it("parks a notification as dead after maxAttempts and records the error", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    const email = new FakeChannel("email", 99);
    const sms = new FakeChannel("sms");
    for (let i = 0; i < 4; i++)
      await deliverDue(pool, [email, sms], { maxAttempts: 3, backoffBaseMs: 0 });
    const r = await q(
      "SELECT status, attempts, last_error FROM notifications WHERE booking_id=$1 AND type='confirmation' AND channel='email'",
      [b],
    );
    expect(r[0]).toMatchObject({ status: "dead", attempts: 3, last_error: "smtp down" });
  });

  it("does not send for a booking cancelled after the notification was scheduled", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await q("UPDATE bookings SET status='cancelled' WHERE id=$1", [b]); // cancel event not processed yet
    const email = new FakeChannel("email");
    await deliverDue(pool, [email, new FakeChannel("sms")]);
    expect(email.sent).toHaveLength(0);
    // Due ones are cancelled by the delivery guard; future reminders are cancelled when their event is handled.
    expect(
      (await notes(w, b))
        .filter((x) => x.type === "confirmation")
        .every((x) => x.status === "cancelled"),
    ).toBe(true);
    await q("UPDATE bookings SET updated_at = now() WHERE id=$1", [b]);
    await emit(w, "booking.cancelled", b);
    await drain();
    expect(
      (await notes(w, b))
        .filter((x) => x.type.startsWith("reminder"))
        .every((x) => x.status === "cancelled"),
    ).toBe(true);
  });

  it("a claim from a crashed worker is retried after its lease expires, not before", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await q(
      "UPDATE notifications SET locked_until = now() + interval '1 minute' WHERE booking_id=$1",
      [b],
    ); // another worker holds them
    const email = new FakeChannel("email");
    expect((await deliverDue(pool, [email, new FakeChannel("sms")])).sent).toBe(0);
    await q(
      "UPDATE notifications SET locked_until = now() - interval '1 second' WHERE booking_id=$1",
      [b],
    ); // that worker died
    expect((await deliverDue(pool, [email, new FakeChannel("sms")])).sent).toBe(2);
  });
});

describe("outbox dispatcher", () => {
  it("a failing event is retried then dead-lettered without blocking the ones behind it", async () => {
    const w = await world();
    const good = await book(w);
    const bad = await book(w);
    await emit(w, "booking.confirmed", bad);
    await emit(w, "booking.confirmed", good);
    const flaky: Handler = async (c, e) => {
      if (e.payload.bookingId === bad) throw new Error("boom");
      return handlers["booking.confirmed"]!(c, e);
    };
    for (let i = 0; i < 3; i++)
      await dispatchOutbox(pool, {
        handlers: { "booking.confirmed": flaky },
        maxAttempts: 3,
        backoffBaseMs: 0,
      });
    expect(await notes(w, good)).toHaveLength(6);
    const ev = await q(
      "SELECT attempts, last_error, dead_at, dispatched_at FROM outbox_events WHERE tenant_id=$1 AND payload->>'bookingId'=$2",
      [w.tenant, bad],
    );
    expect(ev[0].attempts).toBe(3);
    expect(ev[0].last_error).toBe("boom");
    expect(ev[0].dead_at).not.toBeNull();
    expect(ev[0].dispatched_at).toBeNull();
    expect(await notes(w, bad)).toHaveLength(0); // the failed handler's writes were rolled back
  });

  it("concurrent dispatchers process every event exactly once", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const b = await book(w);
      ids.push(b);
      await emit(w, "booking.confirmed", b);
    }
    const seen = new Map<string, number>();
    const counting: Handler = async (c, e) => {
      seen.set(String(e.payload.bookingId), (seen.get(String(e.payload.bookingId)) ?? 0) + 1);
      await handlers["booking.confirmed"]!(c, e);
    };
    const run = async () => {
      for (let i = 0; i < 6; i++)
        await dispatchOutbox(pool, { batch: 5, handlers: { "booking.confirmed": counting } });
    };
    await Promise.all([run(), run(), run()]);
    expect(seen.size).toBe(30);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(
      (await q("SELECT count(*)::int n FROM notifications WHERE tenant_id=$1", [w.tenant]))[0].n,
    ).toBe(30 * 6);
  });
});

describe("hold sweeper", () => {
  it("expires stale holds across tenants, records history and an outbox event, spares live holds", async () => {
    const a = await world();
    const b = await world();
    const stale = await book(a, { status: "held", holdExpiresInMin: -5 });
    const staleB = await book(b, { status: "held", holdExpiresInMin: -1 });
    const live = await book(a, { status: "held", holdExpiresInMin: 5 });
    const branches = await sweepExpiredHolds(pool);
    expect(branches.map((x) => x.branchId)).toEqual(expect.arrayContaining([a.branch, b.branch]));
    const st = async (id: string) =>
      (await q("SELECT status FROM bookings WHERE id=$1", [id]))[0].status;
    expect([await st(stale), await st(staleB), await st(live)]).toEqual([
      "expired",
      "expired",
      "held",
    ]);
    expect(
      (await q("SELECT to_status FROM booking_events WHERE booking_id=$1", [stale]))[0].to_status,
    ).toBe("expired");
    expect(
      (
        await q("SELECT type FROM outbox_events WHERE tenant_id=$1 AND payload->>'bookingId'=$2", [
          a.tenant,
          stale,
        ])
      )[0].type,
    ).toBe("booking.expired");
    expect(await sweepExpiredHolds(pool)).toEqual([]); // idempotent
  });
});

describe("worker role", () => {
  it("sees every tenant but cannot change the catalog", async () => {
    const a = await world();
    await world();
    expect(
      (await pool.query("SELECT count(*)::int n FROM tenants")).rows[0].n,
    ).toBeGreaterThanOrEqual(2);
    await expect(
      pool.query("INSERT INTO services (tenant_id, name, duration_min) VALUES ($1,'x',10)", [
        a.tenant,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
