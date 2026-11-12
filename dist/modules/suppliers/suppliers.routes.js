"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const audit_service_1 = require("../../services/audit.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
const schema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2).max(180), taxId: zod_1.z.string().trim().max(20).nullable().optional(),
    contactName: zod_1.z.string().trim().max(150).nullable().optional(), phone: zod_1.z.string().trim().max(60).nullable().optional(),
    email: zod_1.z.string().trim().email().max(180).nullable().or(zod_1.z.literal('')).optional(),
    address: zod_1.z.string().trim().max(255).nullable().optional(), notes: zod_1.z.string().trim().max(2000).nullable().optional(),
    isActive: zod_1.z.boolean().optional()
});
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, pool_1.query)(`SELECT id,name,tax_id,contact_name,phone,email,address,notes,is_active FROM suppliers
 WHERE ($1::boolean OR is_active) ORDER BY name`, [req.query.includeInactive === 'true']);
    res.json({ suppliers: result.rows });
}));
router.post('/', (0, auth_1.requirePerm)('suppliers.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const d = schema.parse(req.body);
    const id = await (0, pool_1.withTx)(async (c) => {
        const r = await c.query(`INSERT INTO suppliers(name,tax_id,contact_name,phone,email,address,notes)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [d.name, d.taxId || null, d.contactName || null, d.phone || null, d.email || null, d.address || null, d.notes || null]);
        await (0, audit_service_1.writeAudit)(c, { userId: req.user.id, action: 'SUPPLIER_CREATE', entity: 'supplier', entityId: r.rows[0].id, details: d, ip: req.ip });
        return r.rows[0].id;
    });
    res.status(201).json({ id });
}));
router.put('/:id', (0, auth_1.requirePerm)('suppliers.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id), d = schema.partial().parse(req.body);
    if (!Object.keys(d).length)
        throw errors_1.ApiError.badRequest('No hay cambios para guardar');
    await (0, pool_1.withTx)(async (c) => {
        const found = await c.query('SELECT id FROM suppliers WHERE id=$1 FOR UPDATE', [id]);
        if (!found.rows[0])
            throw errors_1.ApiError.notFound('Proveedor no encontrado');
        if (d.isActive === false) {
            const linked = await c.query('SELECT 1 FROM product_suppliers WHERE supplier_id=$1 LIMIT 1', [id]);
            if (linked.rows[0])
                throw errors_1.ApiError.conflict('No se puede desactivar un proveedor asociado a productos. Primero reasigná esas relaciones.');
        }
        await c.query(`UPDATE suppliers SET name=COALESCE($1,name),
   tax_id=CASE WHEN $2::boolean THEN $3 ELSE tax_id END,
   contact_name=CASE WHEN $4::boolean THEN $5 ELSE contact_name END,
   phone=CASE WHEN $6::boolean THEN $7 ELSE phone END,
   email=CASE WHEN $8::boolean THEN $9 ELSE email END,
   address=CASE WHEN $10::boolean THEN $11 ELSE address END,
   notes=CASE WHEN $12::boolean THEN $13 ELSE notes END,
   is_active=COALESCE($14,is_active),updated_at=now() WHERE id=$15`, [d.name ?? null, d.taxId !== undefined, d.taxId || null, d.contactName !== undefined, d.contactName || null,
            d.phone !== undefined, d.phone || null, d.email !== undefined, d.email || null, d.address !== undefined, d.address || null,
            d.notes !== undefined, d.notes || null, d.isActive ?? null, id]);
        await (0, audit_service_1.writeAudit)(c, { userId: req.user.id, action: 'SUPPLIER_UPDATE', entity: 'supplier', entityId: id, details: d, ip: req.ip });
    });
    res.json({ ok: true });
}));
exports.default = router;
