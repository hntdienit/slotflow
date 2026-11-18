import type { PoolClient } from "pg";

export interface ReleaseRequest {
  bookingId: string;
  startAt?: string;
  endAt?: string;
}

/** The worker never matches the waitlist itself: the API owns booking rules, so it is asked to. */
export interface WaitlistClient {
  release(tenantId: string, req: ReleaseRequest): Promise<void>;
}

export class HttpWaitlistClient implements WaitlistClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async release(tenantId: string, req: ReleaseRequest) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/internal/waitlist/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": tenantId,
        "x-internal-key": this.key,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Any non-2xx throws, so the event stays on the queue and is retried (then dead-lettered).
    if (!res.ok) throw new Error(`waitlist release failed: HTTP ${res.status}`);
  }
}

let client: WaitlistClient | null = null;
/** Wires the API client in (main.ts, tests). Without one, freed slots are simply not offered. */
export function configureWaitlist(c: WaitlistClient | null) {
  client = c;
}
export const waitlistClient = () => client;

interface Customer {
  email: string | null;
  phone: string | null;
}

/**
 * `waitlist.offered`: tells the customer a slot is being held for them. One notification per channel,
 * deduplicated per offer, so redelivered events do not send twice. Whether the offer is still worth
 * sending is decided at delivery time (it may have been accepted, declined or lapsed meanwhile).
 */
export async function noticeOffer(
  c: PoolClient,
  tenantId: string,
  p: { offerId: string; bookingId: string; customerId: string; expiresAt: string },
) {
  const { rows } = await c.query<Customer>(
    "SELECT email, phone FROM customers WHERE id = $1 AND tenant_id = $2",
    [p.customerId, tenantId],
  );
  const cu = rows[0];
  if (!cu) return;
  for (const [channel, to] of [
    ["email", cu.email],
    ["sms", cu.phone],
  ] as const)
    if (to)
      await c.query(
        `INSERT INTO notifications (tenant_id, booking_id, type, channel, dedupe_key, payload, scheduled_for)
         VALUES ($1,$2,'waitlist_offer',$3,$4,$5,now()) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
        [
          tenantId,
          p.bookingId,
          channel,
          `waitlist:offer:${p.offerId}:${channel}`,
          JSON.stringify({ to, offerId: p.offerId, expiresAt: p.expiresAt }),
        ],
      );
}
