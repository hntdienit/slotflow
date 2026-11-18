import type { Pool } from "pg";
import type { NotificationChannel } from "./channels";
import { renderMessage } from "./templates";

interface Claimed {
  id: string;
  tenant_id: string;
  booking_id: string | null;
  type: string;
  channel: string;
  attempts: number;
  payload: { to?: string };
}

export interface DeliveryOptions {
  maxAttempts?: number;
  backoffBaseMs?: number;
  batch?: number;
  leaseSeconds?: number;
}

/**
 * Sends due notifications. A row is claimed by setting a lease (`locked_until`) rather than holding a
 * transaction open during network I/O: a crashed worker's lease just expires and the row is retried.
 * Delivery is therefore at-least-once; the stable Message-ID / unique SMS row make a re-send harmless.
 * Failures back off exponentially and end as `dead` (the dead-letter set) after maxAttempts.
 */
export async function deliverDue(
  pool: Pool,
  channels: NotificationChannel[],
  o: DeliveryOptions = {},
) {
  const { maxAttempts = 5, backoffBaseMs = 5000, batch = 20, leaseSeconds = 60 } = o;
  const byName = new Map(channels.map((c) => [c.name, c]));
  const { rows } = await pool.query<Claimed>(
    `UPDATE notifications SET locked_until = now() + ($2::int * interval '1 second')
      WHERE id IN (
        SELECT id FROM notifications
         WHERE status IN ('pending','failed') AND scheduled_for <= now()
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY scheduled_for LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id::text, tenant_id::text, booking_id::text, type, channel, attempts, payload`,
    [batch, leaseSeconds],
  );
  const stats = { sent: 0, retried: 0, dead: 0, skipped: 0 };
  for (const n of rows) {
    try {
      const ctx = await load(pool, n);
      // The booking may have changed since the notification was scheduled.
      if (
        !ctx ||
        (n.type !== "booking_cancelled" &&
          ctx.status !== "confirmed" &&
          n.type !== "booking_rescheduled") ||
        (n.type.startsWith("reminder") && ctx.start_at.getTime() <= Date.now())
      ) {
        await finish(pool, n.id, "cancelled");
        stats.skipped++;
        continue;
      }
      const channel = byName.get(n.channel as "email" | "sms");
      if (!channel) throw new Error(`no channel adapter for ${n.channel}`);
      const to = n.payload.to ?? (n.channel === "email" ? ctx.email : ctx.phone);
      if (!to) throw new Error("customer has no address for this channel");
      const msg = renderMessage(n.type, ctx);
      await channel.send({
        notificationId: n.id,
        tenantId: n.tenant_id,
        to,
        subject: msg.subject,
        body: msg.body,
      });
      await finish(pool, n.id, "sent");
      stats.sent++;
    } catch (err) {
      const attempts = n.attempts + 1;
      const dead = attempts >= maxAttempts;
      await pool.query(
        `UPDATE notifications SET status = $2, attempts = $3, last_error = $4, locked_until = NULL,
                next_attempt_at = now() + ($5::int * interval '1 millisecond')
          WHERE id = $1::uuid AND status IN ('pending','failed')`,
        [
          n.id,
          dead ? "dead" : "failed",
          attempts,
          String((err as Error).message).slice(0, 500),
          backoffBaseMs * 2 ** (attempts - 1),
        ],
      );
      if (dead) stats.dead++;
      else stats.retried++;
    }
  }
  return stats;
}

async function finish(pool: Pool, id: string, status: "sent" | "cancelled") {
  // Guarded so a notification cancelled while it was being sent is not flipped back.
  await pool.query(
    `UPDATE notifications SET status = $2, attempts = attempts + $3, last_error = NULL, locked_until = NULL,
            sent_at = CASE WHEN $2 = 'sent' THEN now() END
      WHERE id = $1::uuid AND status IN ('pending','failed')`,
    [id, status, status === "sent" ? 1 : 0],
  );
}

export interface MessageContext {
  status: string;
  start_at: Date;
  timezone: string;
  service_name: string;
  branch_name: string;
  customer_name: string;
  email: string | null;
  phone: string | null;
}

async function load(pool: Pool, n: Claimed): Promise<MessageContext | null> {
  if (!n.booking_id) return null;
  const { rows } = await pool.query<MessageContext>(
    `SELECT b.status, b.start_at, br.timezone, s.name AS service_name, br.name AS branch_name,
            cu.full_name AS customer_name, cu.email, cu.phone
       FROM bookings b
       JOIN branches br ON br.id = b.branch_id AND br.tenant_id = b.tenant_id
       JOIN services s ON s.id = b.service_id AND s.tenant_id = b.tenant_id
       JOIN customers cu ON cu.id = b.customer_id AND cu.tenant_id = b.tenant_id
      WHERE b.id = $1 AND b.tenant_id = $2`,
    [n.booking_id, n.tenant_id],
  );
  return rows[0] ?? null;
}
