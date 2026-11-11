-- ============================================================
-- Migracion 006: Fix check_multi_location_availability to return camelCase
-- ============================================================

-- Dropear la función existente y recrearla
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