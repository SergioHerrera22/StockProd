-- 027: Campos para control de retrasos
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_observations text;

ALTER TABLE transfers
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_observations text;
