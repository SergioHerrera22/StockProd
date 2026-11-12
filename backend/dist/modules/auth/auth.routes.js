"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const zod_1 = require("zod");
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const env_1 = require("../../config/env");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const security_1 = require("../../middleware/security");
const audit_service_1 = require("../../services/audit.service");
const router = (0, express_1.Router)();
const loginSchema = zod_1.z.object({
    username: zod_1.z.string().min(1, 'Ingresá el usuario').max(60),
    password: zod_1.z.string().min(1, 'Ingresá la contraseña').max(200),
});
/** Convierte '12h' | '30m' | '7d' | '3600s' a milisegundos. */
function parseExpiresMs(value) {
    const m = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
    if (!m)
        return 12 * 60 * 60 * 1000;
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return parseInt(m[1], 10) * mult[m[2].toLowerCase()];
}
router.post('/login', security_1.authLimiter, // solo cuenta fallos: 10 errores por IP en 15 min
(0, errorHandler_1.asyncH)(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const r = await (0, pool_1.query)(`SELECT id, username, password_hash, full_name, role_code, default_location_id, restrict_to_location, is_active, permissions
       FROM users WHERE lower(username) = lower($1)`, [username.trim()]);
    const user = r.rows[0];
    const ok = user && (await bcryptjs_1.default.compare(password, user.password_hash));
    if (!ok || !user?.is_active) {
        // Registro de intentos fallidos (anti fuerza bruta / trazabilidad)
        await (0, audit_service_1.writeAudit)(pool_1.pool, {
            userId: user?.id ?? null,
            action: 'LOGIN_FAILED',
            entity: 'user',
            entityId: user?.id ?? null,
            details: { username: username.trim(), motivo: !user ? 'usuario inexistente' : 'contraseña incorrecta' },
            ip: req.ip,
        });
        throw errors_1.ApiError.unauthorized('Usuario o contraseña incorrectos');
    }
    await (0, pool_1.query)(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    // ===== Sesión server-side =====
    const sessionId = crypto_1.default.randomUUID();
    const expiresMs = parseExpiresMs(env_1.config.jwtExpires);
    const expiresAt = new Date(Date.now() + expiresMs).toISOString();
    // Limpieza de sesiones muertas (vencidas hace más de 1 día)
    await (0, pool_1.query)(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`).catch(() => { });
    await (0, pool_1.query)(`INSERT INTO sessions (id, user_id, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5)`, [sessionId, user.id, req.ip ?? null, (req.headers['user-agent'] ?? '').slice(0, 250), expiresAt]);
    const token = jsonwebtoken_1.default.sign({ sub: user.id, sid: sessionId }, env_1.config.jwtSecret, {
        expiresIn: env_1.config.jwtExpires,
    });
    const authUser = {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role_code,
        locationId: user.default_location_id,
        permissions: user.permissions,
    };
    await (0, audit_service_1.writeAudit)(pool_1.pool, {
        userId: user.id,
        action: 'LOGIN',
        entity: 'user',
        entityId: user.id,
        details: { username: user.username },
        ip: req.ip,
    });
    res.json({ token, user: authUser });
}));
router.get('/me', auth_1.authRequired, (0, errorHandler_1.asyncH)(async (req, res) => {
    res.json({ user: req.user });
}));
/** Configuración de sesión para el frontend (temporizador de inactividad). */
router.get('/config', auth_1.authRequired, (0, errorHandler_1.asyncH)(async (_req, res) => {
    res.json({ idleMinutes: env_1.config.sessionIdleMinutes });
}));
/** Logout real: revoca la sesión en el servidor. */
router.post('/logout', auth_1.authRequired, (0, errorHandler_1.asyncH)(async (req, res) => {
    await (0, pool_1.query)(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'Logout' WHERE id = $1 AND revoked_at IS NULL`, [req.user.sessionId]);
    res.json({ ok: true });
}));
const changePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1),
    newPassword: zod_1.z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres').max(100),
});
router.post('/change-password', auth_1.authRequired, security_1.authLimiter, // frenar fuerza bruta sobre la contrasena actual
(0, errorHandler_1.asyncH)(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const r = await (0, pool_1.query)('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await bcryptjs_1.default.compare(currentPassword, r.rows[0]?.password_hash ?? '');
    if (!ok)
        throw errors_1.ApiError.badRequest('La contraseña actual es incorrecta');
    const hash = await bcryptjs_1.default.hash(newPassword, 10);
    await (0, pool_1.query)('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    await (0, pool_1.withTx)((c) => (0, audit_service_1.writeAudit)(c, {
        userId: req.user.id,
        action: 'CHANGE_PASSWORD',
        entity: 'user',
        entityId: req.user.id,
        ip: req.ip,
    }));
    res.json({ ok: true });
}));
exports.default = router;
