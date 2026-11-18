import type { Pool, PoolClient } from "pg";
import { noticeRescheduled, syncBookingNotifications } from "./reminders";

export interface OutboxRow {
  seq: string;
  tenant_id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}
export type Handler = (c: PoolClient, e: OutboxRow) => Promise<void>;

/** event type -> handler. Handlers must be idempotent: delivery is at-least-once. */
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

export interface DispatchOptions {
  batch?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  handlers?: Record<string, Handler>;
}

/**
 * Claims a batch of pending events (FOR UPDATE SKIP LOCKED: any number of workers can run), runs each
 * handler inside a savepoint, and marks it dispatched. A failing event is retried with backoff and
 * parked (dead_at) after maxAttempts, without blocking the events behind it. If the worker dies, the
 * transaction rolls back and the batch is simply claimed again.
 */
export async function dispatchOutbox(
  pool: Pool,
  o: DispatchOptions = {},
): Promise<{ done: number; failed: number }> {
  const { batch = 50, maxAttempts = 5, backoffBaseMs = 5000, handlers: h = handlers } = o;
  const c = await pool.connect();
  let done = 0;
  let failed = 0;
  try {
    await c.query("BEGIN");
    const { rows } = await c.query<OutboxRow>(
      `SELECT seq::text, tenant_id::text, type, payload, attempts FROM outbox_events
        WHERE dispatched_at IS NULL AND dead_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const e of rows) {
      await c.query("SAVEPOINT ev");
      try {
        await (h[e.type] ?? (async () => undefined))(c, e);
        await c.query("RELEASE SAVEPOINT ev");
        await c.query(
          "UPDATE outbox_events SET dispatched_at = now(), last_error = NULL WHERE seq = $1",
          [e.seq],
        );
        done++;
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT ev");
        const attempts = e.attempts + 1;
        const dead = attempts >= maxAttempts;
        await c.query(
          `UPDATE outbox_events SET attempts = $2, last_error = $3,
                  next_attempt_at = now() + ($4::int * interval '1 millisecond'),
                  dead_at = CASE WHEN $5 THEN now() END WHERE seq = $1`,
          [
            e.seq,
            attempts,
            String((err as Error).message).slice(0, 500),
            backoffBaseMs * 2 ** (attempts - 1),
            dead,
          ],
        );
        failed++;
      }
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return { done, failed };
}
