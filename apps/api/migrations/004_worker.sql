-- SlotFlow M4: background jobs. The worker handles every tenant, so it needs a role that is not
-- bound by tenant RLS. That role gets narrow grants (no catalog writes, no DDL), not superuser.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'slotflow_worker') THEN
    CREATE ROLE slotflow_worker LOGIN PASSWORD 'slotflow_worker' NOSUPERUSER BYPASSRLS;
  END IF;
END $$;

-- Outbox: failures are counted and eventually parked (dead letter) instead of retried forever.
ALTER TABLE outbox_events
  ADD COLUMN last_error      text,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN dead_at         timestamptz;
DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox_events (seq) WHERE dispatched_at IS NULL AND dead_at IS NULL;

-- Notifications: retry scheduling, a lease so a crashed worker's claim expires, and a cancelled state.
ALTER TABLE notifications
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN locked_until    timestamptz;
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('pending','sent','failed','dead','cancelled'));
CREATE INDEX notifications_due_idx ON notifications (scheduled_for) WHERE status IN ('pending','failed');
CREATE INDEX notifications_booking_idx ON notifications (booking_id);

-- SMS is a mock channel: "sending" writes a row here.
CREATE TABLE sms_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id) ON DELETE CASCADE,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  to_phone        text NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id)
);
ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sms_messages USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT ON sms_messages TO slotflow_app;

GRANT USAGE ON SCHEMA public TO slotflow_worker;
GRANT SELECT ON tenants, branches, services, customers, staff TO slotflow_worker;
GRANT SELECT, UPDATE ON bookings TO slotflow_worker;
GRANT SELECT, UPDATE ON booking_resources TO slotflow_worker;
GRANT SELECT, INSERT ON booking_events TO slotflow_worker;
GRANT SELECT, INSERT, UPDATE ON outbox_events, notifications TO slotflow_worker;
GRANT SELECT, INSERT ON sms_messages TO slotflow_worker;
GRANT USAGE ON SEQUENCE outbox_events_seq_seq TO slotflow_worker;
