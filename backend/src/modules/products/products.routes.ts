import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam, pathId } from '../../lib/pagination';
import { createProduct, checkDuplicates, generateBarcode, updateProduct, importProducts, ProductInput } from './products.service';

const router = Router();
router.use(authRequired, requirePerm('products.read'));

function buildFilters(q: string | undefined, categoryId: number | undefined, brand: string | undefined, active: string | undefined) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    where.push(`(p.name ILIKE $${n} OR p.code ILIKE $${n} OR p.barcode ILIKE $${n} OR p.brand ILIKE $${n})`);
  }
  if (categoryId) { params.push(categoryId); where.push(`p.category_id = $${params.length}`); }
  if (brand) { params.push(`%${brand}%`); where.push(`p.brand ILIKE $${params.length}`); }
  if (active === 'true') where.push('p.is_active');
  if (active === 'false') where.push('NOT p.is_active');
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 25);
    const q = strParam(req.query.q);
    const categoryId = intParam(req.query.categoryId);
    const brand = strParam(req.query.brand);
    const active = strParam(req.query.active);
    const { where, params } = buildFilters(q, categoryId, brand, active);

    const count = await query<{ total: string }>(`SELECT COUNT(*) AS total FROM products p ${where}`, params);
    const rows = await query(
      `SELECT p.id, p.code, p.barcode, p.name, p.description, p.brand, p.category_id,
              c.name AS category_name, p.unit, p.min_stock, p.cost, p.reference_price,
              p.is_active, p.created_at, p.updated_at
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ${where}
       ORDER BY p.name LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    res.json({ products: rows.rows, total: Number(count.rows[0].total), page, pageSize });
  })
);

router.get(
  '/export.csv',
  asyncH(async (req, res) => {
    const q = strParam(req.query.q);
    const categoryId = intParam(req.query.categoryId);
    const active = strParam(req.query.active);
    const { where, params } = buildFilters(q, categoryId, undefined, active);
    const rows = await query(
      `SELECT p.code, p.barcode, p.name, p.brand, c.name AS category, p.unit,
              p.min_stock, p.cost, p.reference_price, p.is_active
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ${where} ORDER BY p.code`,
      params
    );
    const header = 'codigo;barras;nombre;marca;categoria;unidad;stock_minimo;costo;precio_referencia;activo';
    const lines = rows.rows.map((r: Record<string, unknown>) =>
      [r.code, r.barcode ?? '', r.name, r.brand ?? '', r.category ?? '', r.unit, r.min_stock, r.cost ?? '', r.reference_price ?? '', r.is_active ? 'SI' : 'NO']
        .map((v) => String(v).replace(/;/g, ',').replace(/\n/g, ' '))
        .join(';')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="productos.csv"');
    res.send('\uFEFF' + [header, ...lines].join('\n'));
  })
);

router.get(
  '/duplicates',
  asyncH(async (req, res) => {
    const input = {
      code: strParam(req.query.code),
      barcode: strParam(req.query.barcode),
      name: strParam(req.query.name),
      brand: strParam(req.query.brand),
    };
    const dup = await checkDuplicates(input);
    res.json(dup);
  })
);

/**
 * Genera un codigo de barras EAN-13 unico (nunca usado por otro producto ni orden).
 * GET /api/products/barcode/new → { barcode: "7798001234567" }
 */
router.get(
  '/barcode/new',
  requirePerm('products.write'),
  asyncH(async (_req, res) => {
    const barcode = await generateBarcode();
    res.json({ barcode });
  })
);

router.get(
  '/:id',
  asyncH(async (req, res) => {
    const id = pathId(req.params.id);
    const r = await query(
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = $1`,
      [id]
    );
    if (!r.rows[0]) throw ApiError.notFound('Producto no encontrado');
    const stock = await query(
      `SELECT l.id AS location_id, l.name AS location_name, l.type,
              COALESCE(sb.quantity, 0) AS quantity
       FROM locations l
       LEFT JOIN stock_balances sb ON sb.location_id = l.id AND sb.product_id = $1
       WHERE l.is_active
       ORDER BY l.type DESC, l.code`,
      [id]
    );
    res.json({ product: r.rows[0], stock: stock.rows });
  })
);

const productSchema = z.object({
  code: z.string().min(1).max(40),
  barcode: z.string().max(60).nullable().optional(),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullable().optional(),
  brand: z.string().max(100).nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  unit: z.enum(['UNIDAD', 'LITRO', 'KG', 'METRO', 'OTRO']),
  minStock: z.number().min(0).optional(),
  cost: z.number().min(0).nullable().optional(),
  referencePrice: z.number().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
});

router.post(
  '/',
  requirePerm('products.write'),
  asyncH(async (req, res) => {
    const input = productSchema.parse(req.body) as ProductInput;
    const id = await createProduct(req.user!, req.ip, input);
    res.status(201).json({ id });
  })
);

router.put(
  '/:id',
  requirePerm('products.write'),
  asyncH(async (req, res) => {
    const id = pathId(req.params.id);
    const input = productSchema.partial().parse(req.body);
    const result = await updateProduct(req.user!, req.ip, id, input);
    res.json(result);
  })
);

// Desactivar (soft delete): las entregas y movimientos historicamente se conservan.
router.delete(
  '/:id',
  requirePerm('products.write'),
  asyncH(async (req, res) => {
    const id = pathId(req.params.id);
    await updateProduct(req.user!, req.ip, id, { isActive: false });
    res.json({ ok: true });
  })
);

const importSchema = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(5000),
  updateExisting: z.boolean().default(false),
});

router.post(
  '/import',
  requirePerm('products.write'),
  asyncH(async (req, res) => {
    const { rows, updateExisting } = importSchema.parse(req.body);
    const result = await importProducts(req.user!, req.ip, rows as never, updateExisting);
    res.json(result);
  })
);

export default router;
