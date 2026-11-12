"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = require("../../db/pool");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('reports.read'));
// Stock actual por producto y ubicacion (consolidado + detalle)
router.get('/stock-by-location', (0, errorHandler_1.asyncH)(async (req, res) => {
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const params = [];
    const where = ['p.is_active'];
    if (locationId) {
        params.push(locationId);
        where.push(`sb.location_id = $${params.length}`);
    }
    const rows = await (0, pool_1.query)(`SELECT p.code, p.name AS product_name, p.brand, p.unit, p.min_stock,
              l.name AS location_name, l.code AS location_code, sb.quantity
       FROM stock_balances sb
       JOIN products p ON p.id = sb.product_id
       JOIN locations l ON l.id = sb.location_id
       WHERE ${where.join(' AND ')} AND sb.quantity <> 0
       ORDER BY l.type DESC, l.code, p.name`, params);
    res.json({ rows: rows.rows });
}));
// Proveedores activos del maestro de datos.
router.get('/suppliers', (0, errorHandler_1.asyncH)(async (_req, res) => {
    const rows = await (0, pool_1.query)(`SELECT id, name FROM suppliers WHERE is_active ORDER BY name`);
    res.json({ suppliers: rows.rows });
}));
// Catálogo completo por proveedor. La relación primaria define el proveedor asignado
// a cada producto; se conserva la relación secundaria para compras históricas.
router.get('/products-by-supplier', (0, errorHandler_1.asyncH)(async (req, res) => {
    const supplierId = (0, pagination_1.intParam)(req.query.supplierId);
    const rows = await (0, pool_1.query)(`
      SELECT s.id AS supplier_id,s.name AS supplier,
             p.id AS product_id,p.code,p.name,p.brand,p.unit,p.min_stock,
             COALESCE(stock.total_qty,0) AS total_qty
      FROM products p
      JOIN product_suppliers ps ON ps.product_id=p.id AND ps.is_primary=true
      JOIN suppliers s ON s.id=ps.supplier_id AND s.is_active
      LEFT JOIN (
        SELECT product_id,SUM(quantity-COALESCE(reserved_quantity,0)) AS total_qty
        FROM stock_balances GROUP BY product_id
      ) stock ON stock.product_id=p.id
      WHERE p.is_active AND ($1::int IS NULL OR s.id=$1)
      ORDER BY s.name,p.brand,p.name
    `, [supplierId ?? null]);
    res.json({ rows: rows.rows.map((r) => ({ ...r, total_qty: Number(r.total_qty) })) });
}));
// Productos bajo mínimo agrupados por cada proveedor relacionado en el maestro.
// El mínimo se compara contra stock disponible (físico menos reservas activas).
router.get('/low-stock-by-supplier', (0, errorHandler_1.asyncH)(async (req, res) => {
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const supplierId = (0, pagination_1.intParam)(req.query.supplierId);
    const rows = await (0, pool_1.query)(`WITH stock_summary AS (
         SELECT product_id, SUM(quantity - COALESCE(reserved_quantity, 0)) AS available_qty
         FROM stock_balances
         WHERE ($1::int IS NULL OR location_id = $1)
         GROUP BY product_id
       )
       SELECT COALESCE(s.name, '(Sin proveedor asociado)') AS supplier,
              p.code, p.name, p.brand, p.unit, p.min_stock,
              COALESCE(selected_location.name, 'Todas las ubicaciones') AS location_name,
              COALESCE(stock_summary.available_qty, 0) AS total_qty
       FROM products p
       LEFT JOIN stock_summary ON stock_summary.product_id = p.id
       LEFT JOIN product_suppliers ps ON ps.product_id = p.id AND ps.is_primary=true
         AND EXISTS (SELECT 1 FROM suppliers active_supplier WHERE active_supplier.id = ps.supplier_id AND active_supplier.is_active)
       LEFT JOIN suppliers s ON s.id = ps.supplier_id AND s.is_active
       LEFT JOIN locations selected_location ON selected_location.id = $1
       WHERE p.is_active AND p.min_stock > 0
         AND COALESCE(stock_summary.available_qty, 0) <= p.min_stock
         AND ($2::int IS NULL OR s.id = $2)
       ORDER BY supplier, total_qty ASC, p.name`, [locationId ?? null, supplierId ?? null]);
    res.json({ rows: rows.rows.map((row) => ({ ...row, total_qty: Number(row.total_qty) })) });
}));
// Productos con bajo stock
router.get('/low-stock', (0, errorHandler_1.asyncH)(async (req, res) => {
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const locFilter = locationId ? 'AND sb.location_id = ' + locationId : '';
    const rows = await (0, pool_1.query)(`SELECT p.code, p.name, p.brand, p.unit, p.min_stock,
              COALESCE(SUM(sb.quantity - COALESCE(sb.reserved_quantity, 0)) FILTER (WHERE true ${locFilter}), 0) AS total_qty
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       WHERE p.is_active
       GROUP BY p.id, p.code, p.name, p.brand, p.unit, p.min_stock
       HAVING COALESCE(SUM(sb.quantity - COALESCE(sb.reserved_quantity, 0)) FILTER (WHERE true ${locFilter}), 0) > 0
          AND COALESCE(SUM(sb.quantity - COALESCE(sb.reserved_quantity, 0)) FILTER (WHERE true ${locFilter}), 0) <= p.min_stock
       ORDER BY p.name`);
    res.json({ rows: rows.rows.map((r) => ({ ...r, total_qty: Number(r.total_qty) })) });
}));
// Productos sin existencias
router.get('/out-of-stock', (0, errorHandler_1.asyncH)(async (req, res) => {
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const locFilter = locationId ? 'AND sb.location_id = ' + locationId : '';
    const rows = await (0, pool_1.query)(`SELECT p.code, p.name, p.brand, p.unit, p.min_stock,
              COALESCE(SUM(sb.quantity - COALESCE(sb.reserved_quantity, 0)) FILTER (WHERE true ${locFilter}), 0) AS total_qty
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id
       WHERE p.is_active
       GROUP BY p.id, p.code, p.name, p.brand, p.unit, p.min_stock
       HAVING COALESCE(SUM(sb.quantity - COALESCE(sb.reserved_quantity, 0)) FILTER (WHERE true ${locFilter}), 0) = 0
       ORDER BY p.name`);
    res.json({ rows: rows.rows.map((r) => ({ ...r, total_qty: Number(r.total_qty) })) });
}));
// Entradas y salidas por periodo
router.get('/in-out-period', (0, errorHandler_1.asyncH)(async (req, res) => {
    const from = (0, pagination_1.strParam)(req.query.from) ?? '1900-01-01';
    const to = (0, pagination_1.strParam)(req.query.to) ?? '2999-12-31';
    const rows = await (0, pool_1.query)(`SELECT l.name AS location_name,
              COALESCE(SUM(m.quantity) FILTER (WHERE m.type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA')), 0) AS entradas,
              COALESCE(SUM(m.quantity) FILTER (WHERE m.type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA')), 0) AS salidas,
              COUNT(*) FILTER (WHERE m.type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA')) AS entradas_cant,
              COUNT(*) FILTER (WHERE m.type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA')) AS salidas_cant
       FROM stock_movements m
       JOIN locations l ON l.id = m.location_id
       WHERE m.created_at >= $1::timestamptz AND m.created_at <= ($2::date + interval '1 day')
       GROUP BY l.name ORDER BY l.name`, [from, to]);
    res.json({ rows: rows.rows.map((r) => ({
            ...r, entradas: Number(r.entradas), salidas: Number(r.salidas),
            entradas_cant: Number(r.entradas_cant), salidas_cant: Number(r.salidas_cant),
        })) });
}));
// Movimientos por usuario
router.get('/movements-by-user', (0, errorHandler_1.asyncH)(async (req, res) => {
    const from = (0, pagination_1.strParam)(req.query.from) ?? '1900-01-01';
    const to = (0, pagination_1.strParam)(req.query.to) ?? '2999-12-31';
    const rows = await (0, pool_1.query)(`SELECT u.full_name AS user_name, m.type,
              COUNT(*) AS cant, COALESCE(SUM(m.quantity), 0) AS unidades
       FROM stock_movements m
       JOIN users u ON u.id = m.user_id
       WHERE m.created_at >= $1::timestamptz AND m.created_at <= ($2::date + interval '1 day')
       GROUP BY u.full_name, m.type ORDER BY u.full_name, m.type`, [from, to]);
    res.json({ rows: rows.rows.map((r) => ({ ...r, cant: Number(r.cant), unidades: Number(r.unidades) })) });
}));
// Entregas por sucursal
router.get('/deliveries-by-location', (0, errorHandler_1.asyncH)(async (req, res) => {
    const from = (0, pagination_1.strParam)(req.query.from) ?? '1900-01-01';
    const to = (0, pagination_1.strParam)(req.query.to) ?? '2999-12-31';
    const rows = await (0, pool_1.query)(`SELECT l.name AS location_name,
              COUNT(*) FILTER (WHERE d.status = 'CONFIRMADO') AS confirmadas,
              COUNT(*) FILTER (WHERE d.status = 'BORRADOR') AS borradores,
              COUNT(*) FILTER (WHERE d.status = 'ANULADO') AS anuladas,
              COALESCE(SUM(di.quantity) FILTER (WHERE d.status = 'CONFIRMADO'), 0) AS unidades_entregadas
       FROM deliveries d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN delivery_items di ON di.delivery_id = d.id
       WHERE d.created_at >= $1::timestamptz AND d.created_at <= ($2::date + interval '1 day')
       GROUP BY l.name ORDER BY l.name`, [from, to]);
    res.json({ rows: rows.rows.map((r) => ({
            ...r,
            confirmadas: Number(r.confirmadas), borradores: Number(r.borradores),
            anuladas: Number(r.anuladas), unidades_entregadas: Number(r.unidades_entregadas),
        })) });
}));
// Transferencias pendientes
router.get('/pending-transfers', (0, errorHandler_1.asyncH)(async (_req, res) => {
    const rows = await (0, pool_1.query)(`SELECT t.number, lo.name AS origin_name, ld.name AS destination_name, t.created_at,
              cu.full_name AS created_by_name,
              (SELECT COUNT(*) FROM transfer_items WHERE transfer_id = t.id) AS line_count,
              (SELECT COALESCE(SUM(quantity_sent),0) FROM transfer_items WHERE transfer_id = t.id) AS units
       FROM transfers t
       JOIN locations lo ON lo.id = t.origin_location_id
       JOIN locations ld ON ld.id = t.destination_location_id
       JOIN users cu ON cu.id = t.created_by
       WHERE t.status = 'EN_TRANSITO'
       ORDER BY t.created_at`);
    res.json({ rows: rows.rows.map((r) => ({
            ...r, line_count: Number(r.line_count), units: Number(r.units),
        })) });
}));
// Diferencias de inventario (items ajustados en recuentos aplicados)
router.get('/inventory-differences', (0, errorHandler_1.asyncH)(async (req, res) => {
    const from = (0, pagination_1.strParam)(req.query.from) ?? '1900-01-01';
    const to = (0, pagination_1.strParam)(req.query.to) ?? '2999-12-31';
    const rows = await (0, pool_1.query)(`SELECT sc.number AS count_number, l.name AS location_name, sc.applied_at,
              p.code, p.name AS product_name,
              si.system_quantity, si.counted_quantity
       FROM stock_count_items si
       JOIN stock_counts sc ON sc.id = si.count_id
       JOIN locations l ON l.id = sc.location_id
       JOIN products p ON p.id = si.product_id
       WHERE sc.status = 'APLICADO' AND si.adjusted
         AND sc.applied_at >= $1::timestamptz AND sc.applied_at <= ($2::date + interval '1 day')
       ORDER BY sc.applied_at DESC, p.name`, [from, to]);
    res.json({ rows: rows.rows.map((r) => ({
            ...r,
            system_quantity: Number(r.system_quantity),
            counted_quantity: Number(r.counted_quantity),
        })) });
}));
/**
 * Rotación de productos (mejora 13): qué productos se mueven, por sucursal,
 * en un período. Salidas por venta (SALIDA: entregas y retiros) y transferencias
 * (TRANS_SALIDA entre sucursales). Los AJUSTE_NEG quedan excluidos a
 * propósito: son mermas/inventariado, no rotación de mercadería.
 */
