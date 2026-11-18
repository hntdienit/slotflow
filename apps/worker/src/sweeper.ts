import type { Pool } from "pg";

/**
 * Expires every stale hold across all tenants in one statement: booking, its resource rows, history and
 * an outbox event commit together. The booking transaction also expires holds that block it (ADR-002/005),
 * so this only has to keep the data tidy and tell the cache. Returns the branches whose availability changed.
 */
export async function sweepExpiredHolds(
  pool: Pool,
): Promise<{ tenantId: string; branchId: string }[]> {
  const { rows } = await pool.query<{ tenant_id: string; branch_id: string }>(
    `WITH stale AS (
       UPDATE bookings SET status = 'expired', updated_at = now()
        WHERE status = 'held' AND hold_expires_at <= now()
        RETURNING id, tenant_id, branch_id, service_id, customer_id, start_at, end_at),
     res AS (
       UPDATE booking_resources br SET status = 'expired'
         FROM stale WHERE br.booking_id = stale.id AND br.status = 'held'),
     ev AS (
       INSERT INTO booking_events (tenant_id, booking_id, from_status, to_status, actor, payload)
       SELECT tenant_id, id, 'held', 'expired', 'system', '{}'::jsonb FROM stale),
     ob AS (
       INSERT INTO outbox_events (tenant_id, type, payload)
       SELECT tenant_id, 'booking.expired',
              jsonb_build_object('bookingId', id, 'branchId', branch_id, 'serviceId', service_id,
                                 'customerId', customer_id, 'startAt', start_at, 'endAt', end_at)
         FROM stale)
     SELECT tenant_id::text, branch_id::text FROM stale`,
  );
  const seen = new Set<string>();
  return rows
    .filter(
      (r) =>
        !seen.has(`${r.tenant_id}:${r.branch_id}`) && seen.add(`${r.tenant_id}:${r.branch_id}`),
    )
    .map((r) => ({ tenantId: r.tenant_id, branchId: r.branch_id }));
}
