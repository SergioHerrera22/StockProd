-- ============================================================
-- Migracion 011: consume_reservation rompia el CHECK al consumir el 100%
-- ============================================================
-- Bug: consume_reservation reducia stock_balances.quantity ANTES de actualizar
-- la reserva. El trigger trg_stock_reservations_sync solo recalcula
-- reserved_quantity cuando cambia la fila de stock_reservations, asi que
-- mientras tanto quedaba quantity < reserved_quantity.
--
-- Si se consumia el 100% del stock disponible (p. ej. entregar los 98 units
-- que hay en la sucursal), el CHECK reserved_not_exceed_total (reserved <=
-- quantity) fallaba con:
--   "Los datos violan una restriccion de integridad (reserved_not_exceed_total)"
--   fila: (product_id, location_id, quantity=0, reserved_quantity=98)
--
-- El smoke test no lo detectaba porque consume menos de lo disponible
-- (3 de 97 -> 94 >= 3 sigue cumpliendo el CHECK).
--
-- Fix: al consumir, la porcion reservada consumida sale de reserved_quantity
-- en el MISMO update que quantity. El trigger posterior recalcula el mismo
-- valor, asi que el resultado converge.

CREATE OR REPLACE FUNCTION consume_reservation(
  p_reservation_id integer,
  p_quantity numeric(14,3),
  p_consumed_by integer,
  p_movement_type movement_type DEFAULT 'SALIDA',
  p_reason text DEFAULT NULL
) RETURNS TABLE (
  success boolean,
  message text,
  movement_id bigint
) AS $$
DECLARE
  v_reservation stock_reservations%ROWTYPE;
  v_balance_before numeric(14,3);
  v_balance_after numeric(14,3);
  v_movement_id bigint;
  v_ref_number varchar(30);
BEGIN
  SELECT * INTO v_reservation
  FROM stock_reservations
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false::boolean, 'Reserva no encontrada'::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_reservation.status NOT IN ('ACTIVA', 'PARCIAL') THEN
    RETURN QUERY SELECT false::boolean, ('Reserva no esta activa: ' || v_reservation.status)::text, NULL::bigint;
    RETURN;
  END IF;

  IF p_quantity <= 0 THEN
    RETURN QUERY SELECT false::boolean, 'Cantidad a consumir debe ser > 0'::text, NULL::bigint;
    RETURN;
  END IF;

  IF (v_reservation.quantity_reserved - v_reservation.quantity_consumed) < p_quantity THEN
    RETURN QUERY SELECT false::boolean, 'Cantidad a consumir supera lo reservado pendiente'::text, NULL::bigint;
    RETURN;
  END IF;

  SELECT quantity INTO v_balance_before
  FROM stock_balances
  WHERE product_id = v_reservation.product_id AND location_id = v_reservation.source_location_id
  FOR UPDATE;

  IF v_balance_before IS NULL THEN
    RETURN QUERY SELECT false::boolean, 'No existe saldo para producto/ubicacion'::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_balance_before < p_quantity THEN
    RETURN QUERY SELECT false::boolean, 'Stock real insuficiente al confirmar'::text, NULL::bigint;
    RETURN;
  END IF;

  v_balance_after := v_balance_before - p_quantity;

  -- La porcion reservada que se consume sale junto con el stock, para que
  -- reserved_quantity <= quantity se cumpla en todo momento (el CHECK
  -- reserved_not_exceed_total). El trigger recalcula lo mismo despues.
  UPDATE stock_balances
  SET quantity = v_balance_after,
      reserved_quantity = GREATEST(0, reserved_quantity - p_quantity),
      updated_at = now()
  WHERE product_id = v_reservation.product_id AND location_id = v_reservation.source_location_id;

  SELECT CASE v_reservation.reference_type
    WHEN 'DELIVERY' THEN (SELECT number FROM deliveries WHERE id = v_reservation.reference_id)
    WHEN 'TRANSFER' THEN (SELECT number FROM transfers WHERE id = v_reservation.reference_id)
    WHEN 'ENTRY' THEN (SELECT number FROM stock_entries WHERE id = v_reservation.reference_id)
    ELSE 'MANUAL-' || v_reservation.reference_id::text
  END INTO v_ref_number;

  INSERT INTO stock_movements (
    product_id, location_id, type, quantity,
    balance_before, balance_after,
    reference_type, reference_id, reference_number,
    user_id, reason
  ) VALUES (
    v_reservation.product_id, v_reservation.source_location_id, p_movement_type, p_quantity,
    v_balance_before, v_balance_after,
    v_reservation.reference_type, v_reservation.reference_id, v_ref_number,
    p_consumed_by, p_reason
  ) RETURNING id INTO v_movement_id;

  UPDATE stock_reservations
  SET quantity_consumed = quantity_consumed + p_quantity,
      status = CASE
        WHEN quantity_consumed + p_quantity >= quantity_reserved THEN 'CONSUMIDA'::reservation_status
        ELSE 'PARCIAL'::reservation_status
      END,
      consumed_by = p_consumed_by,
      consumed_at = now(),
      updated_at = now()
  WHERE id = p_reservation_id;

  RETURN QUERY SELECT true::boolean, 'Stock consumido y movimiento registrado'::text, v_movement_id;
END;
$$ LANGUAGE plpgsql;
