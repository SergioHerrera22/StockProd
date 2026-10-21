import { Router } from 'express';
import { query } from '../../db/pool';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { intParam, strParam } from '../../lib/pagination';

const router = Router();
router.use(authRequired, requirePerm('reports.read'));

// Stock actual por producto y ubicacion (consolidado + detalle)
router.get(
  '/stock-by-location',
  asyncH(async (req, res) => {
    const locationId = intParam(req.query.locationId);
    const params: unknown[] = [];
    const where: string[] = ['p.is_active'];
    if (locationId) { params.push(locationId); where.push(`sb.location_id = $${params.length}`); }
    const rows = await query(
      `SELECT p.code, p.name AS product_name, p.brand, p.unit, p.min_stock, p.cost,
              l.name AS location_name, l.code AS location_code, sb.quantity,
              (sb.quantity * COALESCE(p.cost, 0)) AS value
       FROM stock_balances sb
       JOIN products p ON p.id = sb.product_id
       JOIN locations l ON l.id = sb.location_id
       WHERE ${where.join(' AND ')} AND sb.quantity <> 0
       ORDER BY l.type DESC, l.code, p.name`,
      params
    );
    res.json({ rows: rows.rows });
  })
);

// Productos con bajo stock
router.get(
  '/low-stock',
  asyncH(async (req, res) => {
    const locationId = intParam(req.query.locationId);
    const locFilter = locationId ? 'AND sb.location_id = ' + locationId : '';
    const rows = await query(
      `SELECT p.code, p.name, p.brand, p.unit, p.min_stock,
              COALESCE(SUM(sb.quantity) FILTER (WHERE true ${locFilter}), 0) AS total_qty
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       WHERE p.is_active
       GROUP BY p.id, p.code, p.name, p.brand, p.unit, p.min_stock
       HAVING COALESCE(SUM(sb.quantity) FILTER (WHERE true ${locFilter}), 0) > 0
          AND COALESCE(SUM(sb.quantity) FILTER (WHERE true ${locFilter}), 0) <= p.min_stock
       ORDER BY p.name`
    );
    res.json({ rows: rows.rows.map((r: Record<string, unknown>) => ({ ...r, total_qty: Number(r.total_qty) })) });
  })
);

// Productos sin existencias
router.get(
  '/out-of-stock',
  asyncH(async (req, res) => {
    const locationId = intParam(req.query.locationId);
    const locFilter = locationId ? 'AND sb.location_id = ' + locationId : '';
    const rows = await query(
      `SELECT p.code, p.name, p.brand, p.unit, p.min_stock,
              COALESCE(SUM(sb.quantity) FILTER (WHERE true ${locFilter}), 0) AS total_qty
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       WHERE p.is_active
       GROUP BY p.id, p.code, p.name, p.brand, p.unit, p.min_stock
       HAVING COALESCE(SUM(sb.quantity) FILTER (WHERE true ${locFilter}), 0) = 0
       ORDER BY p.name`
    );
    res.json({ rows: rows.rows.map((r: Record<string, unknown>) => ({ ...r, total_qty: Number(r.total_qty) })) });
  })
);

// Entradas y salidas por periodo
router.get(
  '/in-out-period',
  asyncH(async (req, res) => {
    const from = strParam(req.query.from) ?? '1900-01-01';
    const to = strParam(req.query.to) ?? '2999-12-31';
    const rows = await query(
      `SELECT l.name AS location_name,
              COALESCE(SUM(m.quantity) FILTER (WHERE m.type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA')), 0) AS entradas,
              COALESCE(SUM(m.quantity) FILTER (WHERE m.type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA')), 0) AS salidas,
              COUNT(*) FILTER (WHERE m.type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA')) AS entradas_cant,
              COUNT(*) FILTER (WHERE m.type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA')) AS salidas_cant
       FROM stock_movements m
       JOIN locations l ON l.id = m.location_id
       WHERE m.created_at >= $1::timestamptz AND m.created_at <= ($2::date + interval '1 day')
       GROUP BY l.name ORDER BY l.name`,
      [from, to]
    );
    res.json({ rows: rows.rows.map((r: Record<string, unknown>) => ({
      ...r, entradas: Number(r.entradas), salidas: Number(r.salidas),
      entradas_cant: Number(r.entradas_cant), salidas_cant: Number(r.salidas_cant),
    })) });
  })
);

// Movimientos por usuario
router.get(
  '/movements-by-user',
  asyncH(async (req, res) => {
    const from = strParam(req.query.from) ?? '1900-01-01';
    const to = strParam(req.query.to) ?? '2999-12-31';
    const rows = await query(
      `SELECT u.full_name AS user_name, m.type,
              COUNT(*) AS cant, COALESCE(SUM(m.quantity), 0) AS unidades
       FROM stock_movements m
       JOIN users u ON u.id = m.user_id
       WHERE m.created_at >= $1::timestamptz AND m.created_at <= ($2::date + interval '1 day')
       GROUP BY u.full_name, m.type ORDER BY u.full_name, m.type`,
      [from, to]
    );
    res.json({ rows: rows.rows.map((r: Record<string, unknown>) => ({ ...r, cant: Number(r.cant), unidades: Number(r.unidades) })) });
  })
);

