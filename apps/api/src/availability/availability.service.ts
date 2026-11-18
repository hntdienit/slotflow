import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  computeAvailability,
  datesBetween,
  dayWindows,
  formatLocal,
  HoursRow,
  Interval,
  intersect,
  normalize,
  startOfLocalDay,
  subtract,
} from "@slotflow/core";
import { Prisma } from "../generated/prisma/client";
import { CacheService } from "../cache/cache.service";
import { DbService, Tx } from "../db/db.service";

export interface AvailabilityQuery {
  branchId: string;
  serviceId: string;
  from: string; // YYYY-MM-DD, branch-local, inclusive
  to: string; // YYYY-MM-DD, branch-local, inclusive
  staffId?: string;
}

export interface SlotDto {
  startAt: string;
  endAt: string;
  startLocal: string;
  staffId: string;
  resourceId: string | null;
  resourceOptions: string[];
  staffOptions: string[];
}

export interface AvailabilityResult {
  branchId: string;
  serviceId: string;
  timezone: string;
  from: string;
  to: string;
  slots: SlotDto[];
}

export const CACHE_TTL_SECONDS = 60;
export const MAX_RANGE_DAYS = 31;
const STEP_MIN = Number(process.env.AVAILABILITY_STEP_MIN ?? 15);
const MIN_NOTICE_MIN = Number(process.env.AVAILABILITY_MIN_NOTICE_MIN ?? 0);

