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
      activeProducts,
      inventoryValue,
      lowStock,
      outOfStock,
      today,
      pendingTransfersCount,
      pendingTransfersList,
      recent,
      byLocation,
      series,
    ] = await Promise.all([
      query<{ total: string }>(`SELECT COUNT(*) total FROM products WHERE is_active`),
      query<{ value: string | null }>(
        `SELECT SUM(sb.quantity * p.cost) AS value
         FROM stock_balances sb JOIN products p ON p.id = sb.product_id
         WHERE p.cost IS NOT NULL AND p.is_active ${locFilterBal}`
      ),
      query<{ total: string }>(
        `SELECT COUNT(*) total FROM (
           SELECT p.id, COALESCE(SUM(sb.quantity), 0) AS qty, p.min_stock
           FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id ${locFilterBal}
           WHERE p.is_active GROUP BY p.id, p.min_stock
         ) t WHERE t.qty > 0 AND t.qty <= t.min_stock`
      ),
      query<{ total: string }>(
        `SELECT COUNT(*) total FROM (
           SELECT p.id, COALESCE(SUM(sb.quantity), 0) AS qty
           FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id ${locFilterBal}
           WHERE p.is_active GROUP BY p.id
         ) t WHERE t.qty = 0`
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
    ]);

    res.json({
      activeProducts: Number(activeProducts.rows[0].total),
      inventoryValue: Number(inventoryValue.rows[0].value ?? 0),
      lowStock: Number(lowStock.rows[0].total),
      outOfStock: Number(outOfStock.rows[0].total),
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
    });
  })
);

export default router;
