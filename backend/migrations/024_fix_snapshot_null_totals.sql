-- ============================================================
-- 024: FIX create_stock_snapshot — NULLs con ubicaciones SIN stock.
--      Sobre la base de 023 (que ya reparaba p_created_by): en una
--      ubicacion sin saldos positivos, sum() sobre conjunto vacio
--      devuelve NULL yaps insumo viola NOT NULL de total_quantity
--      (produccion arranca sin stock: TODO conteo/snapshot fallaba).
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_stock_snapshot(
    p_location_id integer,
    p_snapshot_type varchar,
    p_reference_id integer DEFAULT NULL::integer,
    p_reference_type varchar DEFAULT NULL::varchar,
    p_created_by integer DEFAULT NULL::integer
) RETURNS bigint AS $$
DECLARE
    v_snapshot_id bigint;
    v_hash text;
BEGIN
    -- Snapshot cabecera con totales del stock actual.
    -- COALESCE sobre los SUM: conjunto vacio => 0/NULL->0, nunca NULL.
    INSERT INTO stock_snapshots (location_id, snapshot_type, reference_id, reference_type, total_products, total_quantity, total_value, data_hash, created_by)
    SELECT p_location_id, p_snapshot_type, p_reference_id, p_reference_type,
           count(*)::int,
           COALESCE(sum(sb.quantity), 0),
           COALESCE(sum(sb.quantity * COALESCE(p.cost, 0)), 0),
           '',
           p_created_by
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

    IF COALESCE(v_snapshot_id, 0) = 0 THEN
        RAISE EXCEPTION 'create_stock_snapshot: no se pudo insertar la cabecera';
    END IF;

    -- Hash canonico sobre los items PERSISTIDOS (misma expresion que usa la
    -- verificacion del backend con stock_snapshot_items).
    SELECT encode(digest(
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'productId', si.product_id,
             'quantity', si.quantity,
             'unitCost', si.unit_cost
         ) ORDER BY si.product_id)
         FROM stock_snapshot_items si WHERE si.snapshot_id = v_snapshot_id), '[]'::jsonb)::text,
        'sha256'
    ), 'hex') INTO v_hash;

    UPDATE stock_snapshots SET data_hash = v_hash WHERE id = v_snapshot_id;

    RETURN v_snapshot_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
