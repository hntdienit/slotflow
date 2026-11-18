-- SlotFlow M5: waitlist. Holds created for offers carry source 'waitlist'; an entry can have at most one open offer.
ALTER TABLE bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_source_check CHECK (source IN ('web','ai','admin','waitlist'));

CREATE UNIQUE INDEX waitlist_offers_one_open_per_entry ON waitlist_offers (entry_id) WHERE status = 'open';
CREATE INDEX waitlist_entries_match_idx ON waitlist_entries (branch_id, created_at) WHERE status = 'waiting';
CREATE INDEX waitlist_offers_booking_idx ON waitlist_offers (booking_id);

-- The worker reads offers to notify customers and expires entries whose window has passed.
GRANT SELECT ON waitlist_offers TO slotflow_worker;
GRANT SELECT, UPDATE ON waitlist_entries TO slotflow_worker;
