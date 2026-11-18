ALTER TABLE merchandise_request_items
  ADD COLUMN IF NOT EXISTS quantity_missing numeric(14,3) NOT NULL DEFAULT 0;

ALTER TABLE merchandise_request_items
  DROP CONSTRAINT IF EXISTS merchandise_request_missing_le_requested;

ALTER TABLE merchandise_request_items
  ADD CONSTRAINT merchandise_request_missing_le_requested
  CHECK (quantity_missing >= 0 AND quantity_missing <= quantity_requested);
