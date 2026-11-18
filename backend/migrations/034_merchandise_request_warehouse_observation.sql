ALTER TABLE merchandise_requests
  ADD COLUMN IF NOT EXISTS warehouse_observation text,
  ADD COLUMN IF NOT EXISTS warehouse_observation_by integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS warehouse_observation_at timestamptz;
