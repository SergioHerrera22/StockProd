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
// Marcas agrupadas: una asignación de proveedor alcanza a todos los productos activos de esa marca.
router.get('/brands', (0, auth_1.requirePerm)('suppliers.manage'), (0, errorHandler_1.asyncH)(async (_req, res) => {
    const result = await (0, pool_1.query)(`
  SELECT MIN(trim(p.brand)) AS brand, COUNT(DISTINCT p.id)::int AS product_count,
         COUNT(DISTINCT ps.supplier_id) FILTER (WHERE ps.is_primary)::int AS supplier_count,
         CASE WHEN COUNT(DISTINCT ps.supplier_id) FILTER (WHERE ps.is_primary)=1 THEN MIN(s.id) FILTER (WHERE ps.is_primary) ELSE NULL END AS supplier_id,
         COALESCE(string_agg(DISTINCT s.name, ', ' ORDER BY s.name) FILTER (WHERE ps.is_primary), '') AS supplier_names
  FROM products p
  LEFT JOIN product_suppliers ps ON ps.product_id=p.id
  LEFT JOIN suppliers s ON s.id=ps.supplier_id
  WHERE p.is_active AND p.brand IS NOT NULL AND trim(p.brand)<>''
  GROUP BY lower(trim(p.brand))
  ORDER BY lower(MIN(trim(p.brand)))
 `);
    res.json({ brands: result.rows });
}));
router.post('/brands/assign', (0, auth_1.requirePerm)('suppliers.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { brand, supplierId } = zod_1.z.object({
        brand: zod_1.z.string().trim().min(1).max(100),
        supplierId: zod_1.z.number().int().positive()
    }).parse(req.body);
    const result = await (0, pool_1.withTx)(async (c) => {
        const supplier = await c.query('SELECT id FROM suppliers WHERE id=$1 AND is_active FOR UPDATE', [supplierId]);
        if (!supplier.rows[0])
            throw errors_1.ApiError.badRequest('El proveedor no existe o está inactivo');
        const products = await c.query(`
   SELECT id FROM products
   WHERE is_active AND brand IS NOT NULL AND lower(trim(brand))=lower(trim($1))
   FOR UPDATE
  `, [brand]);
        if (!products.rows.length)
            throw errors_1.ApiError.notFound('No hay productos activos para esa marca');
        const ids = products.rows.map(p => p.id);
        // Registrar proveedores anteriores sin guardar miles de IDs en la auditoría.
        const previous = await c.query('SELECT DISTINCT supplier_id FROM product_suppliers WHERE product_id=ANY($1::int[])', [ids]);
        const previousSupplierIds = previous.rows.map(x => x.supplier_id);
        // La asignación por marca es exclusiva: cada producto queda con un único proveedor.
        // Las entradas históricas conservan su supplier_id.
        await c.query('DELETE FROM product_suppliers WHERE product_id=ANY($1::int[])', [ids]);
        await c.query(`
   INSERT INTO product_suppliers(product_id,supplier_id,is_primary)
   SELECT product_id,$2,true FROM unnest($1::int[]) AS x(product_id)
  `, [ids, supplierId]);
        await (0, audit_service_1.writeAudit)(c, { userId: req.user.id, action: 'SUPPLIER_BRAND_ASSIGN', entity: 'supplier', entityId: supplierId,
            details: { brand, productCount: ids.length, previousSupplierIds, supplierId }, ip: req.ip });
        return ids.length;
    });
    res.json({ ok: true, brand, productCount: result });
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
router.delete('/:id', (0, auth_1.requirePerm)('suppliers.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    await (0, pool_1.withTx)(async (c) => {
        const found = await c.query('SELECT id,name FROM suppliers WHERE id=$1 FOR UPDATE', [id]);
        if (!found.rows[0])
            throw errors_1.ApiError.notFound('Proveedor no encontrado');
        const linked = await c.query('SELECT COUNT(*)::text AS count FROM product_suppliers WHERE supplier_id=$1', [id]);
        if (Number(linked.rows[0]?.count ?? 0) > 0) {
            throw errors_1.ApiError.conflict('No se puede eliminar: el proveedor sigue asociado a productos. Reasigná primero sus marcas o productos.');
        }
        const historical = await c.query('SELECT 1 FROM stock_entries WHERE supplier_id=$1 LIMIT 1', [id]);
        if (historical.rows[0]) {
            await c.query('UPDATE suppliers SET is_active=false,updated_at=now() WHERE id=$1', [id]);
        }
        else {
            await c.query('DELETE FROM suppliers WHERE id=$1', [id]);
        }
        await (0, audit_service_1.writeAudit)(c, { userId: req.user.id, action: 'SUPPLIER_DELETE_OR_ARCHIVE', entity: 'supplier', entityId: id,
            details: { name: found.rows[0].name, archived: Boolean(historical.rows[0]) }, ip: req.ip });
    });
    res.json({ ok: true });
}));
exports.default = router;
