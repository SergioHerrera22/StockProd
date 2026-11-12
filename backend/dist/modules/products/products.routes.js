"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const pool_1 = require("../../db/pool");
const audit_service_1 = require("../../services/audit.service");
const errors_1 = require("../../lib/errors");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const products_service_1 = require("./products.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('products.read'));
function buildFilters(q, categoryId, brand, active) {
    const where = [];
    const params = [];
    if (q) {
        params.push(`%${q}%`);
        const n = params.length;
        where.push(`(p.name ILIKE $${n} OR p.code ILIKE $${n} OR p.barcode ILIKE $${n} OR p.brand ILIKE $${n})`);
    }
    if (categoryId) {
        params.push(categoryId);
        where.push(`p.category_id = $${params.length}`);
    }
    if (brand) {
        params.push(`%${brand}%`);
        where.push(`p.brand ILIKE $${params.length}`);
    }
    if (active === 'true')
        where.push('p.is_active');
    if (active === 'false')
        where.push('NOT p.is_active');
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 25);
    const q = (0, pagination_1.strParam)(req.query.q);
    const categoryId = (0, pagination_1.intParam)(req.query.categoryId);
    const brand = (0, pagination_1.strParam)(req.query.brand);
    const active = (0, pagination_1.strParam)(req.query.active);
    const { where, params } = buildFilters(q, categoryId, brand, active);
    // Un SOLO round-trip (la BD esta en Supabase, cada query es un viaje de red):
    // COUNT(*) OVER() viene en cada fila, sin la query de COUNT separada.
    const c = await pool_1.pool.connect();
    try {
        const rows = await c.query(`SELECT p.id, p.code, p.barcode, p.name, p.description, p.brand, p.category_id,
                c.name AS category_name, p.unit, p.min_stock, p.cost, p.reference_price,
                p.is_active, p.created_at, p.updated_at,
                COUNT(*) OVER() AS total
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         ${where}
         ORDER BY p.name LIMIT ${pageSize} OFFSET ${offset}`, params);
        const total = rows.rows.length > 0 && rows.rows[0].total != null ? Number(rows.rows[0].total) : 0;
        const products = rows.rows.map(({ total: _t, ...rest }) => rest);
        res.json({ products, total, page, pageSize });
    }
    finally {
        c.release();
    }
}));
router.get('/export.csv', (0, errorHandler_1.asyncH)(async (req, res) => {
    const q = (0, pagination_1.strParam)(req.query.q);
    const categoryId = (0, pagination_1.intParam)(req.query.categoryId);
    const active = (0, pagination_1.strParam)(req.query.active);
    const { where, params } = buildFilters(q, categoryId, undefined, active);
    const rows = await (0, pool_1.query)(`SELECT p.code, p.barcode, p.name, p.brand, c.name AS category, p.unit,
              p.min_stock, p.cost, p.reference_price, p.is_active
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ${where} ORDER BY p.code`, params);
    const header = 'codigo;barras;nombre;marca;categoria;unidad;stock_minimo;costo;precio_referencia;activo';
    const lines = rows.rows.map((r) => [r.code, r.barcode ?? '', r.name, r.brand ?? '', r.category ?? '', r.unit, r.min_stock, r.cost ?? '', r.reference_price ?? '', r.is_active ? 'SI' : 'NO']
        .map((v) => String(v).replace(/;/g, ',').replace(/\n/g, ' '))
        .join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="productos.csv"');
    res.send('\uFEFF' + [header, ...lines].join('\n'));
}));
/** Calidad del catálogo: paginado en servidor, nunca descarga el catálogo completo. */
router.get('/quality', (0, errorHandler_1.asyncH)(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const issue = (0, pagination_1.strParam)(req.query.issue) || 'all';
    const where = ["p.is_active = true"];
    if (issue === 'no_barcode')
        where.push("(p.barcode IS NULL OR trim(p.barcode) = '')");
    else if (issue === 'no_supplier')
        where.push("NOT EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id = p.id)");
    else if (issue === 'no_description')
        where.push("(p.description IS NULL OR trim(p.description) = '')");
    else if (issue === 'multiple')
        where.push("(p.barcode IS NULL OR trim(p.barcode) = '' OR p.description IS NULL OR trim(p.description) = '' OR NOT EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id = p.id))");
    else if (issue !== 'all')
        throw errors_1.ApiError.badRequest('Filtro de calidad inválido');
    const q = (0, pagination_1.strParam)(req.query.q);
    const params = [];
    if (q) {
        params.push(`%${q}%`);
        where.push(`(p.code ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
    }
    const whereSql = where.join(' AND ');
    const offset = (page - 1) * pageSize;
    const result = await (0, pool_1.query)(`SELECT p.id,p.code,p.name,p.barcode,p.description,p.brand,p.updated_at,
       EXISTS(SELECT 1 FROM product_suppliers ps WHERE ps.product_id=p.id) AS has_supplier,
       COUNT(*) OVER() AS total
     FROM products p WHERE ${whereSql}
     ORDER BY p.name LIMIT ${pageSize} OFFSET ${offset}`, params);
    const summary = await (0, pool_1.query)(`
    SELECT
      COUNT(*) FILTER (WHERE p.is_active AND (p.barcode IS NULL OR trim(p.barcode)=''))::int AS no_barcode,
      COUNT(*) FILTER (WHERE p.is_active AND (p.description IS NULL OR trim(p.description)=''))::int AS no_description,
      COUNT(*) FILTER (WHERE p.is_active AND NOT EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id=p.id))::int AS no_supplier
    FROM products p
  `);
    res.json({ products: result.rows.map(({ total: _total, ...row }) => row),
        total: result.rows[0] ? Number(result.rows[0].total) : 0, page, pageSize, summary: summary.rows[0] });
}));
const bulkEditRowSchema = zod_1.z.object({
    code: zod_1.z.string().trim().min(1).max(40),
    name: zod_1.z.string().trim().min(2).max(200).optional(),
    description: zod_1.z.string().max(2000).optional(),
    brand: zod_1.z.string().max(100).optional(),
    barcode: zod_1.z.string().max(60).optional(),
    supplier: zod_1.z.string().trim().min(2).max(180).optional(),
});
const bulkEditSchema = zod_1.z.object({ rows: zod_1.z.array(bulkEditRowSchema).min(1).max(1000) });
router.post('/bulk-edit/preview', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { rows } = bulkEditSchema.parse(req.body);
    const codes = [...new Set(rows.map((r) => r.code.toLowerCase()))];
    const found = await (0, pool_1.query)(`
    SELECT p.id,p.code,p.name,p.description,p.brand,p.barcode,p.updated_at
    FROM products p WHERE lower(p.code)=ANY($1::text[])
  `, [codes]);
    const byCode = new Map(found.rows.map((p) => [String(p.code).toLowerCase(), p]));
    const requestedBarcodes = rows.map((r) => r.barcode).filter((v) => Boolean(v));
    const barcodeMatches = requestedBarcodes.length ? await (0, pool_1.query)('SELECT id,barcode FROM products WHERE barcode=ANY($1::text[])', [requestedBarcodes]) : null;
    const barcodeOwners = new Map();
    if (barcodeMatches) {
        for (const owner of barcodeMatches.rows)
            barcodeOwners.set(owner.barcode, owner.id);
    }
    const preview = rows.map((row) => {
        const current = byCode.get(row.code.toLowerCase());
        if (!current)
            return { code: row.code, status: 'not_found', changes: [] };
        const changes = [];
        for (const field of ['name', 'description', 'brand', 'barcode']) {
            if (row[field] !== undefined && String(row[field] ?? '') !== String(current[field] ?? '')) {
                changes.push({ field, from: current[field] ?? '', to: row[field] });
            }
        }
        if (row.supplier)
            changes.push({ field: 'supplier', from: 'Se conservarán los vínculos actuales', to: row.supplier });
        const barcodeOwner = row.barcode ? barcodeOwners.get(row.barcode) : undefined;
        const barcodeConflict = barcodeOwner !== undefined && barcodeOwner !== current.id;
        if (barcodeConflict)
            changes.push({ field: 'barcode_conflict', from: row.barcode, to: 'Ese código ya pertenece a otro producto' });
        return { code: row.code, id: current.id, updatedAt: current.updated_at, status: barcodeConflict ? 'conflict' : changes.length ? 'changes' : 'unchanged', changes };
    });
    res.json({ preview, totals: {
            found: preview.filter((p) => p.status !== 'not_found').length,
            notFound: preview.filter((p) => p.status === 'not_found').length,
            changed: preview.filter((p) => p.status === 'changes').length,
            unchanged: preview.filter((p) => p.status === 'unchanged').length,
            conflicts: preview.filter((p) => p.status === 'conflict').length,
        } });
}));
router.post('/bulk-edit/apply', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({ rows: zod_1.z.array(bulkEditRowSchema.extend({ updatedAt: zod_1.z.string().min(1) })).min(1).max(1000) }).parse(req.body);
    let updated = 0, conflicts = 0, notFound = 0;
    const conflictCodes = [];
    await (0, pool_1.withTx)(async (c) => {
        for (const row of input.rows) {
            const current = await c.query('SELECT id,updated_at FROM products WHERE lower(code)=lower($1) FOR UPDATE', [row.code]);
            if (!current.rows[0]) {
                notFound++;
                continue;
            }
            if (new Date(current.rows[0].updated_at).getTime() !== new Date(row.updatedAt).getTime()) {
                conflicts++;
                conflictCodes.push(row.code);
                continue;
            }
            if (row.barcode) {
                await c.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [row.barcode]);
                const duplicateBarcode = await c.query('SELECT id FROM products WHERE barcode=$1 AND id<>$2 LIMIT 1', [row.barcode, current.rows[0].id]);
                if (duplicateBarcode.rows[0]) {
                    conflicts++;
                    conflictCodes.push(row.code + ' (barras duplicadas)');
                    continue;
                }
            }
            await c.query(`
        UPDATE products SET
          name=COALESCE($1,name),
          description=CASE WHEN $2::boolean THEN $3 ELSE description END,
          brand=CASE WHEN $4::boolean THEN NULLIF($5,'') ELSE brand END,
          barcode=CASE WHEN $6::boolean THEN NULLIF($7,'') ELSE barcode END,
          updated_at=now()
        WHERE id=$8
      `, [row.name ?? null, row.description !== undefined, row.description ?? null,
                row.brand !== undefined, row.brand ?? '', row.barcode !== undefined, row.barcode ?? '', current.rows[0].id]);
            if (row.supplier) {
                await c.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', ['supplier:' + row.supplier.trim().toLowerCase()]);
                const existingSupplier = await c.query('SELECT id FROM suppliers WHERE lower(name)=lower($1) AND is_active LIMIT 1', [row.supplier]);
                let supplierId = existingSupplier.rows[0]?.id;
                if (!supplierId) {
                    const createdSupplier = await c.query('INSERT INTO suppliers(name) VALUES($1) RETURNING id', [row.supplier]);
                    supplierId = createdSupplier.rows[0].id;
                    await (0, audit_service_1.writeAudit)(c, { userId: req.user.id, action: 'SUPPLIER_CREATE_FROM_BULK_EDIT', entity: 'supplier', entityId: supplierId, details: { name: row.supplier }, ip: req.ip });
                }
                await c.query(`
          INSERT INTO product_suppliers(product_id,supplier_id,is_primary)
          VALUES($1,$2,NOT EXISTS(SELECT 1 FROM product_suppliers WHERE product_id=$1 AND is_primary))
          ON CONFLICT(product_id,supplier_id) DO UPDATE SET is_primary = product_suppliers.is_primary OR NOT EXISTS(SELECT 1 FROM product_suppliers WHERE product_id=$1 AND is_primary)
        `, [current.rows[0].id, supplierId]);
            }
            await (0, audit_service_1.writeAudit)(c, { userId: req.user.id, action: 'PRODUCT_BULK_EDIT', entity: 'product',
                entityId: current.rows[0].id, details: { code: row.code, fields: Object.keys(row).filter((k) => !['code', 'updatedAt'].includes(k)) }, ip: req.ip });
            updated++;
        }
    });
    res.json({ updated, conflicts, notFound, conflictCodes });
}));
router.get('/duplicates', (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = {
        code: (0, pagination_1.strParam)(req.query.code),
        barcode: (0, pagination_1.strParam)(req.query.barcode),
        name: (0, pagination_1.strParam)(req.query.name),
        brand: (0, pagination_1.strParam)(req.query.brand),
    };
    const dup = await (0, products_service_1.checkDuplicates)(input);
    res.json(dup);
}));
/**
 * Escanea duplicados por nombre normalizado (solo activos). Debe ir antes de /:id.

/**
 * Escanea duplicados por nombre normalizado (solo activos). Debe ir antes de /:id.
 * GET /api/products/duplicates/scan
 */
router.get('/duplicates/scan', (0, auth_1.requirePerm)('products.read'), (0, errorHandler_1.asyncH)(async (_req, res) => {
    const groups = await (0, products_service_1.scanDuplicates)();
    res.json({ groups });
}));
const bulkDeleteSchema = zod_1.z.object({
    ids: zod_1.z.array(zod_1.z.number().int().positive()).min(1),
});
/**
 * Eliminación múltiple (soft delete). Solo ADMIN. Omite productos con stock > 0.
 * POST /api/products/bulk-delete
 */
router.post('/bulk-delete', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        throw errors_1.ApiError.forbidden('Solo el administrador puede eliminar múltiples productos');
    }
    const { ids } = bulkDeleteSchema.parse(req.body);
    const result = await (0, products_service_1.bulkDeleteProducts)(req.user, req.ip, ids);
    res.json(result);
}));
router.get('/barcode/new', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (_req, res) => {
    const barcode = await (0, products_service_1.generateBarcode)();
    res.json({ barcode });
}));
router.get('/:id/suppliers', (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const product = await (0, pool_1.query)('SELECT id FROM products WHERE id = $1', [id]);
    if (!product.rows[0])
        throw errors_1.ApiError.notFound('Producto no encontrado');
    const result = await (0, pool_1.query)(`SELECT s.id, s.name, ps.is_primary, ps.supplier_product_code, ps.notes
     FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
     WHERE ps.product_id = $1 ORDER BY ps.is_primary DESC, s.name`, [id]);
    res.json({ suppliers: result.rows });
}));
router.get('/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    // Ambas queries en un mismo cliente: 1 conexion, menor latencia
    const c = await pool_1.pool.connect();
    try {
        const r = await c.query(`SELECT p.*, c.name AS category_name FROM products p
         LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = $1`, [id]);
        if (!r.rows[0])
            throw errors_1.ApiError.notFound('Producto no encontrado');
        const stock = await c.query(`SELECT l.id AS location_id, l.name AS location_name, l.type,
                COALESCE(sb.quantity, 0) AS quantity
         FROM locations l
         LEFT JOIN stock_balances sb ON sb.location_id = l.id AND sb.product_id = $1
         WHERE l.is_active
         ORDER BY l.type DESC, l.code`, [id]);
        res.json({ product: r.rows[0], stock: stock.rows });
    }
    finally {
        c.release();
    }
}));
const productSchema = zod_1.z.object({
    code: zod_1.z.string().min(1).max(40),
    barcode: zod_1.z.string().max(60).nullable().optional(),
    name: zod_1.z.string().min(2).max(200),
    description: zod_1.z.string().max(2000).nullable().optional(),
    brand: zod_1.z.string().max(100).nullable().optional(),
    categoryId: zod_1.z.number().int().positive().nullable().optional(),
    unit: zod_1.z.enum(['UNIDAD', 'LITRO', 'KG', 'METRO', 'OTRO']),
    minStock: zod_1.z.number().min(0).optional(),
    cost: zod_1.z.number().min(0).nullable().optional(),
    referencePrice: zod_1.z.number().min(0).nullable().optional(),
    isActive: zod_1.z.boolean().optional(),
    supplierIds: zod_1.z.array(zod_1.z.number().int().positive()).optional(),
    primarySupplierId: zod_1.z.number().int().positive().nullable().optional(),
});
router.post('/', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = productSchema.parse(req.body);
    if (input.primarySupplierId != null && !input.supplierIds?.includes(input.primarySupplierId)) {
        throw errors_1.ApiError.badRequest('El proveedor principal debe estar incluido entre los proveedores del producto');
    }
    const id = await (0, products_service_1.createProduct)(req.user, req.ip, input);
    res.status(201).json({ id });
}));
router.patch('/:id/barcode', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const input = zod_1.z.object({ barcode: zod_1.z.string().trim().max(60) }).parse(req.body);
    await (0, products_service_1.updateProductBarcode)(req.user, req.ip, id, input.barcode);
    res.json({ ok: true, barcode: input.barcode || null });
}));
router.put('/:id', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const input = productSchema.partial().parse(req.body);
    if (input.primarySupplierId != null && !input.supplierIds?.includes(input.primarySupplierId)) {
        throw errors_1.ApiError.badRequest('El proveedor principal debe estar incluido entre los proveedores del producto');
    }
    const result = await (0, products_service_1.updateProduct)(req.user, req.ip, id, input);
    res.json(result);
}));
// Desactivar (soft delete): las entregas y movimientos historicamente se conservan.
router.delete('/:id', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    await (0, products_service_1.updateProduct)(req.user, req.ip, id, { isActive: false });
    res.json({ ok: true });
}));
const importSchema = zod_1.z.object({
    rows: zod_1.z.array(zod_1.z.record(zod_1.z.unknown())).min(1).max(5000),
    updateExisting: zod_1.z.boolean().default(false),
});
router.post('/import', (0, auth_1.requirePerm)('products.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { rows, updateExisting } = importSchema.parse(req.body);
    const result = await (0, products_service_1.importProducts)(req.user, req.ip, rows, updateExisting);
    res.json(result);
}));
exports.default = router;
