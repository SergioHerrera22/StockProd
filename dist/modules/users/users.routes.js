"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const zod_1 = require("zod");
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const audit_service_1 = require("../../services/audit.service");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
const userSchema = zod_1.z.object({
    username: zod_1.z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'Solo letras, numeros, punto, guion y guion bajo'),
    fullName: zod_1.z.string().min(3).max(120),
    role: zod_1.z.enum(['ADMIN', 'ENCARGADO', 'EMPLEADO', 'TRANSPORTE']),
    defaultLocationId: zod_1.z.number().int().positive().nullable().optional(),
    password: zod_1.z.string().min(6).max(100).optional(),
    isActive: zod_1.z.boolean().optional(),
    restrictToLocation: zod_1.z.boolean().optional(),
});
function validateRestriction(data) {
    if (data.restrictToLocation && !data.defaultLocationId) {
        throw errors_1.ApiError.badRequest('Para restringir por ubicación primero asigná la ubicación habitual');
    }
}
router.get('/', (0, auth_1.requirePerm)('users.manage'), (0, errorHandler_1.asyncH)(async (_req, res) => {
    const r = await (0, pool_1.query)(`SELECT u.id, u.username, u.full_name, u.role_code, u.default_location_id,
              l.name AS location_name, u.is_active, u.restrict_to_location, u.last_login_at, u.created_at
       FROM users u
       LEFT JOIN locations l ON l.id = u.default_location_id
       ORDER BY u.username`);
    res.json({ users: r.rows });
}));
router.post('/', (0, auth_1.requirePerm)('users.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const data = userSchema.parse(req.body);
    if (!data.password)
        throw errors_1.ApiError.badRequest('La contraseña inicial es obligatoria');
    const hash = await bcryptjs_1.default.hash(data.password, 10);
    const created = await (0, pool_1.withTx)(async (c) => {
        validateRestriction(data);
        const r = await c.query(`INSERT INTO users (username, password_hash, full_name, role_code, default_location_id, restrict_to_location)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [data.username, hash, data.fullName, data.role, data.defaultLocationId ?? null, data.restrictToLocation ?? false]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: req.user.id, action: 'USER_CREATE', entity: 'user',
            entityId: r.rows[0].id, details: { username: data.username, role: data.role }, ip: req.ip,
        });
        return r.rows[0].id;
    });
    res.status(201).json({ id: created });
}));
router.put('/:id', (0, auth_1.requirePerm)('users.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const data = userSchema.partial().parse(req.body);
    if (data.password)
        throw errors_1.ApiError.badRequest('Usa la opcion de restablecer contraseña');
    const current = await (0, pool_1.query)('SELECT id FROM users WHERE id = $1', [id]);
    if (!current.rows[0])
        throw errors_1.ApiError.notFound('Usuario no encontrado');
    const locParam = data.defaultLocationId === undefined ? null : data.defaultLocationId;
    validateRestriction(data);
    await (0, pool_1.withTx)(async (c) => {
        await c.query(`UPDATE users SET
           username = COALESCE($1, username),
           full_name = COALESCE($2, full_name),
           role_code = COALESCE($3, role_code),
           default_location_id = $4,
           is_active = COALESCE($5, is_active),
           restrict_to_location = COALESCE($6, restrict_to_location)
         WHERE id = $7`, [
            data.username ?? null,
            data.fullName ?? null,
            data.role ?? null,
            locParam,
            data.isActive ?? null,
            data.restrictToLocation ?? null,
            id,
        ]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: req.user.id, action: 'USER_UPDATE', entity: 'user', entityId: id,
            details: data, ip: req.ip,
        });
    });
    res.json({ ok: true });
}));
router.post('/:id/reset-password', (0, auth_1.requirePerm)('users.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const { password } = zod_1.z.object({ password: zod_1.z.string().min(6).max(100) }).parse(req.body);
    const hash = await bcryptjs_1.default.hash(password, 10);
    const r = await (0, pool_1.query)('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [hash, id]);
    if (!r.rows[0])
        throw errors_1.ApiError.notFound('Usuario no encontrado');
    await (0, pool_1.withTx)((c) => (0, audit_service_1.writeAudit)(c, {
        userId: req.user.id, action: 'USER_RESET_PASSWORD', entity: 'user', entityId: id, ip: req.ip,
    }));
    res.json({ ok: true });
}));
exports.default = router;
