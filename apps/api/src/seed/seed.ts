import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../db/schema";
import {
  branches,
  customers,
  resources,
  services,
  staff,
  staffBranches,
  staffServices,
  tenants,
  workingHours,
} from "../db/schema";

/** Deterministic PRNG so the seed is reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HO = [
  "Nguyễn",
  "Trần",
  "Lê",
  "Phạm",
  "Hoàng",
  "Huỳnh",
  "Phan",
  "Vũ",
  "Võ",
  "Đặng",
  "Bùi",
  "Đỗ",
];
const DEM = ["Văn", "Thị", "Minh", "Quốc", "Ngọc", "Hữu", "Thanh", "Anh", "Gia", "Khánh"];
const TEN = [
  "An",
  "Bình",
  "Chi",
  "Dũng",
  "Giang",
  "Hà",
  "Khoa",
  "Lan",
  "Linh",
  "Nam",
  "Phúc",
  "Quân",
  "Sơn",
  "Trang",
  "Vy",
  "Yến",
];

interface ServiceDef {
  name: string;
  dur: number;
  before?: number;
  after?: number;
  price: number;
  resource?: string;
}
interface BranchDef {
  name: string;
  tz: string;
  address: string;
}
interface TenantDef {
  name: string;
  slug: string;
  branches: BranchDef[];
  services: ServiceDef[];
  resources: { type: string; name: string }[];
  titles: string[];
}

export const TENANTS: TenantDef[] = [
  {
    name: "Phòng khám Đa khoa An Tâm",
    slug: "an-tam-clinic",
    branches: [
      { name: "An Tâm Quận 1", tz: "Asia/Ho_Chi_Minh", address: "12 Nguyễn Huệ, Quận 1, TP.HCM" },
      {
        name: "An Tâm Cầu Giấy",
        tz: "Asia/Ho_Chi_Minh",
        address: "88 Xuân Thủy, Cầu Giấy, Hà Nội",
      },
    ],
    services: [
      { name: "Khám tổng quát", dur: 30, after: 5, price: 20000000 },
      { name: "Khám nhi", dur: 30, after: 5, price: 18000000 },
      { name: "Siêu âm", dur: 20, after: 10, price: 25000000, resource: "ultrasound" },
      { name: "Xét nghiệm máu", dur: 15, price: 15000000 },
      { name: "Tư vấn dinh dưỡng", dur: 45, price: 22000000 },
    ],
    resources: [
      { type: "room", name: "Phòng khám 1" },
      { type: "room", name: "Phòng khám 2" },
      { type: "ultrasound", name: "Máy siêu âm" },
    ],
    titles: ["Bác sĩ", "Bác sĩ", "Điều dưỡng", "Kỹ thuật viên"],
  },
  {
    name: "Nha khoa Nụ Cười",
    slug: "nu-cuoi-dental",
    branches: [
      {
        name: "Nụ Cười Quận 7",
        tz: "Asia/Ho_Chi_Minh",
        address: "25 Nguyễn Thị Thập, Quận 7, TP.HCM",
      },
      {
        name: "Nụ Cười Hải Châu",
        tz: "Asia/Ho_Chi_Minh",
        address: "40 Bạch Đằng, Hải Châu, Đà Nẵng",
      },
    ],
    services: [
      { name: "Khám răng", dur: 30, price: 10000000 },
      { name: "Lấy cao răng", dur: 45, after: 10, price: 30000000, resource: "dental_chair" },
      {
        name: "Trám răng",
        dur: 60,
        before: 5,
        after: 10,
        price: 50000000,
        resource: "dental_chair",
      },
      { name: "Nhổ răng", dur: 45, after: 15, price: 60000000, resource: "dental_chair" },
      { name: "Tư vấn niềng răng", dur: 30, price: 0 },
    ],
    resources: [
      { type: "dental_chair", name: "Ghế nha 1" },
      { type: "dental_chair", name: "Ghế nha 2" },
      { type: "dental_chair", name: "Ghế nha 3" },
    ],
    titles: ["Nha sĩ", "Nha sĩ", "Trợ thủ nha khoa"],
  },
  {
    name: "Sydney Viet Family Clinic",
    slug: "sydney-viet-clinic",
    branches: [
      { name: "Sydney CBD", tz: "Australia/Sydney", address: "100 George St, Sydney NSW" },
      { name: "Parramatta", tz: "Australia/Sydney", address: "15 Church St, Parramatta NSW" },
    ],
    services: [
      { name: "General consultation", dur: 20, after: 5, price: 8000 },
      { name: "Vaccination", dur: 15, after: 5, price: 5000 },
      { name: "Health check", dur: 40, after: 10, price: 12000 },
      { name: "Women's health", dur: 30, after: 5, price: 9000 },
      { name: "Skin check", dur: 25, after: 5, price: 9500 },
    ],
    resources: [
      { type: "room", name: "Consulting room 1" },
      { type: "room", name: "Consulting room 2" },
    ],
    titles: ["GP", "GP", "Nurse"],
  },
];

export interface SeedSummary {
  created: string[];
  skipped: string[];
}

/**
 * Seeds fake clinic data. `adminUrl` must be a superuser / BYPASSRLS role (needed to read tenants
 * before knowing their ids), but each tenant is still written under its own app.tenant_id.
 */
