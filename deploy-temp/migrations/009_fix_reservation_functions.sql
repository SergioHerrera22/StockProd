-- ============================================================
-- Migracion 009: Reparacion de las funciones de reservas de stock
-- ============================================================
-- Motivo: las funciones de reservas venian siendo "arregladas" con scripts
-- puntuales (scripts/fix-*.mjs) que recrearon los cuerpos SIN los casteos de
-- tipo. Eso provoca dos errores en cadena al crear/recibir transferencias y
-- entregas:
--
--   1) "structure of query does not match function result type"
--      -> RETURN QUERY SELECT false, 'Reserva no encontrada', NULL
--         (el NULL sin cast se infiere como text y no coincide con bigint)
--   2) "Falta un dato obligatorio" (23502)
--      -> el valor nulo en la columna product_id de la relacion stock_movements
--
-- Y un tercer bug propio de la migracion 004:
--   3) "especificador de tipo no reconocido en format()"
--      -> format('%s reservas liberadas para % %s', ...)
--         el % suelto no es un especificador valido; debe ser %s (o %%)
--         Esto rompia la ANULACION de transferencias (liberacion de reservas).
--
-- Esta migracion vuelve a crear TODAS las funciones con cuerpos correctos y
-- tipados. Es idempotente (CREATE OR REPLACE).

-- ---------- 1. reserve_stock ----------
CREATE OR REPLACE FUNCTION reserve_stock(
  p_reference_type reference_type,
  p_reference_id integer,
  p_product_id integer,
  p_source_location_id integer,
  p_quantity numeric(14,3),
  p_reserved_by integer,
  p_expires_at timestamptz DEFAULT NULL
) RETURNS TABLE (
  reservation_id integer,
  reservation_number varchar(20),
  success boolean,
  message text
) AS $$
DECLARE
  v_available numeric(14,3);
  v_reservation_number varchar(20);
  v_reservation_id integer;
BEGIN
  SELECT (quantity - reserved_quantity) INTO v_available
  FROM stock_balances
  WHERE product_id = p_product_id AND location_id = p_source_location_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::integer, NULL::varchar, false::boolean, 'No existe saldo para producto/ubicacion'::text;
    RETURN;
  END IF;

  IF v_available < p_quantity THEN
    RETURN QUERY SELECT NULL::integer, NULL::varchar, false::boolean,
      format('Stock insuficiente: disponible %s, solicitado %s', v_available, p_quantity)::text;
    RETURN;
  END IF;

  v_reservation_number := 'RES-' || lpad(nextval('seq_reservation_number')::text, 6, '0');

  INSERT INTO stock_reservations (
    number, reference_type, reference_id, product_id, source_location_id,
    quantity_reserved, reserved_by, expires_at, status
  ) VALUES (
    v_reservation_number, p_reference_type, p_reference_id, p_product_id, p_source_location_id,
    p_quantity, p_reserved_by, p_expires_at, 'ACTIVA'
  ) RETURNING id INTO v_reservation_id;

  RETURN QUERY SELECT v_reservation_id, v_reservation_number, true::boolean, 'Stock reservado correctamente'::text;
END;
$$ LANGUAGE plpgsql;

-- ---------- 2. consume_reservation ----------
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

  UPDATE stock_balances
  SET quantity = v_balance_after, updated_at = now()
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

-- ---------- 3. release_reservation ----------
CREATE OR REPLACE FUNCTION release_reservation(
  p_reservation_id integer,
  p_released_by integer,
  p_reason varchar(255)
) RETURNS TABLE (
  success boolean,
  message text
) AS $$
DECLARE
  v_reservation stock_reservations%ROWTYPE;
  v_unconsumed numeric(14,3);
BEGIN
  SELECT * INTO v_reservation
  FROM stock_reservations
  WHERE id = p_reservation_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false::boolean, 'Reserva no encontrada'::text;
    RETURN;
  END IF;

  IF v_reservation.status NOT IN ('ACTIVA', 'PARCIAL') THEN
    RETURN QUERY SELECT false::boolean, ('Reserva ya no esta activa: ' || v_reservation.status)::text;
    RETURN;
  END IF;

  v_unconsumed := v_reservation.quantity_reserved - v_reservation.quantity_consumed;

  UPDATE stock_reservations
  SET status = 'LIBERADA',
      released_by = p_released_by,
      released_at = now(),
      release_reason = p_reason,
      updated_at = now()
  WHERE id = p_reservation_id;

  RETURN QUERY SELECT true::boolean,
    format('Reserva liberada (%s unidades devueltas a disponible)', v_unconsumed)::text;
END;
$$ LANGUAGE plpgsql;

-- ---------- 4. release_all_reservations_for_reference (corrige el format) ----------
CREATE OR REPLACE FUNCTION release_all_reservations_for_reference(
  p_reference_type reference_type,
  p_reference_id integer,
  p_released_by integer,
  p_reason varchar(255)
) RETURNS TABLE (
  released_count integer,
  message text
) AS $$
DECLARE
  v_count integer := 0;
  v_reservation record;
BEGIN
  FOR v_reservation IN
    SELECT * FROM stock_reservations
    WHERE reference_type = p_reference_type
      AND reference_id = p_reference_id
      AND status IN ('ACTIVA', 'PARCIAL')
  LOOP
    PERFORM release_reservation(v_reservation.id, p_released_by, p_reason);
    v_count := v_count + 1;
  END LOOP;

  RETURN QUERY SELECT v_count,
    format('%s reservas liberadas para %s %s', v_count, p_reference_type, p_reference_id)::text;
END;
$$ LANGUAGE plpgsql;

-- ---------- 5. cleanup_expired_reservations ----------
CREATE OR REPLACE FUNCTION cleanup_expired_reservations(
  p_released_by integer DEFAULT NULL
) RETURNS TABLE (
  cleaned_count integer,
  message text
) AS $$
DECLARE
  v_count integer := 0;
  v_reservation record;
BEGIN
  FOR v_reservation IN
    SELECT * FROM stock_reservations
    WHERE status IN ('ACTIVA', 'PARCIAL')
      AND expires_at IS NOT NULL
      AND expires_at < now()
  LOOP
    PERFORM release_reservation(v_reservation.id,
      COALESCE(p_released_by, v_reservation.reserved_by),
      'Expiracion automatica');
    v_count := v_count + 1;
  END LOOP;

  RETURN QUERY SELECT v_count, format('%s reservas expiradas limpiadas', v_count)::text;
END;
$$ LANGUAGE plpgsql;
