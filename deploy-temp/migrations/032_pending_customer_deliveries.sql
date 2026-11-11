-- 032: entregas pendientes con reserva previa de stock.
-- El stock físico solo se descuenta al confirmar la entrega efectiva.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS is_pending_delivery boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_deliveries_pending
  ON deliveries(location_id, created_at DESC)
  WHERE is_pending_delivery = true AND status = 'BORRADOR';
