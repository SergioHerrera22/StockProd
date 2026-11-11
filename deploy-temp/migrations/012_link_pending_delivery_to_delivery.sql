-- ============================================================
-- Migracion 012: enlace entre entrega y orden de retiro derivada
-- ============================================================
-- Cuando una entrega queda PARCIAL porque parte del stock se deriva a otra
-- sucursal, se crea una orden de retiro (pending_deliveries). Pero no existia
-- ningun enlace formal entre ambas: el unico rastro era el texto de `notes`
-- ("Faltante de entrega E-000091"), que no sirve para consultas confiables.
--
-- Consecuencia: al ANULAR una entrega PARCIAL, la orden de retiro quedaba
-- viva y el cliente podia retirar mercaderia de una entrega ya anulada, con
-- las reservas de la sucursal de retiro todavia activas.
--
-- Fix: columna nullable delivery_id con FK. Se puebla al crear la orden desde
-- la confirmacion de una entrega; las ordenes creadas a mano quedan en NULL.

ALTER TABLE pending_deliveries
  ADD COLUMN IF NOT EXISTS delivery_id integer REFERENCES deliveries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pending_deliveries_delivery
  ON pending_deliveries(delivery_id)
  WHERE delivery_id IS NOT NULL;
