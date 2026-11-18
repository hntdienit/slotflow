import { Injectable } from "@nestjs/common";
import { localDate } from "@slotflow/core";
import { AvailabilityService } from "../availability/availability.service";
import { ApiError, notFound } from "../booking/api-error";
import { BookingService } from "../booking/booking.service";
import { DbService, Tx } from "../db/db.service";
import { pgCode, prismaCode } from "../db/pg-error";

export const WAITLIST_HOLD_MINUTES = Number(process.env.WAITLIST_HOLD_MINUTES ?? 10);
const MAX_ENTRIES_PER_RELEASE = 25;
const MAX_SLOTS_PER_ENTRY = 3;
const MAX_WINDOW_DAYS = 31;

export interface RegisterInput {
  branchId: string;
  serviceId: string;
  customerId: string;
  staffId?: string;
  windowStart: Date;
  windowEnd: Date;
}

const isUnique = (e: unknown) => prismaCode(e) === "P2002" || pgCode(e) === "23505";

@Injectable()
export class WaitlistService {
  constructor(
    private readonly db: DbService,
    private readonly bookings: BookingService,
    private readonly availability: AvailabilityService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Customers
  // ---------------------------------------------------------------------------------------------

  /** Joins the queue. The same customer asking twice for the same thing keeps their original place. */
  async register(tenantId: string, i: RegisterInput) {
    if (i.windowEnd <= i.windowStart)
      throw new ApiError(422, "BAD_WINDOW", "windowEnd must be after windowStart");
    if (i.windowEnd.getTime() <= Date.now())
      throw new ApiError(422, "BAD_WINDOW", "the window is already over");
    if (i.windowEnd.getTime() - i.windowStart.getTime() > MAX_WINDOW_DAYS * 86_400_000)
      throw new ApiError(422, "BAD_WINDOW", `the window is limited to ${MAX_WINDOW_DAYS} days`);
    return this.db.withTenant(tenantId, async (tx) => {
      const [branch, service, customer] = await Promise.all([
        tx.branch.findUnique({ where: { id: i.branchId } }),
        tx.service.findUnique({ where: { id: i.serviceId } }),
        tx.customer.findUnique({ where: { id: i.customerId } }),
      ]);
      if (!branch) throw notFound("branch");
      if (!service) throw notFound("service");
      if (!customer) throw notFound("customer");
      const same = await tx.waitlistEntry.findFirst({
        where: {
          branchId: i.branchId,
          serviceId: i.serviceId,
          customerId: i.customerId,
          staffId: i.staffId ?? null,
          windowStart: i.windowStart,
          windowEnd: i.windowEnd,
          status: { in: ["waiting", "offered"] },
        },
      });
      if (same) return { entry: toEntry(same), created: false };
      const row = await tx.waitlistEntry.create({
        data: {
          branchId: i.branchId,
          serviceId: i.serviceId,
          customerId: i.customerId,
          staffId: i.staffId ?? null,
          windowStart: i.windowStart,
          windowEnd: i.windowEnd,
        },
      });
      return { entry: toEntry(row), created: true };
    });
  }

  async list(
    tenantId: string,
    f: { branchId?: string; customerId?: string; status?: string; limit: number },
  ) {
    return this.db.withTenant(tenantId, async (tx) =>
      (
        await tx.waitlistEntry.findMany({
          where: { branchId: f.branchId, customerId: f.customerId, status: f.status },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: f.limit,
        })
      ).map(toEntry),
    );
  }

  /** Leaves the queue; an open offer is declined first so its hold is freed for the next person. */
  async cancelEntry(tenantId: string, entryId: string) {
    const open = await this.db.withTenant(tenantId, async (tx) => {
      const e = await tx.waitlistEntry.findUnique({ where: { id: entryId } });
      if (!e) throw notFound("waitlist entry");
      return tx.waitlistOffer.findFirst({ where: { entryId, status: "open" } });
    });
    if (open) await this.decline(tenantId, open.id);
    return this.db.withTenant(tenantId, async (tx) => {
      await tx.waitlistEntry.updateMany({
        where: { id: entryId, status: { in: ["waiting", "offered"] } },
        data: { status: "cancelled" },
      });
      return toEntry(await tx.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } }));
    });
  }

  async getOffer(tenantId: string, offerId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const o = await tx.waitlistOffer.findUnique({ where: { id: offerId } });
      if (!o) throw notFound("offer");
      const b = await tx.booking.findUniqueOrThrow({ where: { id: o.bookingId } });
      return toOffer(o, b);
    });
  }

  /**
   * Accepts an offer: confirms the hold, then marks the offer accepted and the entry booked. Each step is
   * idempotent (confirming a confirmed booking is a no-op), so retrying after a crash finishes the job.
   */
  async accept(tenantId: string, offerId: string, actor = "customer") {
    const o = await this.db.withTenant(tenantId, async (tx) => {
      const x = await tx.waitlistOffer.findUnique({ where: { id: offerId } });
      if (!x) throw notFound("offer");
      return x;
    });
    if (o.status === "declined" || o.status === "expired")
      throw new ApiError(409, "OFFER_CLOSED", `This offer was ${o.status}`);
    try {
      await this.bookings.confirm(tenantId, o.bookingId, actor);
    } catch (e) {
      if (e instanceof ApiError && e.code === "HOLD_EXPIRED") {
        await this.closeOffer(tenantId, o.bookingId, "expired");
        await this.release(tenantId, o.bookingId); // offer the slot on
        throw new ApiError(409, "OFFER_EXPIRED", "The offer expired before it was accepted");
      }
      throw e;
    }
    return this.db.withTenant(tenantId, async (tx) => {
      await tx.waitlistOffer.updateMany({
        where: { id: offerId, status: "open" },
        data: { status: "accepted" },
      });
      await tx.waitlistEntry.updateMany({
        where: { id: o.entryId, status: "offered" },
        data: { status: "booked" },
      });
      const fresh = await tx.waitlistOffer.findUniqueOrThrow({ where: { id: offerId } });
      return toOffer(fresh, await tx.booking.findUniqueOrThrow({ where: { id: o.bookingId } }));
    });
  }

  /** Declines an offer: frees the hold (no fee, it was never confirmed) and offers the slot on. */
  async decline(tenantId: string, offerId: string, actor = "customer") {
    const o = await this.db.withTenant(tenantId, async (tx) => {
      const x = await tx.waitlistOffer.findUnique({ where: { id: offerId } });
      if (!x) throw notFound("offer");
      return x;
    });
    if (o.status === "accepted")
      throw new ApiError(409, "OFFER_CLOSED", "This offer was already accepted");
    if (o.status === "open") {
      await this.closeOffer(tenantId, o.bookingId, "declined");
      await this.bookings.cancel(tenantId, o.bookingId, actor).catch((e) => {
        if (!(e instanceof ApiError && e.code === "INVALID_TRANSITION")) throw e; // already expired/cancelled
      });
      await this.release(tenantId, o.bookingId);
    }
    return this.getOffer(tenantId, offerId);
  }

  // ---------------------------------------------------------------------------------------------
  // The matcher (called by the worker for slot.released and booking.expired)
  // ---------------------------------------------------------------------------------------------

  /**
   * A slot has just become free (a booking was cancelled, moved or its hold expired). Closes the booking's
   * own open offer if it was one, then offers the freed time to the first compatible person in the queue.
   * The freed range is the booking's own unless the caller passes one (a reschedule frees the OLD time).
   * Safe to call any number of times, concurrently: whether a slot is really free is decided by
   * availability, the hold itself is protected by the exclusion constraint, and an entry can have only one
   * open offer, so a slot gets at most one open offer.
   */
  async release(
    tenantId: string,
    bookingId: string,
    range?: { startAt: Date; endAt: Date },
  ): Promise<{ offers: string[] }> {
    const b = await this.db.withTenant(tenantId, async (tx) => {
      const x = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!x) return null;
      const branch = await tx.branch.findUniqueOrThrow({ where: { id: x.branchId } });
      return { booking: x, timezone: branch.timezone };
    });
    if (!b) return { offers: [] };
    const { booking, timezone } = b;
    if (booking.status === "expired") await this.closeOffer(tenantId, bookingId, "expired");
    return this.matchRange(
      tenantId,
      booking.branchId,
      range?.startAt ?? booking.startAt,
      range?.endAt ?? booking.endAt,
      timezone,
    );
  }

  async matchRange(
    tenantId: string,
    branchId: string,
    from: Date,
    to: Date,
    timezone: string,
  ): Promise<{ offers: string[] }> {
    const now = new Date();
    const entries = await this.db.withTenant(tenantId, (tx) =>
      this.candidates(tx, branchId, from, to, now),
    );
    const offers: string[] = [];
    for (const e of entries.slice(0, MAX_ENTRIES_PER_RELEASE)) {
      const dayFrom = localDate(Math.max(from.getTime(), now.getTime()), timezone);
      const dayTo = localDate(to.getTime(), timezone);
      const res = await this.availability.compute(tenantId, {
        branchId,
        serviceId: e.serviceId,
        from: dayFrom,
        to: dayTo,
        staffId: e.staffId ?? undefined,
      });
      const slots = res.slots
        .filter((s) => {
          const st = Date.parse(s.startAt);
          const en = Date.parse(s.endAt);
          return (
            st >= now.getTime() &&
            st >= e.windowStart.getTime() &&
            en <= e.windowEnd.getTime() &&
            st < to.getTime() &&
            en > from.getTime()
          );
        })
        .sort((a, c) => Date.parse(a.startAt) - Date.parse(c.startAt))
        .slice(0, MAX_SLOTS_PER_ENTRY);
      for (const s of slots) {
        const made = await this.offer(tenantId, e, new Date(s.startAt));
        if (made === "taken") continue; // someone else got that slot; try this entry's next one
        if (made === "busy") break; // this entry already has an open offer
        offers.push(made);
        break;
      }
      if (offers.length >= 1) break; // one freed slot, one offer
    }
    return { offers };
  }

  private async candidates(tx: Tx, branchId: string, from: Date, to: Date, now: Date) {
    // FIFO by registration time. An entry is skipped for time it already declined or let expire.
    return tx.$queryRaw<
      {
        id: string;
        serviceId: string;
        customerId: string;
        staffId: string | null;
        windowStart: Date;
        windowEnd: Date;
      }[]
    >`
      SELECT e.id::text AS id, e.service_id::text AS "serviceId", e.customer_id::text AS "customerId",
             e.staff_id::text AS "staffId", e.window_start AS "windowStart", e.window_end AS "windowEnd"
        FROM waitlist_entries e
       WHERE e.branch_id = ${branchId}::uuid AND e.status = 'waiting'
         AND e.window_end > ${now} AND e.window_start < ${to} AND e.window_end > ${from}
         AND NOT EXISTS (
           SELECT 1 FROM waitlist_offers o JOIN bookings ob ON ob.id = o.booking_id
            WHERE o.entry_id = e.id AND o.status IN ('declined','expired')
              AND ob.start_at < ${to} AND ob.end_at > ${from})
       ORDER BY e.created_at, e.id
       LIMIT ${MAX_ENTRIES_PER_RELEASE}`;
  }

  /** Creates the hold and the offer in one transaction; returns the offer id, "taken" or "busy". */
  private async offer(
    tenantId: string,
    e: { id: string; serviceId: string; customerId: string; staffId: string | null },
    startAt: Date,
  ): Promise<string | "taken" | "busy"> {
    let offerId = "";
    try {
      await this.bookings.place(
        tenantId,
        {
          branchId: await this.branchOf(tenantId, e.id),
          serviceId: e.serviceId,
          customerId: e.customerId,
          startAt,
          staffId: e.staffId ?? undefined,
          source: "waitlist",
        },
        "held",
        undefined,
        "waitlist",
        {
          holdMinutes: WAITLIST_HOLD_MINUTES,
          afterCreate: async (tx, booking) => {
            const moved = await tx.waitlistEntry.updateMany({
              where: { id: e.id, status: "waiting" },
              data: { status: "offered" },
            });
            if (moved.count !== 1) throw new OfferConflict(); // someone else just handled this entry
            const o = await tx.waitlistOffer.create({
              data: { entryId: e.id, bookingId: booking.id, expiresAt: booking.holdExpiresAt! },
            });
            offerId = o.id;
            await tx.outboxEvent.create({
              data: {
                type: "waitlist.offered",
                payload: {
                  offerId: o.id,
                  entryId: e.id,
                  bookingId: booking.id,
                  customerId: e.customerId,
                  branchId: booking.branchId,
                  startAt: booking.startAt.toISOString(),
                  expiresAt: booking.holdExpiresAt!.toISOString(),
                },
              },
            });
          },
        },
      );
      return offerId;
    } catch (err) {
      if (err instanceof OfferConflict || isUnique(err)) return "busy";
      if (err instanceof ApiError && err.code === "SLOT_UNAVAILABLE") return "taken";
      throw err;
    }
  }

  private async branchOf(tenantId: string, entryId: string) {
    return this.db.withTenant(
      tenantId,
      async (tx) => (await tx.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } })).branchId,
    );
  }

  /** Closes the open offer attached to a hold (expired or declined) and puts its entry back in the queue. */
  private async closeOffer(tenantId: string, bookingId: string, status: "expired" | "declined") {
    await this.db.withTenant(tenantId, async (tx) => {
      const o = await tx.waitlistOffer.findFirst({ where: { bookingId, status: "open" } });
      if (!o) return;
      await tx.waitlistOffer.updateMany({ where: { id: o.id, status: "open" }, data: { status } });
      await tx.waitlistEntry.updateMany({
        where: { id: o.entryId, status: "offered" },
        data: { status: "waiting" },
      });
    });
  }
}

class OfferConflict extends Error {}

type EntryRow = NonNullable<Awaited<ReturnType<Tx["waitlistEntry"]["findUnique"]>>>;
const toEntry = (e: EntryRow) => ({
  id: e.id,
  branchId: e.branchId,
  serviceId: e.serviceId,
  customerId: e.customerId,
  staffId: e.staffId,
  windowStart: e.windowStart.toISOString(),
  windowEnd: e.windowEnd.toISOString(),
  status: e.status,
  createdAt: e.createdAt.toISOString(),
});
type OfferRow = NonNullable<Awaited<ReturnType<Tx["waitlistOffer"]["findUnique"]>>>;
const toOffer = (
  o: OfferRow,
  b: {
    id: string;
    startAt: Date;
    endAt: Date;
    status: string;
    serviceId: string;
    branchId: string;
  },
) => ({
  id: o.id,
  entryId: o.entryId,
  status: o.status,
  expiresAt: o.expiresAt.toISOString(),
  booking: {
    id: b.id,
    status: b.status,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    serviceId: b.serviceId,
    branchId: b.branchId,
  },
});
