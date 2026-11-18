/**
 * Drizzle schema = typed view of the database. The DDL source of truth is `migrations/*.sql`
 * (RLS policies, exclusion constraints, partial indexes and composite FKs are not expressible in
 * Drizzle). `schema-drift.int.test.ts` fails if this file and the migrated database disagree.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .default(sql`app_tenant_id()`);
const pk = () => uuid("id").primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts("created_at").notNull().defaultNow();

/** Postgres tstzrange, surfaced as its text form, e.g. `["2026-12-01 09:00+00","2026-12-01 09:30+00")`. */
export const tstzrange = customType<{ data: string }>({ dataType: () => "tstzrange" });

export const tenants = pgTable("tenants", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: pk(),
  tenantId: tenantId(),
  email: text("email").notNull(),
  role: text("role", { enum: ["owner", "manager", "staff", "customer"] }).notNull(),
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

export const branches = pgTable("branches", {
  id: pk(),
  tenantId: tenantId(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  address: text("address"),
  createdAt: createdAt(),
});

export const managerBranches = pgTable(
  "manager_branches",
  {
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    branchId: uuid("branch_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.branchId] })],
);

export const staff = pgTable("staff", {
  id: pk(),
  tenantId: tenantId(),
  userId: uuid("user_id"),
  fullName: text("full_name").notNull(),
  title: text("title"),
  createdAt: createdAt(),
});

export const services = pgTable("services", {
  id: pk(),
  tenantId: tenantId(),
  name: text("name").notNull(),
  durationMin: integer("duration_min").notNull(),
  bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
  bufferAfterMin: integer("buffer_after_min").notNull().default(0),
  priceCents: integer("price_cents").notNull().default(0),
  cancelWindowHours: integer("cancel_window_hours").notNull().default(24),
  requiresResourceType: text("requires_resource_type"),
  createdAt: createdAt(),
});

export const staffBranches = pgTable(
  "staff_branches",
  {
    tenantId: tenantId(),
    staffId: uuid("staff_id").notNull(),
    branchId: uuid("branch_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.branchId] })],
);

export const staffServices = pgTable(
  "staff_services",
  {
    tenantId: tenantId(),
    staffId: uuid("staff_id").notNull(),
    serviceId: uuid("service_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.serviceId] })],
);

export const resources = pgTable("resources", {
  id: pk(),
  tenantId: tenantId(),
  branchId: uuid("branch_id").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const workingHours = pgTable("working_hours", {
  id: pk(),
  tenantId: tenantId(),
  ownerType: text("owner_type", { enum: ["branch", "staff"] }).notNull(),
  ownerId: uuid("owner_id").notNull(),
  weekday: smallint("weekday").notNull(),
  startLocal: time("start_local").notNull(),
  endLocal: time("end_local").notNull(),
});

// `range` (generated tstzrange) is intentionally not mapped; availability queries use raw SQL on it.
export const timeOff = pgTable("time_off", {
  id: pk(),
  tenantId: tenantId(),
  ownerType: text("owner_type", { enum: ["branch", "staff"] }).notNull(),
  ownerId: uuid("owner_id").notNull(),
  startAt: ts("start_at").notNull(),
  endAt: ts("end_at").notNull(),
  reason: text("reason"),
});

export const customers = pgTable("customers", {
  id: pk(),
  tenantId: tenantId(),
  userId: uuid("user_id"),
  fullName: text("full_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  createdAt: createdAt(),
});

export const BOOKING_STATUSES = [
  "held",
  "confirmed",
  "checked_in",
  "completed",
  "cancelled",
  "no_show",
  "expired",
] as const;

export const bookings = pgTable("bookings", {
  id: pk(),
  tenantId: tenantId(),
  branchId: uuid("branch_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  serviceId: uuid("service_id").notNull(),
  status: text("status", { enum: BOOKING_STATUSES }).notNull(),
  startAt: ts("start_at").notNull(),
  endAt: ts("end_at").notNull(),
  holdExpiresAt: ts("hold_expires_at"),
  idempotencyKey: text("idempotency_key"),
  source: text("source", { enum: ["web", "ai", "admin"] })
    .notNull()
    .default("web"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const bookingResources = pgTable("booking_resources", {
  id: pk(),
  tenantId: tenantId(),
  bookingId: uuid("booking_id").notNull(),
  resourceId: uuid("resource_id").notNull(),
  timeRange: tstzrange("time_range").notNull(),
  status: text("status", {
    enum: ["held", "confirmed", "expired", "released", "cancelled"],
  }).notNull(),
});

export const bookingEvents = pgTable("booking_events", {
  id: pk(),
  tenantId: tenantId(),
  bookingId: uuid("booking_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actor: text("actor"),
  payload: jsonb("payload").notNull().default({}),
  createdAt: createdAt(),
});

export const waitlistEntries = pgTable("waitlist_entries", {
  id: pk(),
  tenantId: tenantId(),
  branchId: uuid("branch_id").notNull(),
  serviceId: uuid("service_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  staffId: uuid("staff_id"),
  windowStart: ts("window_start").notNull(),
  windowEnd: ts("window_end").notNull(),
  status: text("status", { enum: ["waiting", "offered", "booked", "expired", "cancelled"] })
    .notNull()
    .default("waiting"),
  createdAt: createdAt(),
});

export const waitlistOffers = pgTable("waitlist_offers", {
  id: pk(),
  tenantId: tenantId(),
  entryId: uuid("entry_id").notNull(),
  bookingId: uuid("booking_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: text("status", { enum: ["open", "accepted", "expired", "declined"] })
    .notNull()
    .default("open"),
  createdAt: createdAt(),
});

export const notifications = pgTable("notifications", {
  id: pk(),
  tenantId: tenantId(),
  bookingId: uuid("booking_id"),
  type: text("type").notNull(),
  channel: text("channel", { enum: ["email", "sms"] }).notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status", { enum: ["pending", "sent", "failed", "dead"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  payload: jsonb("payload").notNull().default({}),
  scheduledFor: ts("scheduled_for"),
  sentAt: ts("sent_at"),
  createdAt: createdAt(),
});

export const outboxEvents = pgTable("outbox_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  tenantId: tenantId(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: createdAt(),
  dispatchedAt: ts("dispatched_at"),
});
