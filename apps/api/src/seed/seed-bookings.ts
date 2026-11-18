import { randomUUID } from "node:crypto";
import { datesBetween, dayWindows, localDate, MIN, occupiedRange } from "@slotflow/core";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client";

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BookingSeedOptions {
  /** Days ahead of today (branch-local) to fill. */
  days?: number;
  /** Probability that a staff member's next free slot gets a booking. */
  fill?: number;
}

/**
 * Fills the next `days` days with fake confirmed bookings for every seeded staff member, following
 * their real working hours, buffers and resource needs. Bookings are generated sequentially per staff
 * and checked per resource, so the exclusion constraint is never violated. Returns the row count.
 * `adminUrl` must be a superuser / BYPASSRLS role; each tenant is written under its own tenant id.
 */
export async function seedBookings(
  adminUrl: string,
  opts: BookingSeedOptions = {},
): Promise<number> {
  const days = opts.days ?? 28;
  const fill = opts.fill ?? 0.7;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: adminUrl, max: 2 }),
  });
  const rand = rng(4242);
  let total = 0;
  try {
    const tenants = await prisma.tenant.findMany({ orderBy: { slug: "asc" } });
    for (const tenant of tenants) {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`select set_config('app.tenant_id', ${tenant.id}, true)`;
          // The admin role bypasses RLS, so every read is filtered by tenant explicitly.
          const scope = { tenantId: tenant.id };
          if ((await tx.booking.count({ where: scope })) > 0) return; // idempotent
          const [branches, services, resources, customers, hours, staffBranches, staffServices] =
            await Promise.all([
              tx.branch.findMany({ where: scope }),
              tx.service.findMany({ where: scope }),
              tx.resource.findMany({ where: scope }),
              tx.customer.findMany({ where: scope }),
              tx.workingHours.findMany({ where: { ...scope, ownerType: "staff" } }),
              tx.staffBranch.findMany({ where: scope }),
              tx.staffService.findMany({ where: scope }),
            ]);
          const bookingRows: Prisma.BookingCreateManyInput[] = [];
          const resRows: { booking: string; resource: string; start: Date; end: Date }[] = [];
          const resBusy = new Map<string, { start: number; end: number }[]>();
          // A staff member can work at two branches: their time must not overlap across them either.
          const staffBusy = new Map<string, { start: number; end: number }[]>();
          const clash = (
            list: { start: number; end: number }[] | undefined,
            occ: { start: number; end: number },
          ) => (list ?? []).some((b) => b.start < occ.end && occ.start < b.end);

          for (const branch of branches) {
            const dates = datesBetween(
              localDate(Date.now(), branch.timezone),
              localDate(Date.now() + days * 86_400_000, branch.timezone),
            );
            for (const sb of staffBranches.filter((x) => x.branchId === branch.id)) {
              const mine = services.filter((s) =>
                staffServices.some((x) => x.staffId === sb.staffId && x.serviceId === s.id),
              );
              const rows = hours
                .filter((h) => h.ownerId === sb.staffId)
                .map((h) => ({
                  weekday: h.weekday,
                  start: h.startLocal.toISOString().slice(11, 16),
                  end: h.endLocal.toISOString().slice(11, 16),
                }));
              if (!mine.length) continue;
              for (const date of dates) {
                for (const w of dayWindows(date, branch.timezone, rows)) {
                  let cursor = w.start;
                  while (cursor < w.end) {
                    if (rand() > fill) {
                      cursor += 15 * MIN * (1 + Math.floor(rand() * 3));
                      continue;
                    }
                    const svc = mine[Math.floor(rand() * mine.length)]!;
                    const occ = occupiedRange(cursor + svc.bufferBeforeMin * MIN, svc);
                    if (occ.end > w.end) break;
                    if (clash(staffBusy.get(sb.staffId), occ)) {
                      cursor += 15 * MIN;
                      continue;
                    }
                    let resourceId: string | null = null;
                    if (svc.requiresResourceType) {
                      const candidates = resources.filter(
                        (r) => r.branchId === branch.id && r.type === svc.requiresResourceType,
                      );
                      const free = candidates.find((r) => !clash(resBusy.get(r.id), occ));
                      if (!free) {
                        cursor += 15 * MIN;
                        continue;
                      }
                      resourceId = free.id;
                      resBusy.set(free.id, [...(resBusy.get(free.id) ?? []), occ]);
                    }
                    staffBusy.set(sb.staffId, [...(staffBusy.get(sb.staffId) ?? []), occ]);
                    const start = cursor + svc.bufferBeforeMin * MIN;
                    const id = randomUUID();
                    bookingRows.push({
                      id,
                      tenantId: tenant.id,
                      branchId: branch.id,
                      customerId: customers[Math.floor(rand() * customers.length)]!.id,
                      serviceId: svc.id,
                      status: "confirmed",
                      startAt: new Date(start),
                      endAt: new Date(start + svc.durationMin * MIN),
                      source: "admin",
                    });
                    resRows.push({
                      booking: id,
                      resource: sb.staffId,
                      start: new Date(occ.start),
                      end: new Date(occ.end),
                    });
                    if (resourceId)
                      resRows.push({
                        booking: id,
                        resource: resourceId,
                        start: new Date(occ.start),
                        end: new Date(occ.end),
                      });
                    cursor = occ.end + 15 * MIN * Math.floor(rand() * 3);
                  }
                }
              }
            }
          }
          for (let i = 0; i < bookingRows.length; i += 2000)
            await tx.booking.createMany({ data: bookingRows.slice(i, i + 2000) });
          for (let i = 0; i < resRows.length; i += 2000) {
            const part = resRows.slice(i, i + 2000);
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO booking_resources (booking_id, resource_id, time_range, status)
              SELECT t.b, t.r, tstzrange(t.s, t.e), 'confirmed'
              FROM unnest(${part.map((p) => p.booking)}::uuid[], ${part.map((p) => p.resource)}::uuid[],
                          ${part.map((p) => p.start.toISOString())}::timestamptz[], ${part.map((p) => p.end.toISOString())}::timestamptz[])
                AS t(b, r, s, e)`);
          }
          total += bookingRows.length;
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    }
  } finally {
    await prisma.$disconnect();
  }
  return total;
}
