"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const audit_service_1 = require("../../services/audit.service");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
router.get('/', (0, errorHandler_1.asyncH)(async (_req, res) => {
    const r = await (0, pool_1.query)(`SELECT id, code, name, type, address, is_active, created_at
       FROM locations ORDER BY type DESC, code`);
    res.json({ locations: r.rows });
}));
const locationSchema = zod_1.z.object({
    code: zod_1.z.string().min(1).max(10),
    name: zod_1.z.string().min(2).max(120),
    type: zod_1.z.enum(['SUCURSAL', 'DEPOSITO']),
    address: zod_1.z.string().max(200).optional().nullable(),
    isActive: zod_1.z.boolean().optional(),
});
router.post('/', (0, auth_1.requirePerm)('locations.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const data = locationSchema.parse(req.body);
    const created = await (0, pool_1.withTx)(async (c) => {
        const r = await c.query(`INSERT INTO locations (code, name, type, address) VALUES ($1,$2,$3,$4) RETURNING id`, [data.code.toUpperCase(), data.name, data.type, data.address ?? null]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: req.user.id, action: 'LOCATION_CREATE', entity: 'location',
            entityId: r.rows[0].id, details: data, ip: req.ip,
        });
        return r.rows[0].id;
    });
    res.status(201).json({ id: created });
}));
router.put('/:id', (0, auth_1.requirePerm)('locations.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const data = locationSchema.partial().parse(req.body);
    const r = await (0, pool_1.query)('SELECT id FROM locations WHERE id = $1', [id]);
    if (!r.rows[0])
        throw errors_1.ApiError.notFound('Ubicacion no encontrada');
    await (0, pool_1.withTx)(async (c) => {
        await c.query(`UPDATE locations SET
           code = COALESCE($1, code),
           name = COALESCE($2, name),
           type = COALESCE($3, type),
           address = COALESCE($4, address),
           is_active = COALESCE($5, is_active)
         WHERE id = $6`, [
            data.code ? data.code.toUpperCase() : null,
            data.name ?? null,
            data.type ?? null,
            data.address ?? null,
            data.isActive ?? null,
            id,
        ]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: req.user.id, action: 'LOCATION_UPDATE', entity: 'location',
            entityId: id, details: data, ip: req.ip,
        });
    });
    res.json({ ok: true });
}));
exports.default = router;
