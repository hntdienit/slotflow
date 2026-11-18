import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SesEmailChannel, type NotificationChannel, type Outgoing } from "../src/channels";
import { awsConfig, sesClient, sqsClient } from "../src/aws";
import { consumeDeadLetters, consumeNotifications, enqueueDue } from "../src/delivery";
import { ensureInfrastructure, type Queues } from "../src/infra";
import { consumeEvents, handlers, relayOutbox, type Handler } from "../src/outbox";
import { sweepExpiredHolds } from "../src/sweeper";

let admin: pg.Pool; // superuser: arranges data
let pool: pg.Pool; // slotflow_worker: what the worker really connects as
let q: Queues;
const aws = awsConfig();
beforeAll(async () => {
  admin = new pg.Pool({ connectionString: process.env.TEST_DB_ADMIN_URL, max: 4 });
  pool = new pg.Pool({ connectionString: process.env.TEST_DB_WORKER_URL, max: 8 });
  // Real SQS/SES on LocalStack, with a private queue set per run; 3 deliveries then dead letter.
  q = await ensureInfrastructure(sqsClient(aws), sesClient(aws), {
    prefix: `t${Date.now().toString(36)}-`,
    maxReceiveCount: 3,
    visibilitySeconds: 2,
    sender: "no-reply@slotflow.local",
  });
});
// Workers are global (all tenants), so each test starts from an empty queue.
beforeEach(async () => {
  await admin.query("TRUNCATE notifications, sms_messages, outbox_events CASCADE");
  await admin.query("UPDATE bookings SET status='expired' WHERE status='held'");
  await purge(q.events, q.eventsDlq, q.notifications, q.notificationsDlq);
});
afterAll(async () => {
  await admin.end();
  await pool.end();
});