export async function seed(adminUrl: string): Promise<SeedSummary> {
  const summary: SeedSummary = { created: [], skipped: [] };
  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const db = drizzle(pool, { schema });
  try {
    for (const [idx, def] of TENANTS.entries()) {
      const exists = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, def.slug));
      if (exists.length) {
        summary.skipped.push(def.slug);
        continue;
      }
      await seedTenant(db, def, rng(1000 + idx));
      summary.created.push(def.slug);
    }
  } finally {
    await pool.end();
  }
  return summary;
}

async function seedTenant(
  db: ReturnType<typeof drizzle<typeof schema>>,
  def: TenantDef,
  rand: () => number,
) {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  const tenantId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.insert(tenants).values({ id: tenantId, name: def.name, slug: def.slug });

    const branchIds: string[] = [];
    for (const b of def.branches) {
      const [row] = await tx
        .insert(branches)
        .values({ name: b.name, timezone: b.tz, address: b.address })
        .returning({ id: branches.id });
      const id = row!.id;
      branchIds.push(id);
      // Branch opening hours (local time): Mon-Fri 08:00-17:00, Sat 08:00-12:00.
      await tx
        .insert(workingHours)
        .values([
          ...[1, 2, 3, 4, 5].map((weekday) => ({
            ownerType: "branch" as const,
            ownerId: id,
            weekday,
            startLocal: "08:00",
            endLocal: "17:00",
          })),
          {
            ownerType: "branch" as const,
            ownerId: id,
            weekday: 6,
            startLocal: "08:00",
            endLocal: "12:00",
          },
        ]);
      await tx
        .insert(resources)
        .values(def.resources.map((r) => ({ branchId: id, type: r.type, name: r.name })));
    }

    const serviceRows = await tx
      .insert(services)
      .values(
        def.services.map((s) => ({
          name: s.name,
          durationMin: s.dur,
          bufferBeforeMin: s.before ?? 0,
          bufferAfterMin: s.after ?? 0,
          priceCents: s.price,
          cancelWindowHours: 24,
          requiresResourceType: s.resource ?? null,
        })),
      )
      .returning({ id: services.id });
    const serviceIds = serviceRows.map((r) => r.id);

    // 10 staff per tenant: first 5 at branch 0, next 4 at branch 1, the last one floats across both.
    for (let i = 0; i < 10; i++) {
      const [row] = await tx
        .insert(staff)
        .values({
          fullName: `${pick(HO)} ${pick(DEM)} ${pick(TEN)}`,
          title: def.titles[i % def.titles.length]!,
        })
        .returning({ id: staff.id });
      const staffId = row!.id;
      const home = i < 5 ? [branchIds[0]!] : i < 9 ? [branchIds[1]!] : branchIds;
      await tx.insert(staffBranches).values(home.map((branchId) => ({ staffId, branchId })));
      const svc = [...new Set([0, 1, 2].map((k) => serviceIds[(i + k) % serviceIds.length]!))];
      await tx.insert(staffServices).values(svc.map((serviceId) => ({ staffId, serviceId })));
      // Staff schedule: Mon-Fri with a 12:00-13:00 lunch break (two intervals per day).
      await tx.insert(workingHours).values(
        [1, 2, 3, 4, 5].flatMap((weekday) => [
          {
            ownerType: "staff" as const,
            ownerId: staffId,
            weekday,
            startLocal: "08:00",
            endLocal: "12:00",
          },
          {
            ownerType: "staff" as const,
            ownerId: staffId,
            weekday,
            startLocal: "13:00",
            endLocal: "17:00",
          },
        ]),
      );
    }

    await tx.insert(customers).values(
      Array.from({ length: 20 }, (_, i) => ({
        fullName: `${pick(HO)} ${pick(DEM)} ${pick(TEN)}`,
        email: `khach${i + 1}@${def.slug}.example`,
        phone: `09${String(10000000 + Math.floor(rand() * 89999999))}`,
      })),
    );
  });
}
