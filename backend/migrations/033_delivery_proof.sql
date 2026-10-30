-- 033: constancia auditable de entrega a domicilio.
-- No altera movimientos de stock: registra únicamente la recepción física por el cliente.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS delivered_to varchar(150),
  ADD COLUMN IF NOT EXISTS delivery_proof_notes varchar(1000),
  ADD COLUMN IF NOT EXISTS delivered_by integer REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_deliveries_delivered_at
  ON deliveries(delivered_at DESC)
  WHERE delivered_at IS NOT NULL;
