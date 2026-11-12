"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRequired = authRequired;
exports.requirePerm = requirePerm;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const errors_1 = require("../lib/errors");
const permissions_1 = require("../lib/permissions");
const pool_1 = require("../db/pool");
const logger_1 = require("../lib/logger");
function authRequired(req, _res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        return next(errors_1.ApiError.unauthorized('Sesión no iniciada'));
    }
    const token = header.slice(7);
    let payload;
    try {
        payload = jsonwebtoken_1.default.verify(token, env_1.config.jwtSecret);
    }
    catch {
        return next(errors_1.ApiError.unauthorized('Sesión inválida o vencida'));
    }
    if (!payload?.sid) {
        return next(errors_1.ApiError.unauthorized('Sesión inválida. Volvé a ingresar.'));
    }
    // Se recarga el usuario en cada pedido: si lo desactivan o cambian su rol, aplica al instante.
    (0, pool_1.query)(`SELECT id, username, full_name, role_code, default_location_id, restrict_to_location, is_active
     FROM users WHERE id = $1`, [payload.sub])
        .then(async (r) => {
        const u = r.rows[0];
        if (!u || !u.is_active) {
            return next(errors_1.ApiError.unauthorized('Usuario inactivo o inexistente'));
        }
        // ===== Validación de sesión server-side =====
        const s = await (0, pool_1.query)(`SELECT id, revoked_at, revoked_reason, expires_at, last_seen_at FROM sessions WHERE id = $1`, [payload.sid]);
        const session = s.rows[0];
        if (!session)
            return next(errors_1.ApiError.unauthorized('Sesión inválida. Volvé a ingresar.'));
        if (session.revoked_at) {
            const reason = session.revoked_reason === 'Inactividad'
                ? 'Sesión cerrada por inactividad'
                : 'Sesión cerrada por el administrador';
            return next(errors_1.ApiError.unauthorized(reason));
        }
        if (new Date(session.expires_at) < new Date()) {
            return next(errors_1.ApiError.unauthorized('Sesión vencida. Volvé a ingresar.'));
        }
        // Cierre automático por inactividad
        if (env_1.config.sessionIdleMinutes > 0) {
            const idle = await (0, pool_1.query)(`SELECT last_seen_at < now() - ($2::numeric * interval '1 minute') AS vencida
           FROM sessions WHERE id = $1`, [payload.sid, env_1.config.sessionIdleMinutes]);
            if (idle.rows[0]?.vencida) {
                await (0, pool_1.query)(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'Inactividad' WHERE id = $1 AND revoked_at IS NULL`, [payload.sid]);
                return next(errors_1.ApiError.unauthorized('Sesión cerrada por inactividad'));
            }
            // Actualiza "última actividad" (como máximo una vez por minuto para no escribir en cada pedido)
            await (0, pool_1.query)(`UPDATE sessions SET last_seen_at = now()
           WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'`, [payload.sid]);
        }
        req.user = {
            id: u.id,
            username: u.username,
            fullName: u.full_name,
            role: u.role_code,
            locationId: u.default_location_id,
            restrictToLocation: u.restrict_to_location,
            sessionId: payload.sid,
        };
        next();
    })
        .catch((err) => {
        logger_1.logger.error('Error validando sesión:', err.message);
        next(err);
    });
}
function requirePerm(permission) {
    return (req, _res, next) => {
        if (!req.user)
            return next(errors_1.ApiError.unauthorized());
        if (!(0, permissions_1.hasPermission)(req.user.role, permission)) {
            return next(errors_1.ApiError.forbidden());
        }
        next();
    };
}
