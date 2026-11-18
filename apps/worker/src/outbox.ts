import type { Pool, PoolClient } from "pg";
import { backoffSeconds, type SqsQueue } from "./queue";
import { noticeRescheduled, syncBookingNotifications } from "./reminders";

export interface OutboxRow {
  seq: string;
  tenant_id: string;
  type: string;
  payload: Record<string, unknown>;
}
export type Handler = (c: PoolClient, e: OutboxRow) => Promise<void>;

/** event type -> handler. Handlers must be idempotent: SQS delivers at least once. */
export const handlers: Record<string, Handler> = {
  "booking.held": async () => undefined,
  "booking.confirmed": bookingChanged,
  "booking.cancelled": bookingChanged,
  "booking.expired": bookingChanged,
  "booking.no_show": bookingChanged,
  "booking.checked_in": bookingChanged,
  "booking.completed": bookingChanged,
  "booking.rescheduled": async (c, e) => {
    await bookingChanged(c, e);
    await noticeRescheduled(c, e.tenant_id, String(e.payload.bookingId));
  },
  "slot.released": async () => undefined, // waitlist offers arrive in M5
};

async function bookingChanged(c: PoolClient, e: OutboxRow) {
  await syncBookingNotifications(c, e.tenant_id, String(e.payload.bookingId));
}

/**
 * Outbox relay: moves committed outbox rows onto the events queue. The send happens before the commit
 * that marks the rows dispatched, so a crash can only duplicate a message (consumers are idempotent),
 * never lose one. SKIP LOCKED lets several relays run side by side.
 */
export async function relayOutbox(pool: Pool, events: SqsQueue, batch = 100): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query<OutboxRow>(
      `SELECT seq::text, tenant_id::text, type, payload FROM outbox_events
        WHERE dispatched_at IS NULL AND dead_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    if (rows.length) {
      await events.sendBatch(rows.map((r) => ({ body: JSON.stringify(r) })));
      await c.query(
        "UPDATE outbox_events SET dispatched_at = now() WHERE seq = ANY($1::bigint[])",
        [rows.map((r) => r.seq)],
      );
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

export interface ConsumeOptions {
  handlers?: Record<string, Handler>;
  backoffBaseMs?: number;
  wait?: number;
}

/**
 * Consumes events: runs the handler in a transaction, then deletes the message. A failure leaves the
 * message on the queue with a growing delay; after maxReceiveCount deliveries SQS moves it to the DLQ.
 */
export async function consumeEvents(
  pool: Pool,
  events: SqsQueue,
  o: ConsumeOptions = {},
): Promise<{ done: number; failed: number }> {
  const { handlers: h = handlers, backoffBaseMs = 5000, wait = 1 } = o;
  let done = 0;
  let failed = 0;
  for (const m of await events.receive(10, wait)) {
    try {
      const e = JSON.parse(m.body) as OutboxRow;
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await (h[e.type] ?? (async () => undefined))(c, e);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
      await events.delete(m);
      done++;
    } catch {
      await events.delay(m, backoffSeconds(m.receiveCount, backoffBaseMs)).catch(() => undefined);
      failed++;
    }
  }
  return { done, failed };
}