const H = 3_600_000;
const q_ = async (sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows;

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
    await q_(
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
  q_("INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1,$2,$3)", [
    w.tenant,
    type,
    JSON.stringify({ bookingId }),
  ]);
const notes = (w: World, bookingId: string) =>
  q_(
    "SELECT type, channel, status, scheduled_for, attempts FROM notifications WHERE tenant_id=$1 AND booking_id=$2 ORDER BY type, channel",
    [w.tenant, bookingId],
  );
/** Relay the outbox to SQS and consume every event until nothing is left. */
const drain = async (h?: Record<string, Handler>) => {
  for (let i = 0; i < 20; i++) {
    const relayed = await relayOutbox(pool, q.events);
    const r = await consumeEvents(pool, q.events, { wait: 0, backoffBaseMs: 0, handlers: h });
    if (relayed === 0 && r.done === 0 && r.failed === 0) break;
  }
};
const purge = async (
  ...qs: {
    receive: (n: number, w: number) => Promise<{ handle: string }[]>;
    delete: (m: never) => Promise<void>;
  }[]
) => {
  for (const x of qs)
    for (let i = 0; i < 5; i++) for (const m of await x.receive(10, 0)) await x.delete(m as never);
};
const deliver = (channels: NotificationChannel[], o: { backoffBaseMs?: number } = {}) =>
  consumeNotifications(pool, q.notifications, channels, { wait: 0, backoffBaseMs: 0, ...o });
const pending = async () => {
  await enqueueDue(pool, q.notifications);
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
    const start = (await q_("SELECT start_at FROM bookings WHERE id=$1", [b]))[0].start_at as Date;
    expect(r24.scheduled_for.getTime()).toBe(start.getTime() - 24 * H);
    expect(
      (
        await q_(
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
    await q_(
      "UPDATE notifications SET status='sent', sent_at=now(), enqueued_at=now() WHERE booking_id=$1 AND type='reminder_24h'",
      [b],
    );
    const newStart = new Date(Date.now() + 96 * H);
    await q_("UPDATE bookings SET start_at=$2, end_at=$3 WHERE id=$1", [
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
    expect(
      (
        await q_(
          "SELECT enqueued_at FROM notifications WHERE booking_id=$1 AND type='reminder_24h'",
          [b],
        )
      ).every((r) => r.enqueued_at === null),
    ).toBe(true);
    expect(n.filter((x) => x.type === "booking_rescheduled")).toHaveLength(2); // email + sms, not duplicated
  });

  it("cancelling cancels pending reminders and sends one cancellation notice", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await q_("UPDATE notifications SET status='sent' WHERE booking_id=$1 AND type='confirmation'", [
      b,
    ]);
    await q_("UPDATE bookings SET status='cancelled' WHERE id=$1", [b]);
    await emit(w, "booking.cancelled", b);
    await drain();
    const n = await notes(w, b);
    expect(
      n.filter((x) => x.type.startsWith("reminder")).every((x) => x.status === "cancelled"),
    ).toBe(true);
    expect(n.filter((x) => x.type === "booking_cancelled")).toHaveLength(2);
    const email = new FakeChannel("email");
    const sms = new FakeChannel("sms");
    await pending();
    await deliver([email, sms]);
    expect(email.sent.map((m) => m.subject)).toEqual(["Lịch hẹn đã được hủy"]);
    expect(sms.sent).toHaveLength(1);
  });

  it("an unconfirmed (held) booking that expires never gets a cancellation email", async () => {
    const w = await world();
    const b = await book(w, { status: "held", holdExpiresInMin: -1 });
    await emit(w, "booking.expired", b);
    await q_("UPDATE bookings SET status='expired' WHERE id=$1", [b]);
    await drain();
    expect(await notes(w, b)).toHaveLength(0);
  });
});

describe("delivery through SQS: delay, retry, dead letter", () => {
  it("sends due notifications once; future reminders are not enqueued", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await pending();
    const email = new FakeChannel("email");
    const sms = new FakeChannel("sms");
    expect((await deliver([email, sms])).sent).toBe(2);
    expect(email.sent[0]!.to).toBe("an@example.com");
    expect(email.sent[0]!.body).toContain("Xin chào An"); // Vietnam branch => Vietnamese
    await pending();
    expect((await deliver([email, sms])).sent).toBe(0);
    expect((await notes(w, b)).filter((x) => x.status === "pending")).toHaveLength(4); // 2 reminders x 2 channels
    expect(
      (
        await q_(
          "SELECT count(*)::int n FROM notifications WHERE booking_id=$1 AND enqueued_at IS NOT NULL",
          [b],
        )
      )[0].n,
    ).toBe(2);
  });

  it("a reminder due in minutes is enqueued once with a delay and is not delivered early", async () => {
    const w = await world();
    const b = await book(w, { startInH: 2 + 5 / 60 }); // 2h reminder is due in ~5 minutes
    await emit(w, "booking.confirmed", b);
    await drain();
    await q_("UPDATE notifications SET status='sent' WHERE booking_id=$1 AND type='confirmation'", [
      b,
    ]);
    expect(await enqueueDue(pool, q.notifications)).toBe(2);
    expect(await enqueueDue(pool, q.notifications)).toBe(0); // once per schedule
    const email = new FakeChannel("email");
    expect((await deliver([email, new FakeChannel("sms")])).sent).toBe(0); // SQS holds it until due
    expect(email.sent).toHaveLength(0);
  });

  it("retries with backoff then succeeds; attempts are counted", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await pending();
    const email = new FakeChannel("email", 1);
    const sms = new FakeChannel("sms");
    expect((await deliver([email, sms])).retried).toBe(1);
    expect(
      (await notes(w, b)).find((x) => x.type === "confirmation" && x.channel === "email")!.status,
    ).toBe("failed");
    expect((await deliver([email, sms])).sent).toBe(1);
    const row = (await notes(w, b)).find(
      (x) => x.type === "confirmation" && x.channel === "email",
    )!;
    expect([row.status, row.attempts]).toEqual(["sent", 2]);
  });

  it("after maxReceiveCount failures SQS dead-letters the message and the row is parked as dead", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await q_("UPDATE notifications SET status='sent' WHERE booking_id=$1 AND channel='sms'", [b]);
    await pending();
    const email = new FakeChannel("email", 99);
    for (let i = 0; i < 8; i++) await deliver([email, new FakeChannel("sms")]);
    let parked = 0;
    for (let i = 0; i < 5 && parked === 0; i++)
      parked = await consumeDeadLetters(pool, q.notificationsDlq, 0);
    expect(parked).toBe(1);
    const r = await q_(
      "SELECT status, attempts, last_error FROM notifications WHERE booking_id=$1 AND type='confirmation' AND channel='email'",
      [b],
    );
    expect(r[0]).toMatchObject({ status: "dead", last_error: "smtp down" });
    expect(r[0].attempts).toBeGreaterThanOrEqual(3);
  });

  it("does not send for a booking cancelled after the notification was scheduled", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await pending();
    await q_("UPDATE bookings SET status='cancelled' WHERE id=$1", [b]); // cancel event not processed yet
    const email = new FakeChannel("email");
    await deliver([email, new FakeChannel("sms")]);
    expect(email.sent).toHaveLength(0);
    expect(
      (await notes(w, b))
        .filter((x) => x.type === "confirmation")
        .every((x) => x.status === "cancelled"),
    ).toBe(true);
  });

  it("drops a stale message when its reminder was moved later", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await pending(); // confirmations are on the queue
    await q_(
      "UPDATE notifications SET scheduled_for = now() + interval '3 hours', enqueued_at = NULL WHERE booking_id=$1 AND type='confirmation'",
      [b],
    );
    const email = new FakeChannel("email");
    const out = await deliver([email, new FakeChannel("sms")]);
    expect(out.skipped).toBe(2);
    expect(email.sent).toHaveLength(0);
    expect(
      (await notes(w, b))
        .filter((x) => x.type === "confirmation")
        .every((x) => x.status === "pending"),
    ).toBe(true);
  });

  it("a message lost from the queue is re-enqueued once it is overdue", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await q_(
      "UPDATE notifications SET enqueued_at = now() - interval '20 minutes', scheduled_for = now() - interval '20 minutes' WHERE booking_id=$1 AND type='confirmation' AND channel='email'",
      [b],
    );
    await q_(
      "UPDATE notifications SET status='sent' WHERE booking_id=$1 AND NOT (type='confirmation' AND channel='email')",
      [b],
    );
    expect(await enqueueDue(pool, q.notifications)).toBe(1);
  });

  it("a worker that dies mid-message: SQS redelivers it after the visibility timeout", async () => {
    const w = await world();
    const b = await book(w);
    await emit(w, "booking.confirmed", b);
    await drain();
    await q_(
      "UPDATE notifications SET status='sent' WHERE booking_id=$1 AND NOT (type='confirmation' AND channel='email')",
      [b],
    );
    await pending();
    const taken = await q.notifications.receive(10, 0); // "crashes" without deleting
    expect(taken).toHaveLength(1);
    const email = new FakeChannel("email");
    expect((await deliver([email, new FakeChannel("sms")])).sent).toBe(0); // still invisible
    await new Promise((r) => setTimeout(r, 2500)); // visibility timeout (2s) passes
    expect((await deliver([email, new FakeChannel("sms")])).sent).toBe(1);
  });

  it("sends real email through SES on LocalStack", async () => {
    const ses = new SesEmailChannel(sesClient(aws), "no-reply@slotflow.local");
    const subject = `Xác nhận ${Date.now()}`;
    await ses.send({
      notificationId: randomUUID(),
      tenantId: randomUUID(),
      to: "an@example.com",
      subject,
      body: "Xin chào",
    });
    const mail = (await (await fetch(`${aws.endpoint}/_aws/ses`)).json()) as {
      messages: { Subject: string; Destination: { ToAddresses: string[] } }[];
    };
    expect(
      mail.messages.some(
        (m) => m.Subject === subject && m.Destination.ToAddresses.includes("an@example.com"),
      ),
    ).toBe(true);
  });
});