router.get('/rotation', (0, errorHandler_1.asyncH)(async (req, res) => {
    const from = (0, pagination_1.strParam)(req.query.from);
    const to = (0, pagination_1.strParam)(req.query.to);
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const fromDate = from ? `${from} 00:00:00` : new Date(Date.now() - days * 86400000).toISOString();
    const toDate = to ? `${to} 23:59:59.999` : '2999-01-01';
    const locFilter = locationId ? `AND l.id = ${locationId}` : '';
    const rows = await (0, pool_1.query)(`SELECT t.product_id, t.code, t.name, t.unit,
              COALESCE(SUM(t.units), 0) AS total,
              COALESCE(SUM(t.salidas_venta), 0) AS salidas_venta,
              COALESCE(SUM(t.transferido), 0) AS transferido,
              COALESCE(jsonb_agg(jsonb_build_object('loc', t.loc, 'units', t.units) ORDER BY t.loc), '[]'::jsonb) AS by_location
       FROM (
         SELECT m.product_id, p.code, p.name, p.unit, l.code AS loc,
                SUM(m.quantity) FILTER (WHERE m.type = 'SALIDA') AS salidas_venta,
                SUM(m.quantity) FILTER (WHERE m.type = 'TRANS_SALIDA') AS transferido,
                SUM(m.quantity) AS units
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         JOIN locations l ON l.id = m.location_id
         WHERE m.created_at >= $1::timestamptz AND m.created_at <= $2::timestamptz
           AND m.type IN ('SALIDA', 'TRANS_SALIDA')
           ${locFilter}
         GROUP BY m.product_id, p.code, p.name, p.unit, l.code
       ) t
       GROUP BY t.product_id, t.code, t.name, t.unit
       ORDER BY total DESC
       LIMIT 100`, [fromDate, toDate]);
    res.json({
        rows: rows.rows.map((r) => ({
            ...r,
            total: Number(r.total),
            salidas_venta: Number(r.salidas_venta),
            transferido: Number(r.transferido),
            by_location: r.by_location.map((x) => ({
                loc: x.loc, units: Number(x.units),
            })),
        })),
        period: { from: fromDate, to: toDate === '2999-01-01' ? 'hoy' : toDate, days },
    });
}));
/**
 * Deudas por cliente (mejora 11): qué le está debiendo la operación,
 * agrupado por cliente según las órdenes de retiro activas.
 */
router.get('/debts-customers', (0, errorHandler_1.asyncH)(async (_req, res) => {
    const rows = await (0, pool_1.query)(`SELECT COALESCE(NULLIF(TRIM(pd.customer_name), ''), '(sin dato de cliente)') AS customer,
                MAX(pd.customer_phone) AS customer_phone,
                COUNT(DISTINCT pd.id) AS orders,
                COALESCE(SUM(pdi.quantity_reserved - pdi.quantity_delivered), 0) AS units_pending,
                MIN(pd.created_at) AS oldest_created_at
         FROM pending_deliveries pd
         LEFT JOIN pending_delivery_items pdi ON pdi.pending_delivery_id = pd.id
         WHERE pd.status IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL')
         GROUP BY COALESCE(NULLIF(TRIM(pd.customer_name), ''), '(sin dato de cliente)')
         ORDER BY units_pending DESC, oldest_created_at ASC`);
    res.json({
        rows: rows.rows.map((r) => ({
            ...r,
            orders: Number(r.orders),
            units_pending: Number(r.units_pending),
        })),
    });
}));
exports.default = router;
