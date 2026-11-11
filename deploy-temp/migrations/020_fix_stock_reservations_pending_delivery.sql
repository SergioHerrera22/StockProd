-- 020: permitir reservas genericas sin orden pendiente.
--
-- Sintoma: al confirmar una ENTREGA (y cualquier operacion que reserve stock
-- con reserve_stock()), PostgreSQL devolvia
--   23502 null value in column "pending_delivery_id" of relation "stock_reservations"
-- y toda la transaccion se revertia.
--
-- Causa: la migracion 004 ya hace DROP NOT NULL, pero en esta base la columna
-- seguia siendo NOT NULL (drift: el archivo se corrigio despues de aplicarse y
-- el runner saltea las migraciones ya registradas).
--
-- Las reservas ahora son genericas (reference_type + reference_id): la orden
-- pendiente es opcional. Idempotente.

ALTER TABLE IF EXISTS stock_reservations
  ALTER COLUMN pending_delivery_id DROP NOT NULL;

-- Refuerzo del indice usado por reserve_stock/consume_reservation.
CREATE INDEX IF NOT EXISTS idx_reservations_reference
  ON stock_reservations (reference_type, reference_id);

CREATE INDEX IF NOT EXISTS idx_reservations_product_loc_status
  ON stock_reservations (product_id, source_location_id, status);