describe("events queue", () => {
  it("a poison event is dead-lettered without blocking the ones behind it", async () => {
    const w = await world();
    const good = await book(w);
    const bad = await book(w);
    await emit(w, "booking.confirmed", bad);
    await emit(w, "booking.confirmed", good);
    const flaky: Handler = async (c, e) => {
      if (e.payload.bookingId === bad) throw new Error("boom");
      return handlers["booking.confirmed"]!(c, e);
    };
    for (let i = 0; i < 8; i++) await drain({ "booking.confirmed": flaky });
    expect(await notes(w, good)).toHaveLength(6);
    expect(await notes(w, bad)).toHaveLength(0); // the failed handler's writes were rolled back
    const dead = await q.eventsDlq.receive(10, 0);
    expect(dead.map((m) => JSON.parse(m.body).payload.bookingId)).toEqual([bad]);
  });

  it("concurrent consumers process every event exactly once", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) await emit(w, "booking.confirmed", await book(w));
    const seen = new Map<string, number>();
    const counting: Handler = async (c, e) => {
      seen.set(String(e.payload.bookingId), (seen.get(String(e.payload.bookingId)) ?? 0) + 1);
      await handlers["booking.confirmed"]!(c, e);
    };
    await relayOutbox(pool, q.events);
    const run = async () => {
      for (let i = 0; i < 8; i++)
        await consumeEvents(pool, q.events, {
          wait: 0,
          handlers: { "booking.confirmed": counting },
        });
    };
    await Promise.all([run(), run(), run()]);
    expect(seen.size).toBe(30);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(
      (await q_("SELECT count(*)::int n FROM notifications WHERE tenant_id=$1", [w.tenant]))[0].n,
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
      (await q_("SELECT status FROM bookings WHERE id=$1", [id]))[0].status;
    expect([await st(stale), await st(staleB), await st(live)]).toEqual([
      "expired",
      "expired",
      "held",
    ]);
    expect(
      (await q_("SELECT to_status FROM booking_events WHERE booking_id=$1", [stale]))[0].to_status,
    ).toBe("expired");
    expect(
      (
        await q_("SELECT type FROM outbox_events WHERE tenant_id=$1 AND payload->>'bookingId'=$2", [
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