// Entregas por sucursal
router.get(
  '/deliveries-by-location',
  asyncH(async (req, res) => {
    const from = strParam(req.query.from) ?? '1900-01-01';
    const to = strParam(req.query.to) ?? '2999-12-31';
    const rows = await query(
      `SELECT l.name AS location_name,
              COUNT(*) FILTER (WHERE d.status = 'CONFIRMADO') AS confirmadas,
              COUNT(*) FILTER (WHERE d.status = 'BORRADOR') AS borradores,
              COUNT(*) FILTER (WHERE d.status = 'ANULADO') AS anuladas,
              COALESCE(SUM(di.quantity) FILTER (WHERE d.status = 'CONFIRMADO'), 0) AS unidades_entregadas
       FROM deliveries d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN delivery_items di ON di.delivery_id = d.id
       WHERE d.created_at >= $1::timestamptz AND d.created_at <= ($2::date + interval '1 day')
       GROUP BY l.name ORDER BY l.name`,
      [from, to]
    );
    res.json({ rows: rows.rows.map((r: Record<string, unknown>) => ({
      ...r,
      confirmadas: Number(r.confirmadas), borradores: Number(r.borradores),
      anuladas: Number(r.anuladas), unidades_entregadas: Number(r.unidades_entregadas),
    })) });
  })
);

// Transferencias pendientes
router.get(
  '/pending-transfers',
  asyncH(async (_req, res) => {
    const rows = await query(
      `SELECT t.number, lo.name AS origin_name, ld.name AS destination_name, t.created_at,
              cu.full_name AS created_by_name,
              (SELECT COUNT(*) FROM transfer_items WHERE transfer_id = t.id) AS line_count,
              (SELECT COALESCE(SUM(quantity_sent),0) FROM transfer_items WHERE transfer_id = t.id) AS units
       FROM transfers t
       JOIN locations lo ON lo.id = t.origin_location_id
       JOIN locations ld ON ld.id = t.destination_location_id
       JOIN users cu ON cu.id = t.created_by
       WHERE t.status = 'EN_TRANSITO'
       ORDER BY t.created_at`
    );
    res.json({ rows: rows.rows.map((r: Record<string, unknown>) => ({
      ...r, line_count: Number(r.line_count), units: Number(r.units),
    })) });
  })
);

// Diferencias de inventario (items ajustados en recuentos aplicados)
router.get(
  '/inventory-differences',
  asyncH(async (req, res) => {
    const from = strParam(req.query.from) ?? '1900-01-01';
    const to = strParam(req.query.to) ?? '2999-12-31';
    const rows = await query(
      `SELECT sc.number AS count_number, l.name AS location_name, sc.applied_at,
              p.code, p.name AS product_name,
              si.system_quantity, si.counted_quantity
       FROM stock_count_items si
       JOIN stock_counts sc ON sc.id = si.count_id
       JOIN locations l ON l.id = sc.location_id
       JOIN products p ON p.id = si.product_id
       WHERE sc.status = 'APLICADO' AND si.adjusted
         AND sc.applied_at >= $1::timestamptz AND sc.applied_at <= ($2::date + interval '1 day')
       ORDER BY sc.applied_at DESC, p.name`,
      [from, to]
    );
    res.json({ rows: rows.rows.map((r: Record<string, unknown>) => ({
      ...r,
      system_quantity: Number(r.system_quantity),
      counted_quantity: Number(r.counted_quantity),
    })) });
  })
);

// Valorizacion del inventario
router.get(
  '/inventory-value',
  asyncH(async (_req, res) => {
    const total = await query<{ value: string | null; products: string }>(
      `SELECT COALESCE(SUM(sb.quantity * p.cost), 0) AS value,
              COUNT(DISTINCT sb.product_id) AS products
       FROM stock_balances sb JOIN products p ON p.id = sb.product_id
       WHERE p.cost IS NOT NULL AND sb.quantity > 0`
    );
    const byLocation = await query(
      `SELECT l.name AS location_name,
              COALESCE(SUM(sb.quantity * p.cost), 0) AS value,
              COALESCE(SUM(sb.quantity), 0) AS units
       FROM locations l
       LEFT JOIN stock_balances sb ON sb.location_id = l.id
       LEFT JOIN products p ON p.id = sb.product_id AND p.cost IS NOT NULL
       WHERE l.is_active
       GROUP BY l.name ORDER BY l.name`
    );
    const withoutCost = await query<{ total: string }>(
      `SELECT COUNT(*) total FROM products p
       WHERE p.is_active AND p.cost IS NULL
         AND EXISTS (SELECT 1 FROM stock_balances sb WHERE sb.product_id = p.id AND sb.quantity > 0)`
    );
    res.json({
      totalValue: Number(total.rows[0].value ?? 0),
      productsWithValue: Number(total.rows[0].products),
      withoutCost: Number(withoutCost.rows[0].total),
      byLocation: byLocation.rows.map((r: Record<string, unknown>) => ({
        ...r, value: Number(r.value), units: Number(r.units),
      })),
    });
  })
);

export default router;
