-- ============================================================
-- Migracion 003: Órdenes de entrega pendientes + Reservas multi-sucursal + Códigos de barras
-- ============================================================

-- ---------- Tipos ----------
CREATE TYPE pending_delivery_status AS ENUM (
  'PENDIENTE',        -- Creada, esperando retiro
  'EN_PREPARACION',   -- Escaneada en sucursal, preparando
  'LISTO_RETIRO',     -- Preparada, lista para entregar
  'ENTREGADO',        -- Confirmado retiro, stock descontado
  'CANCELADO'         -- Anulada
);

CREATE TYPE reservation_status AS ENUM (
  'ACTIVA',      -- Reserva vigente
  'CONSUMIDA',   -- Stock descontado (entrega confirmada)
  'LIBERADA',    -- Cancelada/expirada sin consumir
  'PARCIAL'      -- Parte consumida, parte liberada
);

-- ---------- Secuencias ----------
CREATE SEQUENCE seq_pending_delivery_number START 1;
CREATE SEQUENCE seq_reservation_number START 1;

-- ---------- Órdenes de entrega pendientes ----------
CREATE TABLE pending_deliveries (
  id                    serial PRIMARY KEY,
  number                varchar(20) NOT NULL UNIQUE,          -- PD-000001
  barcode               varchar(60) NOT NULL UNIQUE,          -- Código de barras único (EAN-13 o Code128)
  sale_location_id      integer NOT NULL REFERENCES locations(id),  -- Donde se vendió
  pickup_location_id    integer NOT NULL REFERENCES locations(id),  -- Donde retira el cliente
  status                pending_delivery_status NOT NULL DEFAULT 'PENDIENTE',
  customer_name         varchar(150),
  customer_phone        varchar(40),
  customer_document     varchar(40),
  notes                 text,
  created_by            integer NOT NULL REFERENCES users(id),
  prepared_by           integer REFERENCES users(id),
  prepared_at           timestamptz,
  delivered_by          integer REFERENCES users(id),
  delivered_at          timestamptz,
  cancelled_by          integer REFERENCES users(id),
  cancelled_at          timestamptz,
  cancel_reason         varchar(255),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pending_deliveries_status      ON pending_deliveries(status, created_at DESC);
CREATE INDEX idx_pending_deliveries_sale_loc    ON pending_deliveries(sale_location_id);
CREATE INDEX idx_pending_deliveries_pickup_loc  ON pending_deliveries(pickup_location_id);
CREATE INDEX idx_pending_deliveries_barcode     ON pending_deliveries(barcode);

-- ---------- Items de orden pendiente ----------
CREATE TABLE pending_delivery_items (
  id                      serial PRIMARY KEY,
  pending_delivery_id     integer NOT NULL REFERENCES pending_deliveries(id) ON DELETE CASCADE,
  product_id              integer NOT NULL REFERENCES products(id),
  quantity_requested      numeric(14,3) NOT NULL CHECK (quantity_requested > 0),  -- Lo que pidió el cliente
  quantity_reserved       numeric(14,3) NOT NULL DEFAULT 0,                       -- Lo que se reservó realmente
  quantity_delivered      numeric(14,3) NOT NULL DEFAULT 0,                       -- Lo que se entregó
  source_location_id      integer NOT NULL REFERENCES locations(id),              -- De dónde sale el stock
  UNIQUE (pending_delivery_id, product_id, source_location_id)
);
CREATE INDEX idx_pending_items_product     ON pending_delivery_items(product_id);
CREATE INDEX idx_pending_items_source_loc  ON pending_delivery_items(source_location_id);

-- ---------- Reservas de stock (trazabilidad de qué se reservó de dónde) ----------
CREATE TABLE stock_reservations (
  id                      serial PRIMARY KEY,
  number                  varchar(20) NOT NULL UNIQUE,          -- RES-000001
  pending_delivery_id     integer NOT NULL REFERENCES pending_deliveries(id) ON DELETE CASCADE,
  product_id              integer NOT NULL REFERENCES products(id),
  source_location_id      integer NOT NULL REFERENCES locations(id),
  quantity_reserved       numeric(14,3) NOT NULL CHECK (quantity_reserved > 0),
  quantity_consumed       numeric(14,3) NOT NULL DEFAULT 0,
  status                  reservation_status NOT NULL DEFAULT 'ACTIVA',
  reserved_by             integer NOT NULL REFERENCES users(id),
  consumed_by             integer REFERENCES users(id),
  consumed_at             timestamptz,
  released_by             integer REFERENCES users(id),
  released_at             timestamptz,
  release_reason          varchar(255),
  expires_at              timestamptz,                          -- Opcional: expiración automática
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_delivery   ON stock_reservations(pending_delivery_id);
CREATE INDEX idx_reservations_product    ON stock_reservations(product_id);
CREATE INDEX idx_reservations_source_loc ON stock_reservations(source_location_id);
CREATE INDEX idx_reservations_status     ON stock_reservations(status, expires_at);

-- ---------- Trigger updated_at ----------
CREATE TRIGGER trg_pending_deliveries_touch  BEFORE UPDATE ON pending_deliveries  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_stock_reservations_touch  BEFORE UPDATE ON stock_reservations  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- Función auxiliar: generar código de barras único (EAN-13 válido) ----------
CREATE OR REPLACE FUNCTION generate_ean13_barcode() RETURNS varchar(13) AS $$
DECLARE
  prefix varchar(6) := '779800';  -- Prefijo: 779 (Argentina) + 800 (interno)
  middle varchar(6);
  checksum int;
  sum int := 0;
  i int;
  digit int;
  v_barcode varchar(13);
BEGIN
  LOOP
    -- Generar 6 dígitos aleatorios para el middle
    middle := lpad(floor(random() * 1000000)::text, 6, '0');
    v_barcode := prefix || middle;  -- 12 dígitos
    
    -- Calcular checksum EAN-13
    sum := 0;
    FOR i IN 1..12 LOOP
      digit := substring(v_barcode FROM i FOR 1)::int;
      IF i % 2 = 1 THEN
        sum := sum + digit;
      ELSE
        sum := sum + digit * 3;
      END IF;
    END LOOP;
    checksum := (10 - (sum % 10)) % 10;
    v_barcode := v_barcode || checksum;
    
    -- Verificar unicidad (usar variable local v_barcode)
    IF NOT EXISTS (SELECT 1 FROM pending_deliveries WHERE barcode = v_barcode) THEN
      RETURN v_barcode;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ---------- Función: verificar disponibilidad multi-sucursal ----------
CREATE OR REPLACE FUNCTION check_multi_location_availability(
  p_product_ids integer[],
  p_sale_location_id integer,
  p_qty_requested numeric(14,3)[]
) RETURNS TABLE (
  productId integer,
  productCode varchar(40),
  productName varchar(200),
  saleLocationQty numeric(14,3),
  otherLocations jsonb,
  totalAvailable numeric(14,3),
  canFulfill boolean
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
      COALESCE(sb_sale.quantity, 0) AS "saleLocationQty",
      (
        SELECT jsonb_agg(jsonb_build_object(
          'locationId', l.id,
          'locationCode', l.code,
          'locationName', l.name,
          'availableQty', sb.quantity
        ) ORDER BY sb.quantity DESC)
        FROM stock_balances sb
        JOIN locations l ON l.id = sb.location_id
        WHERE sb.product_id = p.id
          AND sb.location_id <> p_sale_location_id
          AND sb.quantity > 0
          AND l.is_active = true
      ) AS "otherLocations",
      (
        COALESCE(sb_sale.quantity, 0) +
        COALESCE((
          SELECT sum(sb2.quantity)
          FROM stock_balances sb2
          JOIN locations l2 ON l2.id = sb2.location_id
          WHERE sb2.product_id = p.id
            AND sb2.location_id <> p_sale_location_id
            AND l2.is_active = true
        ), 0)
      ) AS "totalAvailable",
      (
        COALESCE(sb_sale.quantity, 0) +
        COALESCE((
          SELECT sum(sb2.quantity)
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

-- ---------- Función: crear orden pendiente con reservas (transaccional) ----------
CREATE OR REPLACE FUNCTION create_pending_delivery_with_reservations(
  p_sale_location_id integer,
  p_pickup_location_id integer,
  p_customer_name varchar(150),
  p_customer_phone varchar(40),
  p_customer_document varchar(40),
  p_notes text,
  p_created_by integer,
  p_items jsonb  -- [{"product_id": 1, "quantity_requested": 15, "source_location_id": 2, "quantity_reserved": 10}, ...]
) RETURNS TABLE (
  pending_delivery_id integer,
  pending_delivery_number varchar(20),
  barcode varchar(60)
) AS $$
DECLARE
  v_delivery_id integer;
  v_delivery_number varchar(20);
  v_barcode varchar(60);
  v_reservation_number varchar(20);
  v_item jsonb;
  v_product_id integer;
  v_qty_requested numeric(14,3);
  v_source_location_id integer;
  v_qty_reserved numeric(14,3);
  v_available_qty numeric(14,3);
BEGIN
  -- Generar número de orden
  v_delivery_number := 'PD-' || lpad(nextval('seq_pending_delivery_number')::text, 6, '0');
  v_barcode := generate_ean13_barcode();
  
  -- Insertar orden pendiente
  INSERT INTO pending_deliveries (
    number, barcode, sale_location_id, pickup_location_id,
    customer_name, customer_phone, customer_document, notes, created_by
  ) VALUES (
    v_delivery_number, v_barcode, p_sale_location_id, p_pickup_location_id,
    p_customer_name, p_customer_phone, p_customer_document, p_notes, p_created_by
  ) RETURNING id INTO v_delivery_id;
  
  -- Procesar cada item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::integer;
    v_qty_requested := (v_item->>'quantity_requested')::numeric(14,3);
    v_source_location_id := (v_item->>'source_location_id')::integer;
    v_qty_reserved := (v_item->>'quantity_reserved')::numeric(14,3);
    
    -- Verificar stock disponible en la ubicación origen
    SELECT COALESCE(quantity, 0) INTO v_available_qty
    FROM stock_balances
    WHERE product_id = v_product_id AND location_id = v_source_location_id;
    
    IF v_available_qty < v_qty_reserved THEN
      RAISE EXCEPTION 'Stock insuficiente en ubicación % para producto % (disponible: %, solicitado: %)',
        v_source_location_id, v_product_id, v_available_qty, v_qty_reserved;
    END IF;
    
    -- Insertar item en orden pendiente
    INSERT INTO pending_delivery_items (
      pending_delivery_id, product_id, quantity_requested, quantity_reserved, source_location_id
    ) VALUES (
      v_delivery_id, v_product_id, v_qty_requested, v_qty_reserved, v_source_location_id
    );
    
    -- Crear reserva de stock
    v_reservation_number := 'RES-' || lpad(nextval('seq_reservation_number')::text, 6, '0');
    INSERT INTO stock_reservations (
      number, pending_delivery_id, product_id, source_location_id,
      quantity_reserved, reserved_by
    ) VALUES (
      v_reservation_number, v_delivery_id, v_product_id, v_source_location_id,
      v_qty_reserved, p_created_by
    );
    
    -- TODO: En producción, aquí se debería hacer un "soft reserve" 
    -- (ej. columna reserved_quantity en stock_balances o tabla aparte)
    -- Por ahora solo registramos la reserva en stock_reservations
  END LOOP;
  
  RETURN QUERY SELECT v_delivery_id, v_delivery_number, v_barcode;
END;
$$ LANGUAGE plpgsql;

-- ---------- Función: confirmar retiro/entrega (descuenta stock) ----------
CREATE OR REPLACE FUNCTION confirm_pending_delivery_pickup(
  p_barcode varchar(60),
  p_user_id integer,
  p_delivered_items jsonb  -- [{"product_id": 1, "quantity_delivered": 10}, ...]
) RETURNS TABLE (
  success boolean,
  message text,
  pending_delivery_id integer
) AS $$
DECLARE
  v_delivery_id integer;
  v_delivery record;
  v_item jsonb;
  v_product_id integer;
  v_qty_delivered numeric(14,3);
  v_reservation record;
  v_balance_before numeric(14,3);
  v_balance_after numeric(14,3);
BEGIN
  -- Buscar orden por código de barras
  SELECT * INTO v_delivery
  FROM pending_deliveries
  WHERE barcode = p_barcode;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Código de barras no encontrado', NULL;
  END IF;
  
  IF v_delivery.status NOT IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO') THEN
    RETURN QUERY SELECT false, 'Orden no está en estado válido para entrega: ' || v_delivery.status, v_delivery.id;
  END IF;
  
  IF v_delivery.pickup_location_id IS NULL THEN
    RETURN QUERY SELECT false, 'Orden no tiene sucursal de retiro asignada', v_delivery.id;
  END IF;
  
  -- Verificar que el usuario pertenece a la ubicación de retiro (opcional, según reglas de negocio)
  -- IF EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND default_location_id <> v_delivery.pickup_location_id AND restrict_to_location = true) THEN
  --   RETURN QUERY SELECT false, 'Usuario no autorizado para esta sucursal', v_delivery.id;
  -- END IF;
  
  -- Procesar cada item entregado
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_delivered_items)
  LOOP
    v_product_id := (v_item->>'product_id')::integer;
    v_qty_delivered := (v_item->>'quantity_delivered')::numeric(14,3);
    
    IF v_qty_delivered <= 0 THEN
      CONTINUE;
    END IF;
    
    -- Buscar la reserva activa para este producto en la ubicación de retiro
    SELECT * INTO v_reservation
    FROM stock_reservations
    WHERE pending_delivery_id = v_delivery.id
      AND product_id = v_product_id
      AND source_location_id = v_delivery.pickup_location_id
      AND status = 'ACTIVA'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;
    
    IF NOT FOUND THEN
      -- Buscar en otras ubicaciones si no hay reserva en la de retiro
      SELECT * INTO v_reservation
      FROM stock_reservations
      WHERE pending_delivery_id = v_delivery.id
        AND product_id = v_product_id
        AND status = 'ACTIVA'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE;
    END IF;
    
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'No hay reserva activa para producto ' || v_product_id, v_delivery.id;
    END IF;
    
    -- Verificar stock real en la ubicación de retiro (source_location_id de la reserva)
    SELECT COALESCE(quantity, 0) INTO v_balance_before
    FROM stock_balances
    WHERE product_id = v_product_id AND location_id = v_reservation.source_location_id;
    
    IF v_balance_before < v_qty_delivered THEN
      RETURN QUERY SELECT false, 'Stock insuficiente en ubicación de retiro para producto ' || v_product_id, v_delivery.id;
    END IF;
    
    v_balance_after := v_balance_before - v_qty_delivered;
    
    -- Descontar stock real
    UPDATE stock_balances
    SET quantity = v_balance_after, updated_at = now()
    WHERE product_id = v_product_id AND location_id = v_reservation.source_location_id;
    
    -- Registrar movimiento de salida
    INSERT INTO stock_movements (
      product_id, location_id, type, quantity,
      balance_before, balance_after,
      reference_type, reference_id, reference_number,
      user_id, reason
    ) VALUES (
      v_product_id, v_reservation.source_location_id, 'SALIDA', v_qty_delivered,
      v_balance_before, v_balance_after,
      'DELIVERY', v_delivery.id, v_delivery.number,
      p_user_id, 'Entrega orden pendiente ' || v_delivery.number
    );
    
    -- Actualizar reserva
    UPDATE stock_reservations
    SET quantity_consumed = quantity_consumed + v_qty_delivered,
        status = CASE 
          WHEN quantity_consumed + v_qty_delivered >= quantity_reserved THEN 'CONSUMIDA'
          ELSE 'PARCIAL'
        END,
        consumed_by = p_user_id,
        consumed_at = now(),
        updated_at = now()
    WHERE id = v_reservation.id;
    
    -- Actualizar item de orden pendiente
    UPDATE pending_delivery_items
    SET quantity_delivered = quantity_delivered + v_qty_delivered
    WHERE pending_delivery_id = v_delivery.id AND product_id = v_product_id AND source_location_id = v_reservation.source_location_id;
  END LOOP;
  
  -- Verificar si todos los items se entregaron completamente
  IF NOT EXISTS (
    SELECT 1 FROM pending_delivery_items
    WHERE pending_delivery_id = v_delivery.id
      AND quantity_delivered < quantity_reserved
  ) THEN
    UPDATE pending_deliveries
    SET status = 'ENTREGADO',
        delivered_by = p_user_id,
        delivered_at = now(),
        updated_at = now()
    WHERE id = v_delivery.id;
  ELSE
    UPDATE pending_deliveries
    SET status = 'ENTREGADO',  -- O 'PARCIAL' si quieres otro estado
        delivered_by = p_user_id,
        delivered_at = now(),
        updated_at = now()
    WHERE id = v_delivery.id;
  END IF;
  
  RETURN QUERY SELECT true, 'Entrega confirmada correctamente', v_delivery.id;
END;
$$ LANGUAGE plpgsql;

-- ---------- Función: escanear código de barras (ver orden) ----------
CREATE OR REPLACE FUNCTION scan_pending_delivery_barcode(
  p_barcode varchar(60)
) RETURNS TABLE (
  pending_delivery_id integer,
  number varchar(20),
  status pending_delivery_status,
  sale_location_code varchar(10),
  sale_location_name varchar(120),
  pickup_location_code varchar(10),
  pickup_location_name varchar(120),
  customer_name varchar(150),
  customer_phone varchar(40),
  customer_document varchar(40),
  items jsonb,
  created_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pd.id,
    pd.number,
    pd.status,
    sl.code AS sale_location_code,
    sl.name AS sale_location_name,
    pl.code AS pickup_location_code,
    pl.name AS pickup_location_name,
    pd.customer_name,
    pd.customer_phone,
    pd.customer_document,
    (
      SELECT jsonb_agg(jsonb_build_object(
        'product_id', pdi.product_id,
        'product_code', p.code,
        'product_name', p.name,
        'quantity_requested', pdi.quantity_requested,
        'quantity_reserved', pdi.quantity_reserved,
        'quantity_delivered', pdi.quantity_delivered,
        'source_location_id', pdi.source_location_id,
        'source_location_code', sl2.code,
        'source_location_name', sl2.name
      ))
      FROM pending_delivery_items pdi
      JOIN products p ON p.id = pdi.product_id
      JOIN locations sl2 ON sl2.id = pdi.source_location_id
      WHERE pdi.pending_delivery_id = pd.id
    ) AS items,
    pd.created_at
  FROM pending_deliveries pd
  JOIN locations sl ON sl.id = pd.sale_location_id
  JOIN locations pl ON pl.id = pd.pickup_location_id
  WHERE pd.barcode = p_barcode;
END;
$$ LANGUAGE plpgsql;

-- ---------- Función: liberar reservas (cancelar orden) ----------
CREATE OR REPLACE FUNCTION release_pending_delivery_reservations(
  p_pending_delivery_id integer,
  p_user_id integer,
  p_reason varchar(255)
) RETURNS void AS $$
DECLARE
  v_reservation record;
BEGIN
  FOR v_reservation IN
    SELECT * FROM stock_reservations
    WHERE pending_delivery_id = p_pending_delivery_id
      AND status IN ('ACTIVA', 'PARCIAL')
  LOOP
    UPDATE stock_reservations
    SET status = 'LIBERADA',
        released_by = p_user_id,
        released_at = now(),
        release_reason = p_reason,
        updated_at = now()
    WHERE id = v_reservation.id;
  END LOOP;
  
  UPDATE pending_deliveries
  SET status = 'CANCELADO',
      cancelled_by = p_user_id,
      cancelled_at = now(),
      cancel_reason = p_reason,
      updated_at = now()
  WHERE id = p_pending_delivery_id;
END;
$$ LANGUAGE plpgsql;

-- ---------- Vista: disponibilidad multi-sucursal para UI ----------
CREATE OR REPLACE VIEW v_multi_location_stock AS
SELECT 
  p.id AS product_id,
  p.code AS product_code,
  p.name AS product_name,
  p.barcode AS product_barcode,
  l.id AS location_id,
  l.code AS location_code,
  l.name AS location_name,
  l.type AS location_type,
  COALESCE(sb.quantity, 0) AS available_quantity
FROM products p
CROSS JOIN locations l
LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.location_id = l.id
WHERE p.is_active = true
  AND l.is_active = true
  AND COALESCE(sb.quantity, 0) > 0
ORDER BY p.name, l.code;