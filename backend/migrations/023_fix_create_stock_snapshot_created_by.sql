-- ============================================================
-- 023: FIX create_stock_snapshot — INSERT con 9 columnas y
--      solo 8 expresiones (faltaba p_created_by en el SELECT).
--      Todo snapshot (conteo PRE/POST, DAILY, WEEKLY, manual) fallaba con
--      "INSERT tiene mas columnas de destino que expresiones" -> 500.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_stock_snapshot(
    p_location_id integer,
    p_snapshot_type varchar,
    p_reference_id integer DEFAULT NULL,
    p_reference_type varchar DEFAULT NULL,
    p_created_by integer DEFAULT NULL
) RETURNS bigint AS $$
DECLARE
    v_snapshot_id bigint;
    v_hash text;
BEGIN
    -- Snapshot cabecera con totales del stock actual
    INSERT INTO stock_snapshots (location_id, snapshot_type, reference_id, reference_type, total_products, total_quantity, total_value, data_hash, created_by)
    SELECT p_location_id, p_snapshot_type, p_reference_id, p_reference_type,
           count(*)::int, sum(sb.quantity), sum(sb.quantity * COALESCE(p.cost, 0)), '', p_created_by
    FROM stock_balances sb
    JOIN products p ON p.id = sb.product_id
    WHERE sb.location_id = p_location_id AND sb.quantity > 0
    RETURNING id INTO v_snapshot_id;

    IF v_snapshot_id IS NULL THEN
        -- Ubicacion sin saldos positivos: snapshot vacio posible, insertar fila
        -- minima con hash canonico de lista vacia.
        INSERT INTO stock_snapshots (location_id, snapshot_type, reference_id, reference_type, total_products, total_quantity, total_value, data_hash, created_by)
        VALUES (p_location_id, p_snapshot_type, p_reference_id, p_reference_type, 0, 0, 0, '', p_created_by)
        RETURNING id INTO v_snapshot_id;
    END IF;

    -- Insertar detalle
    INSERT INTO stock_snapshot_items (snapshot_id, product_id, quantity, unit_cost)
    SELECT v_snapshot_id, sb.product_id, sb.quantity, p.cost
    FROM stock_balances sb
    JOIN products p ON p.id = sb.product_id
    WHERE sb.location_id = p_location_id AND sb.quantity > 0;

    -- Hash canonico sobre los items PERSISTIDOS (misma expresion que usa la
    -- verificacion del backend con stock_snapshot_items).
    SELECT encode(digest(
        (SELECT jsonb_agg(jsonb_build_object(
             'productId', product_id,
             'quantity', quantity,
             'unitCost', unit_cost
         ) ORDER BY product_id)::text
         FROM stock_snapshot_items WHERE snapshot_id = v_snapshot_id),
        'sha256'
    ), 'hex') INTO v_hash;

    UPDATE stock_snapshots SET data_hash = v_hash WHERE id = v_snapshot_id;

    RETURN v_snapshot_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
