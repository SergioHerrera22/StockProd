"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = require("../../db/pool");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('audit.read'));
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 30);
    const params = [];
    const where = [];
    const userId = (0, pagination_1.intParam)(req.query.userId);
    const action = (0, pagination_1.strParam)(req.query.action);
    const entity = (0, pagination_1.strParam)(req.query.entity);
    if (userId) {
        params.push(userId);
        where.push(`a.user_id = $${params.length}`);
    }
    if (action) {
        params.push(`%${action.toUpperCase()}%`);
        where.push(`a.action ILIKE $${params.length}`);
    }
    if (entity) {
        params.push(entity);
        where.push(`a.entity = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await (0, pool_1.query)(`SELECT COUNT(*) total FROM audit_logs a ${whereSql}`, params);
    const rows = await (0, pool_1.query)(`SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.ip, a.created_at,
              u.full_name AS user_name, u.username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${pageSize} OFFSET ${offset}`, params);
    res.json({ logs: rows.rows, total: Number(count.rows[0].total), page, pageSize });
}));
exports.default = router;
