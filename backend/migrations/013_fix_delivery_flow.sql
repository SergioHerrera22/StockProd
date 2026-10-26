-- ============================================================
-- Migracion 012: Correcciones del flujo de entregas
-- ============================================================
-- Corrige tres gaps del flujo de entregas / retiros pendientes:
--
--   1) check_multi_location_availability() usaba la CANTIDAD TOTAL
--      (sb.quantity) en vez del DISPONIBLE REAL (quantity - reserved_quantity).
--      Eso hacia que las derivaciones se calculen con stock que ya estaba
--      reservado por otra orden y la confirmacion rompiera con 409
--      ("Stock insuficiente") aunque se pudiera entregar y derivar.
--
--   2) El estado PARCIAL de las ordenes pendientes no existia en el enum:
--      un retiro parcial marcaba la orden como ENTREGADO y dejaba el resto
--      de las reservas bloqueadas sin forma de retirarse.
--
--   3) Las reservas con expires_at vencido no se limpiaban nunca (no habia
--      job ni cron), y la orden pendiente quedaba "viva" con el stock
--      bloqueado para siempre. Se agrega una funcion que cancela
--      automaticamente las ordenes pendientes vencidas luego del cleanup
--      (que debe ejecutarse antes, ver backend/src/jobs/scheduler.ts).

-- ---------- 1. Nuevo estado PARCIAL para ordenes pendientes ----------
ALTER TYPE pending_delivery_status ADD VALUE IF NOT EXISTS 'PARCIAL';

-- ---------- 2. Disponibilidad con DESCONTO de reservas ----------
-- saleLocationQty y otherLocations.availableQty ahora devuelven el
-- DISPONIBLE (quantity - reserved_quantity), no la cantidad bruta.
-- Las reservas ACTIVA/PARCIAL sin expirar o aun no expiradas cuentan;
-- las LIBERADAS/CONSUMIDAS no (van fuera via reserved_quantity, que el
-- trigger de la 004 recalcula sumando solo ACTIVA/PARCIAL).
DROP FUNCTION IF EXISTS check_multi_location_availability(integer[], integer, numeric(14,3)[]);
CREATE FUNCTION check_multi_location_availability(
  p_product_ids integer[],
  p_sale_location_id integer,
  p_qty_requested numeric(14,3)[]
) RETURNS TABLE (
  "productId" integer,
  "productCode" varchar(40),
  "productName" varchar(200),
  "saleLocationQty" numeric(14,3),
  "otherLocations" jsonb,
  "totalAvailable" numeric(14,3),
  "canFulfill" boolean
) AS $$
DECLARE
  i int;
BEGIN
  FOR i IN 1..array_length(p_product_ids, 1) LOOP
    RETURN QUERY
    SELECT
      p.id AS "productId",
      p.code AS "productCode",
      p.name AS "productName",
      COALESCE(sb_sale.quantity - sb_sale.reserved_quantity, 0) AS "saleLocationQty",
      (
        SELECT jsonb_agg(jsonb_build_object(
          'locationId', l.id,
          'locationCode', l.code,
          'locationName', l.name,
          'availableQty', sb.quantity - sb.reserved_quantity
        ) ORDER BY (sb.quantity - sb.reserved_quantity) DESC)
        FROM stock_balances sb
        JOIN locations l ON l.id = sb.location_id
        WHERE sb.product_id = p.id
          AND sb.location_id <> p_sale_location_id
          AND (sb.quantity - sb.reserved_quantity) > 0
          AND l.is_active = true
      ) AS "otherLocations",
      (
        COALESCE(sb_sale.quantity - sb_sale.reserved_quantity, 0) +
        COALESCE((
          SELECT sum(sb2.quantity - sb2.reserved_quantity)
          FROM stock_balances sb2
          JOIN locations l2 ON l2.id = sb2.location_id
          WHERE sb2.product_id = p.id
            AND sb2.location_id <> p_sale_location_id
            AND l2.is_active = true
        ), 0)
      ) AS "totalAvailable",
      (
        COALESCE(sb_sale.quantity - sb_sale.reserved_quantity, 0) +
        COALESCE((
          SELECT sum(sb2.quantity - sb2.reserved_quantity)
          FROM stock_balances sb2
          JOIN locations l2 ON l2.id = sb2.location_id
          WHERE sb2.product_id = p.id
            AND sb2.location_id <> p_sale_location_id
            AND l2.is_active = true
        ), 0)
      ) >= p_qty_requested[i] AS "canFulfill"
    FROM products p
    LEFT JOIN stock_balances sb_sale ON sb_sale.product_id = p.id AND sb_sale.location_id = p_sale_location_id
    WHERE p.id = p_product_ids[i];
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ---------- 3. Auto-cancelacion de ordenes pendientes vencidas ----------
-- Se ejecuta DESPUES de cleanup_expired_reservations() (las reservas expiradas
-- ya quedan LIBERADAS y descontadas de reserved_quantity). Cancela las ordenes
-- pendientes que:
--   - estan activas (PENDIENTE / EN_PREPARACION / LISTO_RETIRO)
--   - tienen mas de 48h
--   - NO tienen ninguna reserva vigente (todas expiraron/liberaron o consumieron)
-- Las ordenes con al menos una reserva vigente se dejan en paz.
CREATE OR REPLACE FUNCTION auto_cancel_expired_pending_deliveries(
  p_cancelled_by integer DEFAULT NULL
) RETURNS TABLE (
  cancelled_count integer,
  message text
) AS $$
DECLARE
  v_count integer := 0;
  v_row record;
