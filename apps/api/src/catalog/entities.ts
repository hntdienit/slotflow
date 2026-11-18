import { z } from "zod";

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
/** "HH:MM" -> Date on 1970-01-01 UTC: how Prisma represents Postgres `time`. */
const localTime = hhmm.transform((v) => new Date(`1970-01-01T${v.length === 5 ? `${v}:00` : v}Z`));
const uuidFilter = uuid;
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

export interface EntityDef {
  /** Prisma delegate name on the client (e.g. `workingHours`) */
  model: string;
  create: z.ZodTypeAny;
  update: z.ZodTypeAny;
  /** query params usable as equality filters on list, with their validators */
  filters: Record<string, z.ZodTypeAny>;
  /** property names to order by (id is always appended) */
  orderBy: string[];
  /** Postgres `time` columns: Prisma gives Dates, the API speaks "HH:MM" */
  timeFields?: string[];
}

const branch = z.object({ name: z.string().min(1), timezone, address: z.string().optional() });
const service = z.object({
  name: z.string().min(1),
  durationMin: z.number().int().min(5).max(480),
  bufferBeforeMin: z.number().int().min(0).default(0),
  bufferAfterMin: z.number().int().min(0).default(0),
  priceCents: z.number().int().min(0).default(0),
  cancelWindowHours: z.number().int().min(0).default(24),
  lateCancelFeePercent: z.number().int().min(0).max(100).default(50),
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
  startLocal: localTime,
  endLocal: localTime,
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
    model: "branch",
    create: branch,
    update: branch.partial(),
    filters: {},
    orderBy: ["name"],
  },
  services: {
    model: "service",
    create: service,
    update: service.partial(),
    filters: {},
    orderBy: ["name"],
  },
  staff: {
    model: "staff",
    create: staff,
    update: staff.partial(),
    filters: {},
    orderBy: ["fullName"],
  },
  resources: {
    model: "resource",
    create: resource,
    update: resource.partial(),
    filters: { branchId: uuidFilter, type: z.string().min(1) },
    orderBy: ["name"],
  },
  "working-hours": {
    model: "workingHours",
    create: workingHours.refine(
      (v) => v.endLocal > v.startLocal,
      "endLocal must be after startLocal",
    ),
    update: workingHours.partial(),
    filters: { ownerType, ownerId: uuidFilter, weekday: z.coerce.number().int().min(1).max(7) },
    orderBy: ["weekday", "startLocal"],
    timeFields: ["startLocal", "endLocal"],
  },
  "time-off": {
    model: "timeOff",
    create: timeOff.refine((v) => v.endAt > v.startAt, "endAt must be after startAt"),
    update: timeOff.partial(),
    filters: { ownerType, ownerId: uuidFilter },
    orderBy: ["startAt"],
  },
  customers: {
    model: "customer",
    create: customer,
    update: customer.partial(),
    filters: {},
    orderBy: ["fullName"],
  },
};
