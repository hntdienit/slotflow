import type { Pool } from "pg";
import type { NotificationChannel } from "./channels";
import { backoffSeconds, type SqsQueue } from "./queue";
import { renderMessage } from "./templates";

/** SQS can delay a message by at most 15 minutes, so only notifications due within that window are enqueued. */
export const LOOKAHEAD_SECONDS = 900;

/**
 * Puts notifications that are due within the look-ahead window on the queue, with a per-message delay
 * equal to the time left, so SQS releases each one at its scheduled moment. A notification is enqueued
 * once per (re)schedule (`enqueued_at`); moving a reminder clears it so it is enqueued again at the new
 * time. The send happens before the commit, so a crash can duplicate a message but never lose one; a
 * message that vanished anyway is re-enqueued once it is 15 minutes overdue.
 */
export async function enqueueDue(pool: Pool, queue: SqsQueue, batch = 100): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query<{ id: string; tenant_id: string; delay: number }>(
      `SELECT id::text, tenant_id::text, GREATEST(0, EXTRACT(EPOCH FROM (scheduled_for - now())))::float AS delay
         FROM notifications
        WHERE status IN ('pending','failed') AND scheduled_for <= now() + ($2::int * interval '1 second')
          AND (enqueued_at IS NULL OR (enqueued_at < now() - interval '15 minutes' AND scheduled_for < now() - interval '15 minutes'))
        ORDER BY scheduled_for LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch, LOOKAHEAD_SECONDS],
    );
    if (rows.length) {
      await queue.sendBatch(
        rows.map((r) => ({
          body: JSON.stringify({ notificationId: r.id, tenantId: r.tenant_id }),
          delaySeconds: r.delay,
        })),
      );
      await c.query("UPDATE notifications SET enqueued_at = now() WHERE id = ANY($1::uuid[])", [
        rows.map((r) => r.id),
      ]);
    }
    await c.query("COMMIT");
    return rows.length;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

interface Row {
  id: string;
  tenant_id: string;
  booking_id: string | null;
  type: string;
  channel: string;
  status: string;
  attempts: number;
  scheduled_for: Date;
  payload: { to?: string; offerId?: string; expiresAt?: string };
}

export interface DeliveryOptions {
  backoffBaseMs?: number;
  wait?: number;
  /** Messages arriving more than this early are stale (the reminder was moved later) and are dropped. */
  earlyToleranceMs?: number;
}

/**
 * Consumes notification messages: re-checks the notification and its booking against the database,
 * sends through the channel and records the outcome. Success or "no longer needed" deletes the message.
 * A send failure records the error and leaves the message to reappear after an exponential delay; once
 * SQS has delivered it maxReceiveCount times it goes to the DLQ, where `consumeDeadLetters` parks the row.
 */
export async function consumeNotifications(
  pool: Pool,
  queue: SqsQueue,
  channels: NotificationChannel[],
  o: DeliveryOptions = {},
) {
  const { backoffBaseMs = 5000, wait = 1, earlyToleranceMs = 30_000 } = o;
  const byName = new Map(channels.map((c) => [c.name, c]));
  const stats = { sent: 0, retried: 0, skipped: 0 };
  for (const m of await queue.receive(10, wait)) {
    let notificationId = "";
    try {
      const msg = JSON.parse(m.body) as { notificationId: string; tenantId: string };
      notificationId = msg.notificationId;
      const n = (
        await pool.query<Row>(
          `SELECT id::text, tenant_id::text, booking_id::text, type, channel, status, attempts, scheduled_for, payload
             FROM notifications WHERE id = $1 AND tenant_id = $2`,
          [msg.notificationId, msg.tenantId],
        )
      ).rows[0];
      // Already handled, cancelled, or this message belongs to an earlier schedule: nothing to do.
      if (
        !n ||
        !["pending", "failed"].includes(n.status) ||
        n.scheduled_for.getTime() > Date.now() + earlyToleranceMs
      ) {
        await queue.delete(m);
        stats.skipped++;
        continue;
      }
      const ctx = await load(pool, n);
      if (!ctx || !(await stillWanted(pool, n, ctx))) {
        await setStatus(pool, n.id, "cancelled");
        await queue.delete(m);
        stats.skipped++;
        continue;
      }
      const channel = byName.get(n.channel as "email" | "sms");
      if (!channel) throw new Error(`no channel adapter for ${n.channel}`);
      const to = n.payload.to ?? (n.channel === "email" ? ctx.email : ctx.phone);
      if (!to) throw new Error("customer has no address for this channel");
      const text = renderMessage(n.type, ctx, n.payload);
      await channel.send({
        notificationId: n.id,
        tenantId: n.tenant_id,
        to,
        subject: text.subject,
        body: text.body,
      });
      await setStatus(pool, n.id, "sent", 1);
      await queue.delete(m);
      stats.sent++;
    } catch (err) {
      if (notificationId)
        await pool
          .query(
            `UPDATE notifications SET status = 'failed', attempts = $2, last_error = $3, next_attempt_at = now() + ($4::int * interval '1 second')
              WHERE id = $1::uuid AND status IN ('pending','failed')`,
            [
              notificationId,
              m.receiveCount,
              String((err as Error).message).slice(0, 500),
              backoffSeconds(m.receiveCount, backoffBaseMs),
            ],
          )
          .catch(() => undefined);
      await queue.delay(m, backoffSeconds(m.receiveCount, backoffBaseMs)).catch(() => undefined);
      stats.retried++;
    }
  }
  return stats;
}

/** Parks notifications whose messages SQS gave up on (the dead-letter queue) as `dead`. */
export async function consumeDeadLetters(pool: Pool, dlq: SqsQueue, wait = 1): Promise<number> {
  let n = 0;
  for (const m of await dlq.receive(10, wait)) {
    try {
      const msg = JSON.parse(m.body) as { notificationId?: string };
      if (msg.notificationId)
        await pool.query(
          `UPDATE notifications SET status = 'dead', locked_until = NULL, last_error = COALESCE(last_error, 'moved to dead-letter queue') WHERE id = $1::uuid AND status IN ('pending','failed')`,
          [msg.notificationId],
        );
      await dlq.delete(m);
      n++;
    } catch {
      /* leave it; it will be seen again */
    }
  }
  return n;
}

/** Is this notification still true? Re-checked against the database right before sending. */
async function stillWanted(pool: Pool, n: Row, ctx: MessageContext): Promise<boolean> {
  if (n.type === "booking_cancelled" || n.type === "booking_rescheduled") return true;
  if (n.type === "waitlist_offer") {
    // Only while the hold exists and the offer is open and unexpired.
    if (ctx.status !== "held" || !n.payload.offerId) return false;
    const { rowCount } = await pool.query(
      "SELECT 1 FROM waitlist_offers WHERE id = $1 AND tenant_id = $2 AND status = 'open' AND expires_at > now()",
      [n.payload.offerId, n.tenant_id],
    );
    return !!rowCount;
  }
  if (ctx.status !== "confirmed") return false;
  return !(n.type.startsWith("reminder") && ctx.start_at.getTime() <= Date.now());
}

async function setStatus(pool: Pool, id: string, status: "sent" | "cancelled", attemptInc = 0) {
  // Guarded so a notification cancelled while it was being sent is not flipped back.
  await pool.query(
    `UPDATE notifications SET status = $2, attempts = attempts + $3, last_error = NULL,
            sent_at = CASE WHEN $2 = 'sent' THEN now() END
      WHERE id = $1::uuid AND status IN ('pending','failed')`,
    [id, status, attemptInc],
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

async function load(pool: Pool, n: Row): Promise<MessageContext | null> {
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
