import { Injectable } from "@nestjs/common";
import {
  assertTransition,
  BookingStatus,
  canCheckIn,
  canMarkNoShow,
  evaluateCancellation,
  InvalidTransitionError,
  localDate,
  MIN,
  occupiedRange,
} from "@slotflow/core";
import { createHash } from "node:crypto";
import { AvailabilityService, SlotDto } from "../availability/availability.service";
import { CacheService } from "../cache/cache.service";
import { DbService, Tx } from "../db/db.service";
import { pgCode, prismaCode } from "../db/pg-error";
import { ApiError, invalidTransition, notFound, slotUnavailable } from "./api-error";

export const HOLD_MINUTES = Number(process.env.HOLD_MINUTES ?? 5);
const MAX_CANDIDATES = 12;
const MAX_TX_RETRIES = 4;

export type Source = "web" | "ai" | "admin";
export interface PlaceInput {
  branchId: string;
  serviceId: string;
  customerId: string;
  startAt: Date;
  staffId?: string;
  source: Source;
}

type BookingRow = NonNullable<Awaited<ReturnType<Tx["booking"]["findUnique"]>>>;

export interface BookingDto {
  id: string;
  branchId: string;
  serviceId: string;
  customerId: string;
  status: string;
  startAt: string;
  endAt: string;
  holdExpiresAt: string | null;
  source: string;
  cancelledAt: string | null;
  cancellationFeeCents: number | null;
  resources: { resourceId: string; status: string }[];
  events?: {
    fromStatus: string | null;
    toStatus: string;
    actor: string | null;
    payload: unknown;
    createdAt: string;
  }[];
}

