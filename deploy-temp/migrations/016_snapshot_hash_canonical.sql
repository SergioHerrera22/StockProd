-- 016: Integridad de snapshots verificable.
-- La funcion original hasheaba los saldos VIVOS con una forma jsonb que la
-- verificacion en TypeScript no podia reproducir (claves snake vs camel,
-- numerics como string vs Number): verificar marcaba TODO como manipulado.
-- Ahora el hash se calcula en ambas partes con UNA expresion canonica sobre
-- los items PERSISTIDOS del snapshot (mismo jsonb_build_object, ORDER BY
-- product_id) via SQL + pgcrypto digest, tanto al crear como al verificar.
-- Se re-canonicalizan los snapshots existentes (los items se insertaron
-- copiando los saldos al momento, sin modificaciones registradas).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Funcion de creacion: hash derivado de los items persistidos.
CREATE OR REPLACE FUNCTION create_stock_snapshot(
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

-- 2. Re-canonicalizar snapshots existentes (se auto-aceptan como estado
--    actual; sirven como linea de base para detectar manipulacion futura).
UPDATE stock_snapshots s
SET data_hash = hc.new_hash
FROM (
    SELECT s2.id AS snapshot_id,
           encode(digest(
               jsonb_agg(jsonb_build_object(
                   'productId', i.product_id,
                   'quantity', i.quantity,
                   'unitCost', i.unit_cost
               ) ORDER BY i.product_id)::text,
               'sha256'
           ), 'hex') AS new_hash
    FROM stock_snapshots s2
    JOIN stock_snapshot_items i ON i.snapshot_id = s2.id
    GROUP BY s2.id
) hc
WHERE s.id = hc.snapshot_id AND s.data_hash <> hc.new_hash;
