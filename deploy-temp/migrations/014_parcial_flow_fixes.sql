-- 014: Correcciones de flujo PARCIAL y de integridad de stock.
-- Alinea las funciones PL/pgSQL con los arreglos del backend:
--   * auto_cancel_expired_pending_deliveries: las ordenes PARCIAL (cliente
--     retiro parte y el resto vencio) tambien se cancelan automaticamente;
--     antes quedaban zombie abiertas para siempre.
--   * cleanup_expired_reservations: por simetria, ya cubre ACTIVA/PARCIAL
--     (se verifica; si cambia, revisar 009/011).

CREATE OR REPLACE FUNCTION auto_cancel_expired_pending_deliveries(
  p_cancelled_by integer DEFAULT NULL
) RETURNS TABLE (cancelled_count integer, message text) AS $$
DECLARE
  v_count integer := 0;
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT pd.id, pd.number,
           COALESCE((SELECT SUM(pdi.quantity_delivered) FROM pending_delivery_items pdi WHERE pdi.pending_delivery_id = pd.id), 0) AS delivered_qty
    FROM pending_deliveries pd
    WHERE pd.status IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL')
      AND pd.created_at < now() - interval '48 hours'
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