const isExclusion = (e: unknown) => pgCode(e) === "23P01";
const isUnique = (e: unknown) => prismaCode(e) === "P2002" || pgCode(e) === "23505";
const isRetryable = (e: unknown) =>
  ["40P01", "40001"].includes(pgCode(e) ?? "") || prismaCode(e) === "P2034";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class BookingService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly availability: AvailabilityService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Create (hold or direct confirm)
  // ---------------------------------------------------------------------------------------------

  /**
   * Places a booking. Correctness does not depend on the availability check below (it is advisory and
   * also validates working hours): the database exclusion constraint on booking_resources is the final
   * arbiter (ADR-002). Every attempt writes the booking and ALL its resource rows in one transaction,
   * inserted in ascending resource_id order, so concurrent multi-resource bookings cannot deadlock.
   */
  async place(
    tenantId: string,
    input: PlaceInput,
    mode: "held" | "confirmed",
    idempotencyKey: string | undefined,
    actor: string,
  ) {
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          mode,
          input.branchId,
          input.serviceId,
          input.customerId,
          input.startAt.toISOString(),
          input.staffId ?? null,
        ]),
      )
      .digest("hex");

    if (idempotencyKey) {
      const prior = await this.replay(tenantId, idempotencyKey, hash);
      if (prior) return prior;
    }
    if (input.startAt.getTime() <= Date.now())
      throw new ApiError(422, "START_IN_PAST", "startAt must be in the future");

    const { timezone, service } = await this.loadContext(tenantId, input);
    const date = localDate(input.startAt.getTime(), timezone);
    const result = await this.availability.compute(tenantId, {
      branchId: input.branchId,
      serviceId: input.serviceId,
      from: date,
      to: date,
      staffId: input.staffId,
    });
    const slot = result.slots.find((s) => Date.parse(s.startAt) === input.startAt.getTime());
    if (!slot) throw slotUnavailable();

    for (const cand of candidates(slot, input.staffId)) {
      try {
        const out = await this.withRetry(() =>
          this.db.withTenant(tenantId, async (tx) => {
            const freed = await this.expireStaleHolds(tx, {
              resourceIds: [cand.staffId, cand.resourceId].filter(nn),
              range: occupiedRange(input.startAt.getTime(), service),
            });
            const booking = await tx.booking.create({
              data: {
                branchId: input.branchId,
                customerId: input.customerId,
                serviceId: input.serviceId,
                status: mode,
                startAt: input.startAt,
                endAt: new Date(input.startAt.getTime() + service.durationMin * MIN),
                holdExpiresAt: mode === "held" ? new Date(Date.now() + HOLD_MINUTES * MIN) : null,
                idempotencyKey: idempotencyKey ?? null,
                requestHash: idempotencyKey ? hash : null,
                source: input.source,
              },
            });
            // Ascending resource_id order => a consistent lock order for concurrent transactions.
            const ids = [cand.staffId, cand.resourceId].filter(nn).sort();
            const range = occupiedRange(input.startAt.getTime(), service);
            for (const resourceId of ids) {
              await tx.$executeRaw`INSERT INTO booking_resources (booking_id, resource_id, time_range, status)
                VALUES (${booking.id}::uuid, ${resourceId}::uuid,
                        tstzrange(${new Date(range.start)}::timestamptz, ${new Date(range.end)}::timestamptz), ${mode})`;
            }
            await this.record(
              tx,
              booking,
              null,
              mode,
              actor,
              { staffId: cand.staffId, resourceId: cand.resourceId },
              mode === "held" ? "booking.held" : "booking.confirmed",
            );
            return { dto: await this.toDto(tx, booking), freed };
          }),
        );
        await this.bump(tenantId, [input.branchId, ...out.freed]);
        return { booking: out.dto, replay: false };
      } catch (e) {
        if (isUnique(e) && idempotencyKey) {
          const prior = await this.replay(tenantId, idempotencyKey, hash);
          if (prior) return prior;
        }
        if (isExclusion(e)) continue; // someone else took this staff/resource combination: try the next
        throw e;
      }
    }
    throw slotUnavailable();
  }

  private async loadContext(tenantId: string, input: PlaceInput) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [branch, service, customer] = await Promise.all([
        tx.branch.findUnique({ where: { id: input.branchId } }),
        tx.service.findUnique({ where: { id: input.serviceId } }),
        tx.customer.findUnique({ where: { id: input.customerId } }),
      ]);
      if (!branch) throw notFound("branch");
      if (!service) throw notFound("service");
      if (!customer) throw notFound("customer");
      return { timezone: branch.timezone, service };
    });
  }

  /** Returns the earlier result for an Idempotency-Key, or rejects a key reused with another payload. */
  private async replay(tenantId: string, key: string, hash: string) {
    const found = await this.db.withTenant(tenantId, async (tx) => {
      const b = await tx.booking.findFirst({ where: { idempotencyKey: key } });
      return b ? { hash: b.requestHash, dto: await this.toDto(tx, b) } : null;
    });
    if (!found) return null;
    if (found.hash !== hash)
      throw new ApiError(
        422,
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different request",
      );
    return { booking: found.dto, replay: true };
  }

  // ---------------------------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------------------------

  async confirm(tenantId: string, id: string, actor: string) {
    const out = await this.db.withTenant(tenantId, async (tx) => {
      const b = await this.lock(tx, id);
      if (b.status === "confirmed") return { dto: await this.toDto(tx, b), expired: false }; // idempotent
      if (b.status !== "held") throw invalidTransition(b.status, "confirmed");
      const nowRows = await tx.$queryRaw<{ now: Date }[]>`select now() as now`;
      const now = nowRows[0]!.now;
      if (!b.holdExpiresAt || b.holdExpiresAt <= now) {
        await this.transition(tx, b, "expired", actor, {
          resourceStatus: "expired",
          type: "booking.expired",
        });
        return { dto: null, expired: true, branchId: b.branchId };
      }
      const upd = await this.transition(tx, b, "confirmed", actor, {
        data: { holdExpiresAt: null },
        resourceStatus: "confirmed",
        resourceFrom: ["held"],
        type: "booking.confirmed",
      });
      return { dto: await this.toDto(tx, upd), expired: false };
    });
    if (out.expired) {
      await this.bump(tenantId, [out.branchId!]);
      throw new ApiError(
        409,
        "HOLD_EXPIRED",
        "The hold expired before it was confirmed. Please pick a slot again.",
      );
    }
    return out.dto!;
  }

  async cancel(tenantId: string, id: string, actor: string) {
    const out = await this.db.withTenant(tenantId, async (tx) => {
      const b = await this.lock(tx, id);
      const service = await tx.service.findUniqueOrThrow({ where: { id: b.serviceId } });
      const wasConfirmed = b.status === "confirmed";
      const policy = wasConfirmed
        ? evaluateCancellation({
            startAt: b.startAt.getTime(),
            now: Date.now(),
            cancelWindowHours: service.cancelWindowHours,
            priceCents: service.priceCents,
            lateFeePercent: service.lateCancelFeePercent,
          })
        : {
            free: true,
            feeCents: 0,
            hoursBeforeStart: (b.startAt.getTime() - Date.now()) / 3_600_000,
          };
      const upd = await this.transition(tx, b, "cancelled", actor, {
        data: { cancelledAt: new Date(), cancellationFeeCents: policy.feeCents },
        resourceStatus: "cancelled",
        payload: { free: policy.free, feeCents: policy.feeCents },
        type: "booking.cancelled",
      });
      if (b.startAt.getTime() > Date.now()) await this.emit(tx, "slot.released", slotPayload(b));
      return { dto: await this.toDto(tx, upd), cancellation: policy, branchId: b.branchId };
    });
    await this.bump(tenantId, [out.branchId]);
    return {
      booking: out.dto,
      cancellation: { free: out.cancellation.free, feeCents: out.cancellation.feeCents },
    };
  }

  async checkIn(tenantId: string, id: string, actor: string) {
    return this.simple(tenantId, id, actor, "checked_in", "booking.checked_in", (b) => {
      if (!canCheckIn(Date.now(), b.startAt.getTime(), b.endAt.getTime()))
        throw new ApiError(
          409,
          "CHECKIN_WINDOW",
          "Check-in opens 60 minutes before the appointment and closes when it ends",
        );
    });
  }

  async noShow(tenantId: string, id: string, actor: string) {
    return this.simple(
      tenantId,
      id,
      actor,
      "no_show",
      "booking.no_show",
      (b) => {
        if (!canMarkNoShow(Date.now(), b.startAt.getTime()))
          throw new ApiError(
            409,
            "TOO_EARLY",
            "A no-show can only be recorded after the grace period following the start time",
          );
      },
      "released",
    );
  }

  async complete(tenantId: string, id: string, actor: string) {
    return this.simple(tenantId, id, actor, "completed", "booking.completed", () => undefined);
  }

  private async simple(
    tenantId: string,
    id: string,
    actor: string,
    to: BookingStatus,
    type: string,
    guard: (b: BookingRow) => void,
    resourceStatus?: string,
  ) {
    const out = await this.db.withTenant(tenantId, async (tx) => {
      const b = await this.lock(tx, id);
      assertOrThrow(b.status as BookingStatus, to);
      guard(b);
      const upd = await this.transition(tx, b, to, actor, { resourceStatus, type });
      return { dto: await this.toDto(tx, upd), branchId: b.branchId };
    });
    if (resourceStatus) await this.bump(tenantId, [out.branchId]);
    return out.dto;
  }

  /**
   * Moves a confirmed booking to a new time. One transaction: the old rows are released and the new
   * rows inserted; if the new slot conflicts the transaction rolls back and the original booking is
   * untouched. Staff stays the same unless `staffId` is given.
   */
  async reschedule(
    tenantId: string,
    id: string,
    startAt: Date,
    staffId: string | undefined,
    actor: string,
  ) {
    if (startAt.getTime() <= Date.now())
      throw new ApiError(422, "START_IN_PAST", "startAt must be in the future");
    const current = await this.db.withTenant(tenantId, async (tx) => {
      const b = await tx.booking.findUnique({ where: { id } });
      if (!b) throw notFound("booking");
      if (b.status !== "confirmed") throw invalidTransition(b.status, "confirmed");
      const rows = await tx.bookingResource.findMany({
        where: { bookingId: id, status: "confirmed" },
        select: { resourceId: true },
      });
      const staff = await tx.staff.findMany({
        where: { id: { in: rows.map((r) => r.resourceId) } },
      });
      const [branch, service] = await Promise.all([
        tx.branch.findUniqueOrThrow({ where: { id: b.branchId } }),
        tx.service.findUniqueOrThrow({ where: { id: b.serviceId } }),
      ]);
      return { b, staffId: staff[0]?.id, timezone: branch.timezone, service };
    });
    const wantStaff = staffId ?? current.staffId;
    const date = localDate(startAt.getTime(), current.timezone);
    const result = await this.availability.compute(
      tenantId,
      {
        branchId: current.b.branchId,
        serviceId: current.b.serviceId,
        from: date,
        to: date,
        staffId: wantStaff,
      },
      { excludeBookingId: id },
    );
    const slot = result.slots.find((s) => Date.parse(s.startAt) === startAt.getTime());
    if (!slot) throw slotUnavailable();

    for (const cand of candidates(slot, wantStaff)) {
      try {
        const out = await this.withRetry(() =>
          this.db.withTenant(tenantId, async (tx) => {
            const b = await this.lock(tx, id);
            if (b.status !== "confirmed") throw invalidTransition(b.status, "confirmed");
            const range = occupiedRange(startAt.getTime(), current.service);
            const freed = await this.expireStaleHolds(tx, {
              resourceIds: [cand.staffId, cand.resourceId].filter(nn),
              range,
            });
            await tx.bookingResource.updateMany({
              where: { bookingId: id, status: "confirmed" },
              data: { status: "released" },
            });
            for (const resourceId of [cand.staffId, cand.resourceId].filter(nn).sort()) {
              await tx.$executeRaw`INSERT INTO booking_resources (booking_id, resource_id, time_range, status)
                VALUES (${id}::uuid, ${resourceId}::uuid,
                        tstzrange(${new Date(range.start)}::timestamptz, ${new Date(range.end)}::timestamptz), 'confirmed')`;
            }
            const moved = await tx.booking.update({
              where: { id },
              data: {
                startAt,
                endAt: new Date(startAt.getTime() + current.service.durationMin * MIN),
                updatedAt: new Date(),
              },
            });
            const payload = {
              from: b.startAt.toISOString(),
              to: startAt.toISOString(),
              staffId: cand.staffId,
              resourceId: cand.resourceId,
            };
            await tx.bookingEvent.create({
              data: {
                bookingId: id,
                fromStatus: "confirmed",
                toStatus: "confirmed",
                actor,
                payload: { type: "rescheduled", ...payload },
              },
            });
            await this.emit(tx, "booking.rescheduled", {
              bookingId: id,
              branchId: b.branchId,
              ...payload,
            });
            await this.emit(tx, "slot.released", slotPayload(b));
            return { dto: await this.toDto(tx, moved), freed };
          }),
        );
        await this.bump(tenantId, [current.b.branchId, ...out.freed]);
        return out.dto;
      } catch (e) {
        if (isExclusion(e)) continue; // rolled back: original booking intact
        throw e;
      }
    }
    throw slotUnavailable();
  }

  // ---------------------------------------------------------------------------------------------
  // Holds
  // ---------------------------------------------------------------------------------------------

  /**
   * Flips expired holds to `expired` so they stop blocking. The exclusion constraint cannot use now(),
   * so this runs inside every booking transaction for the affected resources and range only (ADR-002);
   * the hold-sweeper worker (M4) calls `expireStaleHolds` with no filter to clean up the rest.
   * Returns the branches whose availability changed.
   */
  async expireStaleHolds(
    tx: Tx,
    filter?: { resourceIds: string[]; range: { start: number; end: number } },
  ): Promise<string[]> {
    const stale = filter
      ? await tx.$queryRaw<{ id: string; branch_id: string }[]>`
          SELECT DISTINCT b.id::text AS id, b.branch_id::text AS branch_id
          FROM bookings b JOIN booking_resources br ON br.booking_id = b.id
          WHERE b.status = 'held' AND b.hold_expires_at <= now() AND br.status = 'held'
            AND br.resource_id = ANY(${filter.resourceIds}::uuid[])
            AND br.time_range && tstzrange(${new Date(filter.range.start)}::timestamptz, ${new Date(filter.range.end)}::timestamptz)`
      : await tx.$queryRaw<{ id: string; branch_id: string }[]>`
          SELECT b.id::text AS id, b.branch_id::text AS branch_id FROM bookings b
          WHERE b.status = 'held' AND b.hold_expires_at <= now()`;
    if (stale.length === 0) return [];
    const ids = stale.map((s) => s.id);
    const done = await tx.$queryRaw<{ id: string }[]>`
      UPDATE bookings SET status = 'expired', updated_at = now()
      WHERE id = ANY(${ids}::uuid[]) AND status = 'held' AND hold_expires_at <= now() RETURNING id::text AS id`;
    const doneIds = done.map((d) => d.id);
    if (doneIds.length === 0) return [];
    await tx.bookingResource.updateMany({
      where: { bookingId: { in: doneIds }, status: "held" },
      data: { status: "expired" },
    });
    await tx.bookingEvent.createMany({
      data: doneIds.map((bookingId) => ({
        bookingId,
        fromStatus: "held",
        toStatus: "expired",
        actor: "system",
        payload: {},
      })),
    });
    for (const bookingId of doneIds) {
      const row = stale.find((s) => s.id === bookingId)!;
      await this.emit(tx, "booking.expired", { bookingId, branchId: row.branch_id });
    }
    return [...new Set(stale.filter((s) => doneIds.includes(s.id)).map((s) => s.branch_id))];
  }

  /** Expires every stale hold of one tenant (used by the sweeper and tests). */
  async sweepTenant(tenantId: string): Promise<number> {
    const branches = await this.db.withTenant(tenantId, (tx) => this.expireStaleHolds(tx));
    await this.bump(tenantId, branches);
    return branches.length;
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async get(tenantId: string, id: string): Promise<BookingDto> {
    return this.db.withTenant(tenantId, async (tx) => {
      const b = await tx.booking.findUnique({ where: { id } });
      if (!b) throw notFound("booking");
      return this.toDto(tx, b, true);
    });
  }

  async list(
    tenantId: string,
    f: {
      branchId?: string;
      customerId?: string;
      status?: string;
      from?: Date;
      to?: Date;
      limit: number;
    },
  ) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.booking.findMany({
        where: {
          branchId: f.branchId,
          customerId: f.customerId,
          status: f.status,
          startAt: { gte: f.from, lt: f.to },
        },
        orderBy: [{ startAt: "asc" }, { id: "asc" }],
        take: f.limit,
      });
      return Promise.all(rows.map((r) => this.toDto(tx, r)));
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  /** Row lock so concurrent transitions of one booking serialise. */
  private async lock(tx: Tx, id: string): Promise<BookingRow> {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id::text AS id FROM bookings WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound("booking");
    return tx.booking.findUniqueOrThrow({ where: { id } });
  }

  /** The single path every status change takes: validates the move, updates, writes history + outbox. */
  private async transition(
    tx: Tx,
    b: BookingRow,
    to: BookingStatus,
    actor: string,
    o: {
      data?: Record<string, unknown>;
      resourceStatus?: string;
      resourceFrom?: string[];
      payload?: Record<string, unknown>;
      type: string;
    },
  ): Promise<BookingRow> {
    assertOrThrow(b.status as BookingStatus, to);
    const n = await tx.booking.updateMany({
      where: { id: b.id, status: b.status },
      data: { status: to, updatedAt: new Date(), ...o.data },
    });
    if (n.count !== 1) throw invalidTransition(b.status, to);
    if (o.resourceStatus)
      await tx.bookingResource.updateMany({
        where: { bookingId: b.id, status: { in: o.resourceFrom ?? ["held", "confirmed"] } },
        data: { status: o.resourceStatus },
      });
    await this.record(
      tx,
      { ...b, status: to },
      b.status,
      to,
      actor,
      o.payload ?? {},
      o.type,
      false,
    );
    return tx.booking.findUniqueOrThrow({ where: { id: b.id } });
  }

  private async record(
    tx: Tx,
    b: BookingRow,
    from: string | null,
    to: string,
    actor: string,
    payload: Record<string, unknown>,
    type: string,
    createEvent = true,
  ) {
    if (createEvent || from === null)
      await tx.bookingEvent.create({
        data: {
          bookingId: b.id,
          fromStatus: from,
          toStatus: to,
          actor,
          payload: payload as object,
        },
      });
    else
      await tx.bookingEvent.create({
        data: {
          bookingId: b.id,
          fromStatus: from,
          toStatus: to,
          actor,
          payload: payload as object,
        },
      });
    await this.emit(tx, type, {
      bookingId: b.id,
      branchId: b.branchId,
      serviceId: b.serviceId,
      customerId: b.customerId,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      ...payload,
    });
  }

  /** Transactional outbox: events commit atomically with the state change; workers deliver them (M4). */
  private emit(tx: Tx, type: string, payload: Record<string, unknown>) {
    return tx.outboxEvent.create({ data: { type, payload: payload as object } });
  }

  private async toDto(tx: Tx, b: BookingRow, withEvents = false): Promise<BookingDto> {
    const resources = await tx.bookingResource.findMany({
      where: { bookingId: b.id },
      select: { resourceId: true, status: true },
      orderBy: { resourceId: "asc" },
    });
    const events = withEvents
      ? await tx.bookingEvent.findMany({
          where: { bookingId: b.id },
          orderBy: { createdAt: "asc" },
        })
      : undefined;
    return {
      id: b.id,
      branchId: b.branchId,
      serviceId: b.serviceId,
      customerId: b.customerId,
      status: b.status,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
      source: b.source,
      cancelledAt: b.cancelledAt?.toISOString() ?? null,
      cancellationFeeCents: b.cancellationFeeCents,
      resources,
      events: events?.map((e) => ({
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  private async bump(tenantId: string, branchIds: string[]) {
    await Promise.all([...new Set(branchIds)].map((b) => this.cache.bumpBranch(tenantId, b)));
  }

  /** Retries a whole transaction on deadlock / serialization failures (should be rare given the lock order). */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!isRetryable(e) || attempt >= MAX_TX_RETRIES) throw e;
        await sleep(5 * attempt + Math.random() * 10);
      }
    }
  }
}

const nn = <T>(x: T | null | undefined): x is T => x !== null && x !== undefined;

function slotPayload(b: BookingRow) {
  return {
    bookingId: b.id,
    branchId: b.branchId,
    serviceId: b.serviceId,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
  };
}

function assertOrThrow(from: BookingStatus, to: BookingStatus) {
  try {
    assertTransition(from, to);
  } catch (e) {
    if (e instanceof InvalidTransitionError) throw invalidTransition(from, to);
    throw e;
  }
}

/** Staff x resource combinations to try, best (least loaded) first, capped. */
function candidates(
  slot: SlotDto,
  staffId?: string,
): { staffId: string; resourceId: string | null }[] {
  const staff = staffId ? [staffId] : slot.staffOptions;
  const resources = slot.resourceOptions.length ? slot.resourceOptions : [null];
  return staff
    .flatMap((s) => resources.map((r) => ({ staffId: s, resourceId: r })))
    .slice(0, MAX_CANDIDATES);
}
