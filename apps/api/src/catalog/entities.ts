import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import * as t from "../db/schema";

const uuid = z.string().uuid();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "expected HH:MM");
const timezone = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "invalid IANA timezone");
const ownerType = z.enum(["branch", "staff"]);
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

export interface EntityDef {
  table: PgTable;
  create: z.ZodTypeAny;
  update: z.ZodTypeAny;
  /** property names usable as equality filters on list */
  filters: string[];
  /** property names to order by (id is always appended) */
  orderBy: string[];
}

const branch = z.object({ name: z.string().min(1), timezone, address: z.string().optional() });
const service = z.object({
  name: z.string().min(1),
  durationMin: z.number().int().min(5).max(480),
  bufferBeforeMin: z.number().int().min(0).default(0),
  bufferAfterMin: z.number().int().min(0).default(0),
  priceCents: z.number().int().min(0).default(0),
  cancelWindowHours: z.number().int().min(0).default(24),
  requiresResourceType: z.string().min(1).nullable().optional(),
});
const staff = z.object({
  fullName: z.string().min(1),
  title: z.string().optional(),
  userId: uuid.nullable().optional(),
});
const resource = z.object({ branchId: uuid, type: z.string().min(1), name: z.string().min(1) });
const workingHours = z.object({
  ownerType,
  ownerId: uuid,
  weekday: z.number().int().min(1).max(7),
  startLocal: hhmm,
  endLocal: hhmm,
});
const timeOff = z.object({
  ownerType,
  ownerId: uuid,
  startAt: instant,
  endAt: instant,
  reason: z.string().optional(),
});
const customer = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
});

export const ENTITIES: Record<string, EntityDef> = {
  branches: {
    table: t.branches,
    create: branch,
    update: branch.partial(),
    filters: [],
    orderBy: ["name"],
  },
  services: {
    table: t.services,
    create: service,
    update: service.partial(),
    filters: [],
    orderBy: ["name"],
  },
  staff: {
    table: t.staff,
    create: staff,
    update: staff.partial(),
    filters: [],
    orderBy: ["fullName"],
  },
  resources: {
    table: t.resources,
    create: resource,
    update: resource.partial(),
    filters: ["branchId", "type"],
    orderBy: ["name"],
  },
  "working-hours": {
    table: t.workingHours,
    create: workingHours.refine(
      (v) => v.endLocal > v.startLocal,
      "endLocal must be after startLocal",
    ),
    update: workingHours.partial(),
    filters: ["ownerType", "ownerId", "weekday"],
    orderBy: ["weekday", "startLocal"],
  },
  "time-off": {
    table: t.timeOff,
    create: timeOff.refine((v) => v.endAt > v.startAt, "endAt must be after startAt"),
    update: timeOff.partial(),
    filters: ["ownerType", "ownerId"],
    orderBy: ["startAt"],
  },
  customers: {
    table: t.customers,
    create: customer,
    update: customer.partial(),
    filters: [],
    orderBy: ["fullName"],
  },
};
