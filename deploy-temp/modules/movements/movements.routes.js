"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = require("../../db/pool");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('movements.read'));
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 30);
    const params = [];
    const where = [];
    const productId = (0, pagination_1.intParam)(req.query.productId);
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const userId = (0, pagination_1.intParam)(req.query.userId);
    const type = (0, pagination_1.strParam)(req.query.type);
    const referenceType = (0, pagination_1.strParam)(req.query.referenceType);
    const from = (0, pagination_1.strParam)(req.query.from);
    const to = (0, pagination_1.strParam)(req.query.to);
    const q = (0, pagination_1.strParam)(req.query.q);
    if (productId) {
        params.push(productId);
        where.push(`m.product_id = $${params.length}`);
    }
    if (locationId) {
        params.push(locationId);
        where.push(`m.location_id = $${params.length}`);
    }
    if (userId) {
        params.push(userId);
        where.push(`m.user_id = $${params.length}`);
    }
    if (type) {
        params.push(type);
        where.push(`m.type = $${params.length}::movement_type`);
    }
    if (referenceType) {
        params.push(referenceType);
        where.push(`m.reference_type = $${params.length}::reference_type`);
    }
    if (from) {
        params.push(from);
        where.push(`m.created_at >= $${params.length}::timestamptz`);
    }
    if (to) {
        params.push(`${to} 23:59:59.999`);
        where.push(`m.created_at <= $${params.length}::timestamptz`);
    }
    if (q) {
        params.push(`%${q}%`);
        const n = params.length;
        where.push(`(p.name ILIKE $${n} OR p.code ILIKE $${n} OR m.reference_number ILIKE $${n} OR m.reason ILIKE $${n})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await (0, pool_1.query)(`SELECT COUNT(*) total FROM stock_movements m
       JOIN products p ON p.id = m.product_id ${whereSql}`, params);
    const rows = await (0, pool_1.query)(`SELECT m.id, m.type, m.quantity, m.balance_before, m.balance_after,
              m.reference_type, m.reference_id, m.reference_number, m.reason, m.notes, m.created_at,
              p.id AS product_id, p.code AS product_code, p.name AS product_name, p.unit,
              l.name AS location_name, u.full_name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       JOIN locations l ON l.id = m.location_id
       JOIN users u ON u.id = m.user_id
       ${whereSql}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${pageSize} OFFSET ${offset}`, params);
    res.json({
        movements: rows.rows.map((r) => ({
            ...r,
            quantity: Number(r.quantity),
            balance_before: Number(r.balance_before),
            balance_after: Number(r.balance_after),
        })),
        total: Number(count.rows[0].total),
        page, pageSize,
    });
}));
router.get('/export.csv', (0, errorHandler_1.asyncH)(async (req, res) => {
    // Libro de movimientos con los MISMOS filtros de la pantalla (mejora 11).
    // Cap de seguridad: 10000 filas por export (usá filtros de fecha para más).
    const params = [];
    const where = [];
    const productId = (0, pagination_1.intParam)(req.query.productId);
    const locationId = (0, pagination_1.intParam)(req.query.locationId);
    const userId = (0, pagination_1.intParam)(req.query.userId);
    const type = (0, pagination_1.strParam)(req.query.type);
    const from = (0, pagination_1.strParam)(req.query.from);
    const to = (0, pagination_1.strParam)(req.query.to);
    const q = (0, pagination_1.strParam)(req.query.q);
    if (productId) {
        params.push(productId);
        where.push(`m.product_id = $${params.length}`);
    }
    if (locationId) {
        params.push(locationId);
        where.push(`m.location_id = $${params.length}`);
    }
    if (userId) {
        params.push(userId);
        where.push(`m.user_id = $${params.length}`);
    }
    if (type) {
        params.push(type);
        where.push(`m.type = $${params.length}::movement_type`);
    }
    if (from) {
        params.push(from);
        where.push(`m.created_at >= $${params.length}::timestamptz`);
    }
    if (to) {
        params.push(`${to} 23:59:59.999`);
        where.push(`m.created_at <= $${params.length}::timestamptz`);
    }
    if (q) {
        params.push(`%${q}%`);
        const n = params.length;
        where.push(`(p.name ILIKE $${n} OR p.code ILIKE $${n} OR m.reference_number ILIKE $${n} OR m.reason ILIKE $${n})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await (0, pool_1.query)(`SELECT m.type, m.quantity, m.balance_after, m.created_at,
              m.reference_type, m.reference_number, m.reason, m.notes,
              p.code AS product_code, p.name AS product_name, p.unit,
              l.name AS location_name, u.full_name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       JOIN locations l ON l.id = m.location_id
       JOIN users u ON u.id = m.user_id
       ${whereSql}
       ORDER BY m.created_at ASC, m.id ASC    -- libro en orden cronologico real
       LIMIT 10000`, params);
    const esc = (v) => String(v ?? '').replace(/"/g, '""');
    const header = 'Fecha y hora;Tipo;Código;Producto;Sucursal;Cantidad;Saldo posterior;Referencia;Motivo;Usuario;Notas';
    const lines = rows.rows.map((r) => [
        new Date(r.created_at).toLocaleString('es-AR'),
        r.type, esc(r.product_code), esc(r.product_name), esc(r.location_name),
        Number(r.quantity), Number(r.balance_after),
        esc(r.reference_number), esc(r.reason), esc(r.user_name), esc(r.notes),
    ].join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="movimientos.csv"');
    res.send('\uFEFF' + [header, ...lines].join('\n'));
}));
router.get('/users', (0, errorHandler_1.asyncH)(async (_req, res) => {
    const r = await (0, pool_1.query)(`SELECT DISTINCT u.id, u.full_name FROM users u
       JOIN stock_movements m ON m.user_id = u.id ORDER BY u.full_name`);
    res.json({ users: r.rows });
}));
exports.default = router;
