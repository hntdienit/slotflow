import type { PoolClient } from "pg";

const H = 3_600_000;
export const REMINDERS = [
  { type: "reminder_24h", beforeMs: 24 * H },
  { type: "reminder_2h", beforeMs: 2 * H },
] as const;

interface BookingCtx {
  id: string;
  status: string;
  start_at: Date;
  email: string | null;
  phone: string | null;
}

/**
 * Brings the booking's notifications in line with the booking's CURRENT state (not with the event that
 * triggered this call), so handling events late, twice or out of order converges to the same result.
 *  - confirmed: confirmation now + reminders 24h / 2h before start, on each channel the customer has;
 *    a changed start time moves existing reminders (and re-arms ones already sent).
 *  - anything else: unsent notifications are cancelled; a cancelled booking that was confirmed gets one notice.
 */
export async function syncBookingNotifications(c: PoolClient, tenantId: string, bookingId: string) {
  const { rows } = await c.query<BookingCtx>(
    `SELECT b.id::text, b.status, b.start_at, cu.email, cu.phone
       FROM bookings b JOIN customers cu ON cu.id = b.customer_id AND cu.tenant_id = b.tenant_id
      WHERE b.id = $1 AND b.tenant_id = $2 FOR SHARE OF b`,
    [bookingId, tenantId],
  );
  const b = rows[0];
  if (!b) return;
  const channels = [
    ...(b.email ? [{ name: "email", to: b.email }] : []),
    ...(b.phone ? [{ name: "sms", to: b.phone }] : []),
  ];
  const now = Date.now();

  if (b.status === "confirmed") {
    for (const ch of channels) {
      await upsert(c, tenantId, b.id, "confirmation", ch.name, ch.to, new Date(now), false);
      for (const r of REMINDERS) {
        const at = b.start_at.getTime() - r.beforeMs;
        await upsert(c, tenantId, b.id, r.type, ch.name, ch.to, new Date(at), true, at <= now);
      }
    }
    return;
  }

  await c.query(
    `UPDATE notifications SET status = 'cancelled', locked_until = NULL
      WHERE tenant_id = $1 AND booking_id = $2 AND status IN ('pending','failed')
        AND type NOT IN ('booking_cancelled','booking_rescheduled')`,
    [tenantId, bookingId],
  );
  if (b.status === "cancelled") {
    const confirmed = await c.query(
      `SELECT 1 FROM notifications WHERE tenant_id = $1 AND booking_id = $2 AND type = 'confirmation' LIMIT 1`,
      [tenantId, bookingId],
    );
    if (confirmed.rowCount)
      for (const ch of channels)
        await insertIfMissing(
          c,
          tenantId,
          b.id,
          "booking_cancelled",
          ch.name,
          ch.to,
          new Date(now),
          `booking:${b.id}:cancelled:${ch.name}`,
        );
  }
}

/** Tells the customer the booking moved; keyed by the new start so each move is announced once. */
export async function noticeRescheduled(c: PoolClient, tenantId: string, bookingId: string) {
  const { rows } = await c.query<BookingCtx>(
    `SELECT b.id::text, b.status, b.start_at, cu.email, cu.phone
       FROM bookings b JOIN customers cu ON cu.id = b.customer_id AND cu.tenant_id = b.tenant_id
      WHERE b.id = $1 AND b.tenant_id = $2`,
    [bookingId, tenantId],
  );
  const b = rows[0];
  if (!b || b.status !== "confirmed") return;
  for (const [name, to] of [
    ["email", b.email],
    ["sms", b.phone],
  ] as const)
    if (to)
      await insertIfMissing(
        c,
        tenantId,
        b.id,
        "booking_rescheduled",
        name,
        to,
        new Date(),
        `booking:${b.id}:rescheduled:${b.start_at.getTime()}:${name}`,
      );
}

async function insertIfMissing(
  c: PoolClient,
  tenantId: string,
  bookingId: string,
  type: string,
  channel: string,
  to: string,
  at: Date,
  key: string,
) {
  await c.query(
    `INSERT INTO notifications (tenant_id, booking_id, type, channel, dedupe_key, payload, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [tenantId, bookingId, type, channel, key, JSON.stringify({ to }), at],
  );
}

async function upsert(
  c: PoolClient,
  tenantId: string,
  bookingId: string,
  type: string,
  channel: string,
  to: string,
  at: Date,
  movable: boolean,
  past = false,
) {
  const key = `booking:${bookingId}:${type}:${channel}`;
  const ex = await c.query<{ id: string; status: string; scheduled_for: Date }>(
    `SELECT id::text, status, scheduled_for FROM notifications WHERE tenant_id = $1 AND dedupe_key = $2 FOR UPDATE`,
    [tenantId, key],
  );
  const row = ex.rows[0];
  if (!row) {
    if (!past) await insertIfMissing(c, tenantId, bookingId, type, channel, to, at, key);
    return;
  }
  if (!movable || row.scheduled_for?.getTime() === at.getTime()) return;
  // The start time moved: re-arm (or drop it if the new reminder time already passed).
  await c.query(
    `UPDATE notifications SET scheduled_for = $2, status = $3, attempts = 0, last_error = NULL, sent_at = NULL,
            next_attempt_at = NULL, locked_until = NULL, payload = $4 WHERE id = $1::uuid`,
    [row.id, at, past ? "cancelled" : "pending", JSON.stringify({ to })],
  );
}
