-- 028: Tabla para asignaciones de chofer (panel dedicado)
CREATE TABLE IF NOT EXISTS driver_assignments (
  id serial PRIMARY KEY,
  assignment_type varchar(20) NOT NULL CHECK (assignment_type IN ('DELIVERY', 'TRANSFER')),
  delivery_id integer REFERENCES deliveries(id),
  transfer_id integer REFERENCES transfers(id),
  driver_user_id integer NOT NULL REFERENCES users(id),
  status varchar(20) NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE', 'EN_CURSO', 'COMPLETADO', 'CANCELADO')),
  address varchar(250),
  lat double precision,
  lng double precision,
  customer_name varchar(150),
  notes text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_by integer REFERENCES users(id),
  CONSTRAINT chk_driver_assignment_ref CHECK (
    (assignment_type = 'DELIVERY' AND delivery_id IS NOT NULL AND transfer_id IS NULL) OR
    (assignment_type = 'TRANSFER' AND transfer_id IS NOT NULL AND delivery_id IS NULL)
  ),
  UNIQUE (assignment_type, delivery_id, transfer_id, driver_user_id)
);

CREATE INDEX IF NOT EXISTS idx_driver_assignments_driver ON driver_assignments(driver_user_id, status);
CREATE INDEX IF NOT EXISTS idx_driver_assignments_delivery ON driver_assignments(delivery_id);
CREATE INDEX IF NOT EXISTS idx_driver_assignments_transfer ON driver_assignments(transfer_id);
