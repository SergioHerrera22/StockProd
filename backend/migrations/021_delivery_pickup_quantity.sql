-- =============================================================================
-- 021 · Retiro en la MISMA sucursal de venta
--
-- Hasta ahora una entrega solo generaba orden de retiro para los faltantes
-- derivados a OTRA sucursal. Ahora el vendedor puede dejar parte (o todo) de
-- una línea para que el cliente la retire después en la misma sucursal donde
-- compró:
--   * delivery_items.pickup_quantity = unidades de la línea que NO salen ahora
--     y quedan reservadas en la sucursal de venta (retiro posterior).
--   * La orden pendiente se crea con pickup_location_id = sale_location_id
--     (antes el service lo rechazaba).
-- =============================================================================

ALTER TABLE delivery_items
  ADD COLUMN IF NOT EXISTS pickup_quantity numeric(14,3) NOT NULL DEFAULT 0;

-- La cantidad para retiro nunca puede superar lo cargado en la línea.
ALTER TABLE delivery_items DROP CONSTRAINT IF EXISTS delivery_items_pickup_quantity_check;
ALTER TABLE delivery_items
  ADD CONSTRAINT delivery_items_pickup_quantity_check
  CHECK (pickup_quantity >= 0 AND pickup_quantity <= quantity);
