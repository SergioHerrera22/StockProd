"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const audit_service_1 = require("../../services/audit.service");
const env_1 = require("../../config/env");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
/**
 * Sesiones activas.
 * - Admin: ve todas las sesiones activas del sistema.
 * - Otros usuarios: solo las propias.
 */
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const isAdmin = req.user.role === 'ADMIN';
    const params = [];
    const where = `
      revoked_at IS NULL
      AND expires_at > now()
      ${env_1.config.sessionIdleMinutes > 0 ? `AND last_seen_at >= now() - ($1::numeric * interval '1 minute')` : ''}`;
    if (env_1.config.sessionIdleMinutes > 0)
        params.push(env_1.config.sessionIdleMinutes);
    if (!isAdmin) {
        params.push(req.user.id);
    }
    const r = await (0, pool_1.query)(`SELECT s.id, s.user_id, u.full_name AS user_name, u.username, l.name AS location_name,
              s.ip, s.user_agent, s.created_at, s.last_seen_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN locations l ON l.id = u.default_location_id
       WHERE ${where}
       ${!isAdmin ? `AND s.user_id = $${params.length}` : ''}
       ORDER BY s.last_seen_at DESC`, params);
    res.json({
        sessions: r.rows.map((row) => ({
            ...row,
            is_own: row.user_id === req.user.id,
        })),
    });
}));
/** Desconectar una sesión. Admin: cualquiera. Usuario: solo la propia. */
router.post('/:id/revoke', (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = String(req.params.id);
    const isAdmin = req.user.role === 'ADMIN';
    const target = await (0, pool_1.query)('SELECT user_id FROM sessions WHERE id = $1', [id]);
    if (!target.rows[0])
        throw errors_1.ApiError.notFound('Sesión no encontrada');
    if (!isAdmin && target.rows[0].user_id !== req.user.id) {
        throw errors_1.ApiError.forbidden('Solo podés cerrar tus propias sesiones');
    }
    await (0, pool_1.query)(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'Cerrada por el administrador'
       WHERE id = $1 AND revoked_at IS NULL`, [id]);
    await (0, audit_service_1.writeAudit)(pool_1.pool, {
        userId: req.user.id,
        action: 'SESSION_REVOKE',
        entity: 'session',
        entityId: null,
        details: { sessionId: id, targetUser: target.rows[0].user_id },
        ip: req.ip,
    });
    res.json({ ok: true });
}));
exports.default = router;
