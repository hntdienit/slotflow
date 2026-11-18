-- SlotFlow M4b: notifications are delivered through SQS. `enqueued_at` records that a due-soon
-- notification has been put on the queue (with a delay), so it is enqueued once per (re)schedule.
ALTER TABLE notifications ADD COLUMN enqueued_at timestamptz;
CREATE INDEX notifications_enqueue_idx ON notifications (scheduled_for) WHERE status IN ('pending','failed');
