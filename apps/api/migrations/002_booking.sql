-- SlotFlow M1: booking-side schema. Behaviour (hold, confirm, reschedule...) arrives in M3-M5.

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id        uuid NOT NULL,
  customer_id      uuid NOT NULL,
  service_id       uuid NOT NULL,
  status           text NOT NULL CHECK (status IN
                     ('held','confirmed','checked_in','completed','cancelled','no_show','expired')),
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  hold_expires_at  timestamptz,
  idempotency_key  text,
  source           text NOT NULL DEFAULT 'web' CHECK (source IN ('web','ai','admin')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id)   REFERENCES branches(id, tenant_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id),
  FOREIGN KEY (service_id, tenant_id)  REFERENCES services(id, tenant_id)
);
CREATE UNIQUE INDEX bookings_idempotency_uq ON bookings (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX bookings_branch_start_idx ON bookings (branch_id, start_at);
CREATE INDEX bookings_hold_expiry_idx ON bookings (hold_expires_at) WHERE status = 'held';

-- One row per occupied resource (staff member or room). The exclusion constraint is the last line of
-- defence against double booking (ADR-002): it holds no matter which code path writes.
CREATE TABLE booking_resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL,
  resource_id uuid NOT NULL,                 -- staff.id or resources.id (UUIDs never collide)
  time_range  tstzrange NOT NULL,            -- includes buffers
  status      text NOT NULL CHECK (status IN ('held','confirmed','expired','released','cancelled')),
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT booking_resources_no_overlap
    EXCLUDE USING gist (resource_id WITH =, time_range WITH &&)
    WHERE (status IN ('held','confirmed'))
);
CREATE INDEX booking_resources_booking_idx ON booking_resources (booking_id);

CREATE TABLE booking_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  actor       text,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX booking_events_booking_idx ON booking_events (booking_id, created_at);

CREATE TABLE waitlist_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id    uuid NOT NULL,
  service_id   uuid NOT NULL,
  customer_id  uuid NOT NULL,
  staff_id     uuid,
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','booked','expired','cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id)   REFERENCES branches(id, tenant_id),
  FOREIGN KEY (service_id, tenant_id)  REFERENCES services(id, tenant_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id)
);
CREATE INDEX waitlist_entries_queue_idx ON waitlist_entries (branch_id, service_id, created_at) WHERE status = 'waiting';

CREATE TABLE waitlist_offers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id   uuid NOT NULL,
  booking_id uuid NOT NULL,                  -- the hold created for this offer
  expires_at timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','expired','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (entry_id, tenant_id)   REFERENCES waitlist_entries(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings(id, tenant_id) ON DELETE CASCADE
);
-- A released slot gets at most one open offer (idempotent waitlist-offer worker).
CREATE UNIQUE INDEX waitlist_offers_one_open_per_hold ON waitlist_offers (booking_id) WHERE status = 'open';

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id    uuid,
  type          text NOT NULL,               -- reminder_24h | reminder_2h | waitlist_offer ...
  channel       text NOT NULL CHECK (channel IN ('email','sms')),
  dedupe_key    text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts      int  NOT NULL DEFAULT 0,
  last_error    text,
  payload       jsonb NOT NULL DEFAULT '{}',
  scheduled_for timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE TABLE outbox_events (
  seq           bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events (seq) WHERE dispatched_at IS NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['bookings','booking_resources','booking_events','waitlist_entries',
    'waitlist_offers','notifications','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON bookings, booking_resources, booking_events, waitlist_entries,
  waitlist_offers, notifications, outbox_events TO slotflow_app;
GRANT USAGE ON SEQUENCE outbox_events_seq_seq TO slotflow_app;
