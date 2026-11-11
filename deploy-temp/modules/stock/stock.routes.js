"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = require("../../db/pool");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
/**
 * Consulta de stock.
 * locationId: filtra por ubicacion concreta.
 * filter: all | low | out
 * q: busqueda por nombre/codigo/marca/codigo de barras
 * Devuelve el saldo del producto en CADA ubicacion activa + total.
 */
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const filter = (0, pagination_1.strParam)(req.query.filter) ?? 'all';
    const q = (0, pagination_1.strParam)(req.query.q);
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200));
    const params = [];
    const having = [];
    if (q) {
        params.push(`%${q}%`);
        having.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.barcode ILIKE $${params.length} OR p.brand ILIKE $${params.length})`);
    }
    let stockFilter = '';
    if (filter === 'low')
        stockFilter = 'WHERE t.total_qty > 0 AND t.total_qty <= t.min_stock';
    if (filter === 'out')
        stockFilter = 'WHERE t.total_qty = 0';
    if (filter === 'lowzero')
        stockFilter = 'WHERE t.total_qty <= t.min_stock';
    const locFilter = locationId ? 'AND sb.location_id = ' + locationId : '';
    // Productos y ubicaciones son lecturas independientes: ejecutarlas en
    // paralelo reduce la latencia total de esta pantalla.
    const [rows, locations] = await Promise.all([
        (0, pool_1.query)(`SELECT t.*,
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
         LIMIT ${limit}`, params),
        (0, pool_1.query)(`SELECT id, code, name FROM locations WHERE is_active ORDER BY type DESC, code`),
    ]);
    res.json({
        locations: locations.rows,
        products: rows.rows.map((r) => ({
            ...r,
            total_qty: Number(r.total_qty ?? 0),
            total_reserved: Number(r.total_reserved ?? 0),
            available: Number(r.available ?? 0),
        })),
    });
}));
exports.default = router;