const toIv = (s: Date, e: Date): Interval => ({ start: s.getTime(), end: e.getTime() });
const hours = (r: { weekday: number; startLocal: Date; endLocal: Date }): HoursRow => ({
  weekday: r.weekday,
  start: r.startLocal.toISOString().slice(11, 16),
  end: r.endLocal.toISOString().slice(11, 16),
});

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
  ) {}

  /** Returns the result plus whether it came from cache. `noCache` skips reading and writing the cache. */
  async get(
    tenantId: string,
    q: AvailabilityQuery,
    noCache = false,
  ): Promise<{ result: AvailabilityResult; cache: "hit" | "miss" | "bypass" }> {
    this.validateRange(q.from, q.to);
    if (noCache) return { result: await this.compute(tenantId, q), cache: "bypass" };

    const [catVer, brVer] = await this.cache.versions([
      `ver:cat:${tenantId}`,
      `ver:br:${tenantId}:${q.branchId}`,
    ]);
    const key = `avail:${tenantId}:${q.branchId}:${q.serviceId}:${q.staffId ?? "any"}:${q.from}:${q.to}:${catVer}.${brVer}`;
    const cached = await this.cache.getJson<AvailabilityResult>(key);
    if (cached) {
      const now = Date.now();
      return {
        result: { ...cached, slots: cached.slots.filter((s) => Date.parse(s.startAt) > now) },
        cache: "hit",
      };
    }
    const result = await this.compute(tenantId, q);
    await this.cache.setJson(key, result, CACHE_TTL_SECONDS);
    return { result, cache: "miss" };
  }

  private validateRange(from: string, to: string) {
    const days = datesBetween(from, to).length;
    if (days < 1) throw new BadRequestException("`to` must not be before `from`");
    if (days > MAX_RANGE_DAYS)
      throw new BadRequestException(`range is limited to ${MAX_RANGE_DAYS} days`);
  }

  /** `excludeBookingId`: ignore one booking's own rows (used when rescheduling it). */
  async compute(
    tenantId: string,
    q: AvailabilityQuery,
    opts: { excludeBookingId?: string } = {},
  ): Promise<AvailabilityResult> {
    return this.db.withTenant(tenantId, async (tx) => {
      const branch = await tx.branch.findUnique({ where: { id: q.branchId } });
      if (!branch) throw new NotFoundException("branch not found");
      const service = await tx.service.findUnique({ where: { id: q.serviceId } });
      if (!service) throw new NotFoundException("service not found");
      const tz = branch.timezone;
      const base = {
        branchId: q.branchId,
        serviceId: q.serviceId,
        timezone: tz,
        from: q.from,
        to: q.to,
      };

      // Staff who work at this branch and can perform the service.
      const [atBranch, canDo] = await Promise.all([
        tx.staffBranch.findMany({ where: { branchId: q.branchId } }),
        tx.staffService.findMany({ where: { serviceId: q.serviceId } }),
      ]);
      const doers = new Set(canDo.map((r) => r.staffId));
      let staffIds = atBranch.map((r) => r.staffId).filter((id) => doers.has(id));
      if (q.staffId) {
        if (!staffIds.includes(q.staffId))
          throw new UnprocessableEntityException(
            "staff cannot perform this service at this branch",
          );
        staffIds = [q.staffId];
      }
      if (staffIds.length === 0) return { ...base, slots: [] };

      const resources = service.requiresResourceType
        ? await tx.resource.findMany({
            where: { branchId: q.branchId, type: service.requiresResourceType },
          })
        : null;
      if (resources && resources.length === 0) return { ...base, slots: [] };

      const dates = datesBetween(q.from, q.to);
      const rangeStart = startOfLocalDay(q.from, tz);
      const rangeEndExact = startOfLocalDay(addDay(q.to), tz); // local midnight after the last day

      const owners = [q.branchId, ...staffIds];
      const [hourRows, offRows, busyRows] = await Promise.all([
        tx.workingHours.findMany({ where: { ownerId: { in: owners } } }),
        tx.timeOff.findMany({
          where: {
            ownerId: { in: owners },
            startAt: { lt: new Date(rangeEndExact) },
            endAt: { gt: new Date(rangeStart) },
          },
        }),
        this.busy(
          tx,
          [...staffIds, ...(resources?.map((r) => r.id) ?? [])],
          rangeStart,
          rangeEndExact,
          opts.excludeBookingId,
        ),
      ]);

      const branchHours = hourRows.filter((r) => r.ownerId === q.branchId).map(hours);
      const staffHours = new Map<string, HoursRow[]>();
      for (const r of hourRows)
        if (r.ownerId !== q.branchId)
          staffHours.set(r.ownerId, [...(staffHours.get(r.ownerId) ?? []), hours(r)]);
      const offBy = new Map<string, Interval[]>();
      for (const r of offRows)
        offBy.set(r.ownerId, [...(offBy.get(r.ownerId) ?? []), toIv(r.startAt, r.endAt)]);
      const branchOff = normalize(offBy.get(q.branchId) ?? []);
      const busyBy = new Map<string, Interval[]>();
      for (const r of busyRows)
        busyBy.set(r.resource_id, [
          ...(busyBy.get(r.resource_id) ?? []),
          { start: r.s.getTime(), end: r.e.getTime() },
        ]);

      const staff = staffIds.map((id) => {
        const rows = staffHours.get(id) ?? [];
        const windows: Interval[] = [];
        for (const date of dates) {
          const open = dayWindows(date, tz, branchHours);
          windows.push(...intersect(open, dayWindows(date, tz, rows)));
        }
        const free = subtract(
          subtract(normalize(windows), branchOff),
          normalize(offBy.get(id) ?? []),
        );
        return { id, windows: free, busy: busyBy.get(id) ?? [] };
      });

      const slots = computeAvailability({
        staff,
        resources: resources?.map((r) => ({ id: r.id, busy: busyBy.get(r.id) ?? [] })),
        service: {
          durationMin: service.durationMin,
          bufferBeforeMin: service.bufferBeforeMin,
          bufferAfterMin: service.bufferAfterMin,
        },
        stepMin: STEP_MIN,
        notBefore: Date.now() + MIN_NOTICE_MIN * 60_000,
      });

      return {
        ...base,
        slots: slots.map((s) => ({
          startAt: new Date(s.start).toISOString(),
          endAt: new Date(s.end).toISOString(),
          startLocal: formatLocal(s.start, tz),
          staffId: s.staffId,
          resourceId: s.resourceId,
          resourceOptions: s.resourceOptions,
          staffOptions: s.staffOptions,
        })),
      };
    });
  }

  /**
   * Time already taken on staff/resources. Held bookings whose hold has expired no longer block
   * (the exclusion constraint cannot use now(); expiry is applied here and in the booking tx, ADR-002).
   */
  private busy(tx: Tx, ids: string[], from: number, to: number, excludeBookingId?: string) {
    return tx.$queryRaw<{ resource_id: string; s: Date; e: Date }[]>(Prisma.sql`
      SELECT br.resource_id::text AS resource_id, lower(br.time_range) AS s, upper(br.time_range) AS e
      FROM booking_resources br
      JOIN bookings b ON b.id = br.booking_id
      WHERE br.resource_id = ANY(${ids}::uuid[])
        AND br.status IN ('held','confirmed')
        AND br.time_range && tstzrange(${new Date(from)}::timestamptz, ${new Date(to)}::timestamptz)
        AND NOT (br.status = 'held' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= now())
        AND (${excludeBookingId ?? null}::uuid IS NULL OR br.booking_id <> ${excludeBookingId ?? null}::uuid)`);
  }
}

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
