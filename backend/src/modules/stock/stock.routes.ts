import { Router } from 'express';
import { query } from '../../db/pool';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired } from '../../middleware/auth';
import { intParam, strParam } from '../../lib/pagination';

const router = Router();
router.use(authRequired);

/**
 * Consulta de stock.
 * locationId: filtra por ubicacion concreta.
 * filter: all | low | out
 * q: busqueda por nombre/codigo/marca/codigo de barras
 * Devuelve el saldo del producto en CADA ubicacion activa + total.
 */
router.get(
  '/',
  asyncH(async (req, res) => {
    const locationId = intParam(req.query.locationId);
    const filter = strParam(req.query.filter) ?? 'all';
    const q = strParam(req.query.q);
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200));

    const params: unknown[] = [];
    const having: string[] = [];
    if (q) { params.push(`%${q}%`); having.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.barcode ILIKE $${params.length} OR p.brand ILIKE $${params.length})`); }

    let stockFilter = '';
    if (filter === 'low') stockFilter = 'WHERE t.total_qty > 0 AND t.total_qty <= t.min_stock';
    if (filter === 'out') stockFilter = 'WHERE t.total_qty = 0';
    if (filter === 'lowzero') stockFilter = 'WHERE t.total_qty <= t.min_stock';

    const locFilter = locationId ? 'AND sb.location_id = ' + locationId : '';

    // Productos y ubicaciones son lecturas independientes: ejecutarlas en
    // paralelo reduce la latencia total de esta pantalla.
    const [rows, locations] = await Promise.all([
      query(
        `SELECT t.*,
                (t.total_qty - t.total_reserved) AS available
         FROM (
            SELECT p.id, p.code, p.name, p.brand, p.unit, p.min_stock, p.cost,
                   c.name AS category_name,
                   COALESCE(SUM(sb.quantity) FILTER (WHERE true ${locFilter}), 0) AS total_qty,
                   COALESCE(SUM(sb.reserved_quantity) FILTER (WHERE true ${locFilter}), 0) AS total_reserved,
                   COALESCE(jsonb_object_agg(l.code, COALESCE(sb.quantity, 0))
                            FILTER (WHERE l.id IS NOT NULL), '{}'::jsonb) AS by_location,
                   COALESCE(jsonb_object_agg(l.code, COALESCE(sb.reserved_quantity, 0))
                            FILTER (WHERE l.id IS NOT NULL), '{}'::jsonb) AS by_reserved
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN stock_balances sb ON sb.product_id = p.id
            LEFT JOIN locations l ON l.id = sb.location_id AND l.is_active
            ${having.length ? `WHERE ${having.join(' AND ')}` : ''}
            GROUP BY p.id, c.name
         ) t ${stockFilter}
         ORDER BY t.name
         LIMIT ${limit}`,
        params
      ),
      query(`SELECT id, code, name FROM locations WHERE is_active ORDER BY type DESC, code`),
    ]);

    res.json({
      locations: locations.rows,
      products: rows.rows.map((r: Record<string, unknown>) => ({
        ...r,
        total_qty: Number(r.total_qty ?? 0),
        total_reserved: Number(r.total_reserved ?? 0),
        available: Number(r.available ?? 0),
      })),
    });
  })
);

export default router;
