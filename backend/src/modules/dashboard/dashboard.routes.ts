import { Router } from 'express';
import { query } from '../../db/pool';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { intParam } from '../../lib/pagination';

const router = Router();
router.use(authRequired, requirePerm('dashboard.read'));

router.get(
  '/summary',
  asyncH(async (req, res) => {
    const locationId = intParam(req.query.locationId);
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days ?? '14'), 10) || 14));
    const locFilter = locationId ? 'AND m.location_id = ' + locationId : '';
    const locFilterBal = locationId ? 'AND sb.location_id = ' + locationId : '';

    const [
      inventoryStats,
      today,
      pendingTransfersCount,
      pendingTransfersList,
      recent,
      byLocation,
      series,
      debtPickupsCount,
      debtPickupsOverdue,
      debtPickupList,
      debtUnderived,
    ] = await Promise.all([
      query<{ active_products: string; inventory_value: string; low_stock: string; out_of_stock: string }>(
        `WITH product_stock AS (
           SELECT p.id, p.min_stock, p.cost, COALESCE(SUM(sb.quantity), 0) AS qty
           FROM products p
           LEFT JOIN stock_balances sb ON sb.product_id = p.id ${locFilterBal}
           WHERE p.is_active
           GROUP BY p.id, p.min_stock, p.cost
         )
         SELECT
           COUNT(*)::text AS active_products,
           COALESCE(SUM(qty * cost) FILTER (WHERE cost IS NOT NULL), 0)::text AS inventory_value,
           COUNT(*) FILTER (WHERE qty > 0 AND qty <= min_stock)::text AS low_stock,
           COUNT(*) FILTER (WHERE qty = 0)::text AS out_of_stock
         FROM product_stock`
      ),
      query<{ entradas: string; salidas: string }>(
        `SELECT
           COALESCE(SUM(quantity) FILTER (WHERE type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA')), 0) AS entradas,
           COALESCE(SUM(quantity) FILTER (WHERE type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA')), 0) AS salidas
         FROM stock_movements m
         WHERE m.created_at >= date_trunc('day', now()) ${locFilter}`
      ),
      query<{ total: string }>(`SELECT COUNT(*) total FROM transfers WHERE status = 'EN_TRANSITO'`),
      query(
        `SELECT t.id, t.number, lo.name AS origin_name, ld.name AS destination_name, t.created_at
         FROM transfers t
         JOIN locations lo ON lo.id = t.origin_location_id
         JOIN locations ld ON ld.id = t.destination_location_id
         WHERE t.status = 'EN_TRANSITO' ORDER BY t.created_at DESC LIMIT 6`
      ),
      query(
        `SELECT m.id, m.type, m.quantity, m.created_at, p.name AS product_name, p.code AS product_code,
                l.name AS location_name, u.full_name AS user_name, m.reference_number
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         JOIN locations l ON l.id = m.location_id
         JOIN users u ON u.id = m.user_id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 10`
      ),
      query(
        `SELECT l.id, l.code, l.name, l.type,
                COALESCE(SUM(sb.quantity), 0) AS units,
                COUNT(sb.product_id) FILTER (WHERE sb.quantity > 0) AS skus,
                COALESCE(SUM(sb.quantity * p.cost) FILTER (WHERE p.cost IS NOT NULL), 0) AS value
         FROM locations l
         LEFT JOIN stock_balances sb ON sb.location_id = l.id
         LEFT JOIN products p ON p.id = sb.product_id
         WHERE l.is_active
         GROUP BY l.id, l.code, l.name, l.type
         ORDER BY l.type DESC, l.code`
      ),
      query(
        `SELECT d::date AS day,
                COALESCE(SUM(m.quantity) FILTER (WHERE m.type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA')), 0) AS entradas,
                COALESCE(SUM(m.quantity) FILTER (WHERE m.type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA')), 0) AS salidas
         FROM generate_series(date_trunc('day', now()) - ($1 || ' days')::interval, date_trunc('day', now()), '1 day') d
         LEFT JOIN stock_movements m
           ON m.created_at >= d AND m.created_at < d + interval '1 day' ${locFilter}
         GROUP BY d ORDER BY d`,
        [days]
      ),
      // ===== Deudas con clientes =====
      // Retiros activos (incluye PARCIAL: sigue debiendo saldo)
      query<{ total: string }>(
        `SELECT COUNT(*) total FROM pending_deliveries
         WHERE status IN ('PENDIENTE','EN_PREPARACION','LISTO_RETIRO','PARCIAL')`
      ),
      // Vencidos: activos con mas de 48h SIN ninguna reserva vigente
      // (misma condicion que usa el auto-cancel de la migration 014)
      query<{ total: string }>(
        `SELECT COUNT(*) total FROM pending_deliveries pd
         WHERE pd.status IN ('PENDIENTE','EN_PREPARACION','LISTO_RETIRO','PARCIAL')
           AND pd.created_at < now() - interval '48 hours'
           AND NOT EXISTS (
             SELECT 1 FROM stock_reservations sr
             WHERE sr.reference_type = 'PENDING_DELIVERY' AND sr.reference_id = pd.id
               AND sr.status IN ('ACTIVA','PARCIAL')
               AND (sr.expires_at IS NULL OR sr.expires_at > now())
           )`
      ),
      // Ordenes de retiro pendientes, mas viejas primero, con unidades debidas
      query(
        `SELECT pd.id, pd.number, pd.status, pd.created_at,
                pl.name AS pickup_location_name, pl.code AS pickup_location_code,
                pd.customer_name, pd.customer_phone,
                COALESCE((SELECT SUM(pdi.quantity_reserved - pdi.quantity_delivered)
                          FROM pending_delivery_items pdi
                          WHERE pdi.pending_delivery_id = pd.id), 0) AS pending_units
         FROM pending_deliveries pd
         JOIN locations pl ON pl.id = pd.pickup_location_id
         WHERE pd.status IN ('PENDIENTE','EN_PREPARACION','LISTO_RETIRO','PARCIAL')
         ORDER BY pd.created_at ASC
         LIMIT 6`
      ),
      // Un solo cálculo de faltantes: lista (6) y total salen del mismo CTE.
      query<{ total: string; items: Array<Record<string, unknown>> }>(
        `WITH owed AS (
           SELECT di.delivery_id, di.product_id,
                  GREATEST(di.quantity, COALESCE(di.requested_quantity, di.quantity))
                    - COALESCE(di.quantity_delivered, 0) AS owed
           FROM delivery_items di
           JOIN deliveries d2 ON d2.id = di.delivery_id
           WHERE d2.status IN ('CONFIRMADO', 'PARCIAL')
         ),
         withdrawn AS (
           SELECT pd.delivery_id, pdi.product_id, SUM(pdi.quantity_delivered) AS withdrawn
           FROM pending_deliveries pd
           JOIN pending_delivery_items pdi ON pdi.pending_delivery_id = pd.id
           WHERE pdi.quantity_delivered > 0 AND pd.status <> 'CANCELADO'
           GROUP BY pd.delivery_id, pdi.product_id
         ),
         underived AS (
           SELECT oi.delivery_id,
                  COUNT(*) FILTER (WHERE oi.owed > COALESCE(wd.withdrawn, 0)) AS shortfall_lines,
                  COALESCE(SUM(GREATEST(oi.owed - COALESCE(wd.withdrawn, 0), 0)), 0) AS shortfall_units
           FROM owed oi
           LEFT JOIN withdrawn wd
             ON wd.delivery_id = oi.delivery_id AND wd.product_id = oi.product_id
           GROUP BY oi.delivery_id
           HAVING SUM(GREATEST(oi.owed - COALESCE(wd.withdrawn, 0), 0)) > 0
         ),
         top_items AS (
           SELECT d.id, d.number, d.status, d.created_at, u.shortfall_lines, u.shortfall_units
           FROM deliveries d
           JOIN underived u ON u.delivery_id = d.id
           ORDER BY d.created_at DESC
           LIMIT 6
         )
         SELECT
           (SELECT COUNT(*)::text FROM underived) AS total,
           COALESCE((SELECT json_agg(row_to_json(t)) FROM top_items t), '[]'::json) AS items`
      ),
    ]);

    res.json({
      activeProducts: Number(inventoryStats.rows[0].active_products),
      inventoryValue: Number(inventoryStats.rows[0].inventory_value),
      lowStock: Number(inventoryStats.rows[0].low_stock),
      outOfStock: Number(inventoryStats.rows[0].out_of_stock),
      entriesToday: Number(today.rows[0].entradas),
      exitsToday: Number(today.rows[0].salidas),
      pendingTransfersCount: Number(pendingTransfersCount.rows[0].total),
      pendingTransfers: pendingTransfersList.rows,
      recentMovements: recent.rows.map((r: Record<string, unknown>) => ({ ...r, quantity: Number(r.quantity) })),
      byLocation: byLocation.rows.map((r: Record<string, unknown>) => ({
        ...r, units: Number(r.units), skus: Number(r.skus), value: Number(r.value),
      })),
      series: series.rows.map((r: Record<string, unknown>) => ({
        day: r.day, entradas: Number(r.entradas), salidas: Number(r.salidas),
      })),
      debts: {
        pickupsPending: Number(debtPickupsCount.rows[0].total),
        pickupsOverdue: Number(debtPickupsOverdue.rows[0].total),
        pickupOrders: debtPickupList.rows.map((r: Record<string, unknown>) => ({
          ...r, pending_units: Number(r.pending_units),
        })),
        underivedDeliveries: debtUnderived.rows[0].items.map((r) => ({
          ...r, shortfall_lines: Number(r.shortfall_lines), shortfall_units: Number(r.shortfall_units),
        })),
        underivedCount: Number(debtUnderived.rows[0].total),
      },
    });
  })
);

export default router;
