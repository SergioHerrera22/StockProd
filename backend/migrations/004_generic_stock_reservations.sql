-- ============================================================
-- Migracion 004: Sistema de reservas genérico para TODOS los movimientos de stock
-- ============================================================

-- ---------- 1. Hacer stock_reservations genérico (no solo pending_deliveries) ----------
ALTER TABLE stock_reservations 
  DROP CONSTRAINT IF EXISTS stock_reservations_pending_delivery_id_fkey;

-- pending_delivery_id ya no es obligatorio (las reservas son genéricas ahora)
ALTER TABLE stock_reservations 
  ALTER COLUMN pending_delivery_id DROP NOT NULL;

ALTER TABLE stock_reservations 
  ADD COLUMN IF NOT EXISTS reference_type reference_type NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS reference_id integer NOT NULL DEFAULT 0;

-- Eliminar la FK antigua y crear una genérica (polimórfica via reference_type + reference_id)
-- Nota: No se puede FK polimórfica real, se valida en aplicación

-- Índices para búsquedas rápidas por referencia
CREATE INDEX IF NOT EXISTS idx_reservations_reference ON stock_reservations(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_reservations_product_loc_status ON stock_reservations(product_id, source_location_id, status);

-- ---------- 2. Columna reserved_quantity en stock_balances para disponibilidad rápida ----------
ALTER TABLE stock_balances 
  ADD COLUMN IF NOT EXISTS reserved_quantity numeric(14,3) NOT NULL DEFAULT 0;

-- Constraint: reserved no puede superar total
ALTER TABLE stock_balances 
  ADD CONSTRAINT reserved_not_exceed_total CHECK (reserved_quantity <= quantity);

-- Índice para consultas de stock disponible
CREATE INDEX IF NOT EXISTS idx_balances_available ON stock_balances(product_id, location_id) WHERE (quantity - reserved_quantity) > 0;

-- ---------- 3. Trigger: actualizar reserved_quantity desde stock_reservations ----------
CREATE OR REPLACE FUNCTION update_stock_balances_reserved() RETURNS trigger AS $$
BEGIN
  -- Al insertar/actualizar reserva ACTIVA/PARCIAL: sumar a reserved_quantity
  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status IN ('ACTIVA', 'PARCIAL') THEN
    UPDATE stock_balances
    SET reserved_quantity = (
      SELECT COALESCE(SUM(quantity_reserved - quantity_consumed), 0)
      FROM stock_reservations
      WHERE product_id = NEW.product_id
        AND source_location_id = NEW.source_location_id
        AND status IN ('ACTIVA', 'PARCIAL')
    ),
    updated_at = now()
    WHERE product_id = NEW.product_id AND location_id = NEW.source_location_id;
    
    RETURN NEW;
  END IF;
  
  -- Al liberar/consumir completamente: recalcular
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.status IN ('ACTIVA', 'PARCIAL') THEN
    UPDATE stock_balances
    SET reserved_quantity = (
      SELECT COALESCE(SUM(quantity_reserved - quantity_consumed), 0)
      FROM stock_reservations
      WHERE product_id = OLD.product_id
        AND source_location_id = OLD.source_location_id
        AND status IN ('ACTIVA', 'PARCIAL')
    ),
    updated_at = now()
    WHERE product_id = OLD.product_id AND location_id = OLD.source_location_id;
    
    RETURN OLD;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_reservations_sync ON stock_reservations;
CREATE TRIGGER trg_stock_reservations_sync
AFTER INSERT OR UPDATE OR DELETE ON stock_reservations
FOR EACH ROW EXECUTE FUNCTION update_stock_balances_reserved();

-- ---------- 4. Función genérica: RESERVAR stock (para cualquier operación) ----------
CREATE OR REPLACE FUNCTION reserve_stock(
  p_reference_type reference_type,
  p_reference_id integer,
  p_product_id integer,
  p_source_location_id integer,
  p_quantity numeric(14,3),
  p_reserved_by integer,
  p_expires_at timestamptz DEFAULT NULL  -- NULL = sin expiración automática
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
  -- Verificar stock disponible (total - reservado)
  SELECT (quantity - reserved_quantity) INTO v_available
  FROM stock_balances
  WHERE product_id = p_product_id AND location_id = p_source_location_id;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::integer, NULL::varchar, false::boolean, 'No existe saldo para producto/ubicación'::text;
  END IF;

  IF v_available < p_quantity THEN
    RETURN QUERY SELECT NULL::integer, NULL::varchar, false::boolean,
      format('Stock insuficiente: disponible %s, solicitado %s', v_available, p_quantity)::text;
  END IF;
  
  -- Generar número de reserva
  v_reservation_number := 'RES-' || lpad(nextval('seq_reservation_number')::text, 6, '0');
  
  -- Crear reserva (bloquea la fila en stock_balances via trigger)
  INSERT INTO stock_reservations (
    number, reference_type, reference_id, product_id, source_location_id,
    quantity_reserved, reserved_by, expires_at, status
  ) VALUES (
    v_reservation_number, p_reference_type, p_reference_id, p_product_id, p_source_location_id,
    p_quantity, p_reserved_by, p_expires_at, 'ACTIVA'
  ) RETURNING id INTO v_reservation_id;
  
  RETURN QUERY SELECT v_reservation_id, v_reservation_number, true, 'Stock reservado correctamente';
END;
$$ LANGUAGE plpgsql;

-- ---------- 5. Función genérica: CONSUMIR reserva (confirma movimiento, descuenta stock real) ----------
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
  -- Bloquear y obtener reserva
  SELECT * INTO v_reservation
  FROM stock_reservations
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false::boolean, 'Reserva no encontrada'::text, NULL::bigint;
  END IF;

  IF v_reservation.status NOT IN ('ACTIVA', 'PARCIAL') THEN
    RETURN QUERY SELECT false::boolean, 'Reserva no está activa: ' || v_reservation.status, NULL::bigint;
  END IF;

  IF p_quantity <= 0 THEN
    RETURN QUERY SELECT false::boolean, 'Cantidad a consumir debe ser > 0', NULL::bigint;
  END IF;

  IF (v_reservation.quantity_reserved - v_reservation.quantity_consumed) < p_quantity THEN
    RETURN QUERY SELECT false::boolean, 'Cantidad a consumir supera lo reservado pendiente', NULL::bigint;
  END IF;

  -- Verificar stock real (doble check)
  SELECT quantity INTO v_balance_before
  FROM stock_balances
  WHERE product_id = v_reservation.product_id AND location_id = v_reservation.source_location_id
  FOR UPDATE;

  IF v_balance_before < p_quantity THEN
    RETURN QUERY SELECT false::boolean, 'Stock real insuficiente al confirmar', NULL::bigint;
  END IF;

  v_balance_after := v_balance_before - p_quantity;

  -- Descontar stock real
  UPDATE stock_balances
  SET quantity = v_balance_after, updated_at = now()
  WHERE product_id = v_reservation.product_id AND location_id = v_reservation.source_location_id;

  -- Número de referencia para el movimiento
  SELECT CASE v_reservation.reference_type
    WHEN 'DELIVERY' THEN (SELECT number FROM deliveries WHERE id = v_reservation.reference_id)
    WHEN 'TRANSFER' THEN (SELECT number FROM transfers WHERE id = v_reservation.reference_id)
    WHEN 'ENTRY' THEN (SELECT number FROM stock_entries WHERE id = v_reservation.reference_id)
    ELSE 'MANUAL-' || v_reservation.reference_id::text
  END INTO v_ref_number;

  -- Registrar movimiento
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

  -- Actualizar reserva
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

-- ---------- 6. Función genérica: LIBERAR reserva (cancelación, expiración) ----------
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
    RETURN QUERY SELECT false, 'Reserva no encontrada';
  END IF;
  
  IF v_reservation.status NOT IN ('ACTIVA', 'PARCIAL') THEN
    RETURN QUERY SELECT false, 'Reserva ya no está activa: ' || v_reservation.status;
  END IF;
  
  v_unconsumed := v_reservation.quantity_reserved - v_reservation.quantity_consumed;
  
  UPDATE stock_reservations
  SET status = 'LIBERADA',
      released_by = p_released_by,
      released_at = now(),
      release_reason = p_reason,
      updated_at = now()
  WHERE id = p_reservation_id;
  
  RETURN QUERY SELECT true, format('Reserva liberada (%s unidades devueltas a disponible)', v_unconsumed);
END;
$$ LANGUAGE plpgsql;

-- ---------- 7. Función: liberar TODAS las reservas de una referencia (ej. anular delivery/transfer) ----------
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
  
  RETURN QUERY SELECT v_count, format('%s reservas liberadas para % %s', v_count, p_reference_type, p_reference_id);
END;
$$ LANGUAGE plpgsql;

-- ---------- 8. Función: limpiar reservas EXPIRADAS (job programado) ----------
CREATE OR REPLACE FUNCTION cleanup_expired_reservations(
  p_released_by integer DEFAULT NULL  -- NULL = system
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
      'Expiración automática');
    v_count := v_count + 1;
  END LOOP;
  
  RETURN QUERY SELECT v_count, format('%s reservas expiradas limpiadas', v_count);
END;
$$ LANGUAGE plpgsql;

-- ---------- 9. Función: obtener stock DISPONIBLE (total - reservado) ----------
CREATE OR REPLACE FUNCTION get_available_stock(
  p_product_id integer DEFAULT NULL,
  p_location_id integer DEFAULT NULL
) RETURNS TABLE (
  product_id integer,
  product_code varchar(40),
  product_name varchar(200),
  location_id integer,
  location_code varchar(10),
  location_name varchar(120),
  total_quantity numeric(14,3),
  reserved_quantity numeric(14,3),
  available_quantity numeric(14,3)
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.id,
    p.code,
    p.name,
    l.id,
    l.code,
    l.name,
    sb.quantity,
    sb.reserved_quantity,
    (sb.quantity - sb.reserved_quantity) AS available_quantity
  FROM stock_balances sb
  JOIN products p ON p.id = sb.product_id
  JOIN locations l ON l.id = sb.location_id
  WHERE p.is_active = true
    AND l.is_active = true
    AND (p_product_id IS NULL OR p.id = p_product_id)
    AND (p_location_id IS NULL OR l.id = p_location_id)
    AND (sb.quantity - sb.reserved_quantity) > 0
  ORDER BY p.name, l.code;
END;
$$ LANGUAGE plpgsql;

-- ---------- 10. Actualizar reserved_quantity existente (inicializar desde reservas activas) ----------
UPDATE stock_balances sb
SET reserved_quantity = (
  SELECT COALESCE(SUM(sr.quantity_reserved - sr.quantity_consumed), 0)
  FROM stock_reservations sr
  WHERE sr.product_id = sb.product_id
    AND sr.source_location_id = sb.location_id
    AND sr.status IN ('ACTIVA', 'PARCIAL')
),
updated_at = now();

-- ---------- 11. Vista: stock con disponibilidad real ----------
CREATE OR REPLACE VIEW v_stock_availability AS
SELECT 
  sb.product_id,
  p.code AS product_code,
  p.name AS product_name,
  p.barcode AS product_barcode,
  sb.location_id,
  l.code AS location_code,
  l.name AS location_name,
  l.type AS location_type,
  sb.quantity AS total_quantity,
  sb.reserved_quantity,
  (sb.quantity - sb.reserved_quantity) AS available_quantity,
  CASE 
    WHEN (sb.quantity - sb.reserved_quantity) <= 0 THEN 'SIN_STOCK'
    WHEN (sb.quantity - sb.reserved_quantity) <= p.min_stock THEN 'STOCK_BAJO'
    ELSE 'OK'
  END AS stock_status
FROM stock_balances sb
JOIN products p ON p.id = sb.product_id
JOIN locations l ON l.id = sb.location_id
WHERE p.is_active = true
  AND l.is_active = true;