-- 026: Asignación directa de chofer a entregas a domicilio y transferencias
-- + geolocalización/dirección para optimización de rutas

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS delivery_type varchar(20) DEFAULT 'LOCAL' CHECK (delivery_type IN ('LOCAL', 'DOMICILIO')),
  ADD COLUMN IF NOT EXISTS customer_name varchar(150),
  ADD COLUMN IF NOT EXISTS customer_phone varchar(40),
  ADD COLUMN IF NOT EXISTS delivery_address varchar(250),
  ADD COLUMN IF NOT EXISTS delivery_lat double precision,
  ADD COLUMN IF NOT EXISTS delivery_lng double precision,
  ADD COLUMN IF NOT EXISTS driver_user_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS driver_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_notes text,
  ADD COLUMN IF NOT EXISTS estimated_delivery_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_deliveries_driver ON deliveries(driver_user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_type ON deliveries(delivery_type);

ALTER TABLE transfers
  ADD COLUMN IF NOT EXISTS driver_user_id integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS driver_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_address varchar(250),
  ADD COLUMN IF NOT EXISTS delivery_lat double precision,
  ADD COLUMN IF NOT EXISTS delivery_lng double precision,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_notes text,
  ADD COLUMN IF NOT EXISTS estimated_delivery_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_transfers_driver ON transfers(driver_user_id);