BEGIN
  FOR v_row IN
    SELECT pd.id, pd.number,
           COALESCE((SELECT SUM(pdi.quantity_delivered) FROM pending_delivery_items pdi WHERE pdi.pending_delivery_id = pd.id), 0) AS delivered_qty
    FROM pending_deliveries pd
    WHERE pd.status IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL')
      AND pd.created_at < now() - interval '48 hours'
      -- No quedan reservas vigentes (sin expirar) para esta orden
      AND NOT EXISTS (
        SELECT 1 FROM stock_reservations sr
        WHERE sr.pending_delivery_id = pd.id
          AND sr.status IN ('ACTIVA', 'PARCIAL')
          AND (sr.expires_at IS NULL OR sr.expires_at >= now())
      )
  LOOP
    UPDATE pending_deliveries
    SET status = 'CANCELADO',
        cancelled_by = COALESCE(p_cancelled_by, cancelled_by),
        cancelled_at = now(),
        cancel_reason = COALESCE(cancel_reason, 'Expiracion automatica (48hs sin retiro)'),
        updated_at = now()
    WHERE id = v_row.id
      AND status IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL');

    IF FOUND THEN
      v_count := v_count + 1;
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details)
      VALUES (
        COALESCE(p_cancelled_by, NULL),
        'PENDING_DELIVERY_AUTO_CANCEL',
        'pending_delivery',
        v_row.id,
        jsonb_build_object(
          'number', v_row.number,
          'reason', 'Expiracion automatica 48h',
          'previouslyDeliveredQty', v_row.delivered_qty
        )
      );
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_count,
    format('%s ordenes pendientes vencidas canceladas', v_count)::text;
END;
$$ LANGUAGE plpgsql;

-- ---------- 4. delivery_items.quantity_delivered ----------
-- Guarda lo EFECTIVAMENTE entregado de cada item al confirmar la entrega.
-- Necesario porque la reposicion por anulacion y el comprobante impreso
-- dependen de este valor: antes se usaba la cantidad cargada original, por lo
-- que (a) el comprobante imprimia "Entregado X" aunque solo salieron Y unidades
-- y (b) anular una entrega parcial devolvia al stock unidades que nunca salieron.
ALTER TABLE delivery_items
  ADD COLUMN IF NOT EXISTS quantity_delivered numeric(14,3) NOT NULL DEFAULT 0;

-- Backfill de datos existentes:
--   CONFIRMADO (legado): se entrego lo cargado.
--   PARCIAL (legado): se entrego lo cargado menos lo que quedo prometido en
--     las ordenes de retiro derivadas (best-effort; no hay mejor dato historico).
UPDATE delivery_items di
SET quantity_delivered = di.quantity
FROM deliveries d
WHERE d.id = di.delivery_id AND d.status = 'CONFIRMADO';

UPDATE delivery_items di
SET quantity_delivered = GREATEST(0, di.quantity - COALESCE((
      SELECT SUM(pdi.quantity_requested)
      FROM pending_delivery_items pdi
      JOIN pending_deliveries pd ON pd.id = pdi.pending_delivery_id
      WHERE pd.delivery_id = di.delivery_id
    ), 0))
FROM deliveries d
WHERE d.id = di.delivery_id AND d.status = 'PARCIAL';
