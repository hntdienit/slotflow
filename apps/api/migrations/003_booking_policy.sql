-- SlotFlow M3: cancellation policy fee, idempotency payload hash, cancellation record.
ALTER TABLE services
  ADD COLUMN late_cancel_fee_percent int NOT NULL DEFAULT 50
  CHECK (late_cancel_fee_percent BETWEEN 0 AND 100);

ALTER TABLE bookings
  ADD COLUMN request_hash          text,         -- same Idempotency-Key + different payload => 422
  ADD COLUMN cancelled_at          timestamptz,
  ADD COLUMN cancellation_fee_cents int;
