import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../services/audit.service';
import { AuthUser } from '../../middleware/auth';

export interface ProductInput {
  code: string;
  barcode?: string | null;
  name: string;
  description?: string | null;
  brand?: string | null;
  categoryId?: number | null;
  unit: string;
  minStock?: number;
  cost?: number | null;
  referencePrice?: number | null;
  isActive?: boolean;
}

const UNIT_ENUM = ['UNIDAD', 'LITRO', 'KG', 'METRO', 'OTRO'];

export function assertUnit(unit: string) {
  if (!UNIT_ENUM.includes(unit)) throw ApiError.badRequest(`Unidad de medida invalida: ${unit}`);
}

export async function createProduct(user: AuthUser, ip: string | undefined, input: ProductInput): Promise<number> {
  assertUnit(input.unit);
  return withTx(async (c) => {
    const dup = await findDuplicates(c, input);
    if (dup.exact.length > 0) {
      throw ApiError.conflict('Ya existe un producto con ese codigo o codigo de barras', dup.exact);
    }
    const r = await c.query<{ id: number }>(
      `INSERT INTO products (code, barcode, name, description, brand, category_id, unit, min_stock, cost, reference_price, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        input.code.trim(), input.barcode?.trim() || null, input.name.trim(),
        input.description ?? null, input.brand?.trim() || null, input.categoryId ?? null,
        input.unit, input.minStock ?? 0, input.cost ?? null, input.referencePrice ?? null, user.id,
      ]
    );
    await writeAudit(c, {
      userId: user.id, action: 'PRODUCT_CREATE', entity: 'product',
      entityId: r.rows[0].id, details: { code: input.code, name: input.name }, ip,
    });
    return r.rows[0].id;
  });
}

async function findDuplicates(c: PoolClient, input: Partial<ProductInput>) {
  // 1 solo round-trip para exactos + similares (antes eran 3 queries secuenciales)
  const r = await c.query<{ id: number; code: string; name: string; brand: string | null; exact: boolean }>(
    `SELECT id, code, name, NULL::text AS brand, true AS exact
     FROM products
     WHERE is_active AND (
       ($1::text IS NOT NULL AND lower(code) = lower($1::text)) OR
       ($2::text IS NOT NULL AND barcode = $2::text)
     )
     UNION ALL
     SELECT id, code, name, brand, false
     FROM (
       SELECT id, code, name, brand
       FROM products
       WHERE is_active
         AND $3::text IS NOT NULL
         AND length(trim($3::text)) >= 4
         AND lower(name) LIKE '%' || lower($3::text) || '%'
         AND (brand IS NULL OR $4::text IS NULL OR lower(brand) = lower($4::text))
       LIMIT 5
     ) s`,
    [input.code?.trim() || null, input.barcode?.trim() || null, input.name?.trim() || null, input.brand?.trim() || null]
  );
  const exact: unknown[] = r.rows.filter((row) => row.exact).map(({ id, code, name }) => ({ id, code, name }));
  const similar: { id: number; code: string; name: string; brand: string | null }[] = r.rows
    .filter((row) => !row.exact)
    .map(({ id, code, name, brand }) => ({ id, code, name, brand }));
  return { exact, similar };
}

export async function checkDuplicates(input: Partial<ProductInput>) {
  return withTx((c) => findDuplicates(c, input));
}

/**
 * Genera un EAN-13 unico reutilizando generate_ean13_barcode() de la BD
 * (prefijo 779800, Argentina + interno). La funcion solo verifica unicidad
 * contra pending_deliveries, por lo que aqui se re-verifica contra products.
 */
/**
 * Genera un EAN-13 unico reutilizando generate_ean13_barcode() de la BD
 * (prefijo 779800, Argentina + interno). La funcion solo verifica unicidad
 * contra pending_deliveries, por lo que aqui se re-verifica contra products.
 */
export async function generateBarcode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await query<{ barcode: string }>('SELECT generate_ean13_barcode() AS barcode');
    const barcode = r.rows[0]?.barcode;
    if (!barcode) continue;
    const dup = await query(
      `SELECT 1 FROM products WHERE barcode = $1
       UNION ALL
       SELECT 1 FROM pending_deliveries WHERE barcode = $1
       LIMIT 1`,
      [barcode]
    );
    if (!dup.rows[0]) return barcode;
  }
  throw ApiError.badRequest('No se pudo generar un código de barras único. Volvé a intentar.');
}

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface DuplicateGroup {
  key: string;
  count: number;
  products: Array<{
    id: number;
    code: string;
    name: string;
    brand: string | null;
    unit: string;
    is_active: boolean;
    total_qty: number;
  }>;
}

export async function scanDuplicates(): Promise<DuplicateGroup[]> {
  const r = await query<{
    id: number;
    code: string;
    name: string;
    brand: string | null;
    unit: string;
    is_active: boolean;
  }>(
    `SELECT p.id, p.code, p.name, p.brand, p.unit, p.is_active
     FROM products p
     WHERE p.is_active = true
     ORDER BY lower(p.name), p.code`
  );

  const groups = new Map<string, DuplicateGroup>();
  for (const row of r.rows) {
    const key = normalizeName(row.name);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { key, count: 0, products: [] });
    }
    const g = groups.get(key)!;
    g.products.push({ ...row, total_qty: 0 });
  }

  // Get stock totals for all products in duplicates
  const productIds = [...groups.values()].flatMap((g) => g.products.map((p) => p.id));
  if (productIds.length > 0) {
    const stock = await query<{ product_id: number; total_qty: number }>(
      `SELECT product_id, COALESCE(SUM(quantity), 0) AS total_qty
       FROM stock_balances
       WHERE product_id = ANY($1::int[])
       GROUP BY product_id`,
      [productIds]
    );
    const map = new Map(stock.rows.map((s) => [s.product_id, Number(s.total_qty)]));
    for (const g of groups.values()) {
      for (const p of g.products) {
        p.total_qty = map.get(p.id) ?? 0;
      }
      g.count = g.products.length;
    }
  }

  return [...groups.values()].filter((g) => g.count > 1);
}

export async function bulkDeleteProducts(user: AuthUser, ip: string | undefined, ids: number[]): Promise<{ deleted: number; skipped: Array<{ id: number; reason: string }> }> {
  const deleted: number[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  const uniqueIds = [...new Set(ids)];

  await withTx(async (c) => {
    // 3 queries para TODO el lote (antes eran 4 por producto)
    const found = await c.query<{ id: number; code: string; name: string }>(
      'SELECT id, code, name FROM products WHERE id = ANY($1::int[])',
      [uniqueIds]
    );
    const foundMap = new Map(found.rows.map((r) => [r.id, r]));
    const stocks = await c.query<{ product_id: number; total: string }>(
      `SELECT product_id, COALESCE(SUM(quantity), 0) AS total
       FROM stock_balances WHERE product_id = ANY($1::int[]) GROUP BY product_id`,
      [uniqueIds]
    );
    const withStock = new Map(stocks.rows.map((s) => [s.product_id, Number(s.total)]));

    const deletable: Array<{ id: number; code: string; name: string }> = [];
    for (const id of uniqueIds) {
      const p = foundMap.get(id);
      if (!p) {
        skipped.push({ id, reason: 'No encontrado' });
        continue;
      }
      const total = withStock.get(id) ?? 0;
      if (total > 0) {
        skipped.push({ id, reason: 'Tiene stock > 0' });
        continue;
      }
      deletable.push(p);
    }

    if (deletable.length > 0) {
      await c.query('UPDATE products SET is_active = false WHERE id = ANY($1::int[])', [deletable.map((p) => p.id)]);
      // Auditoria en bloque con unnest (1 query, no N)
      await c.query(
        `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip)
         SELECT $1, $2, 'product', v.id, v.details, $5
         FROM unnest($3::int[], $4::jsonb[]) AS v(id, details)`,
        [
          user.id,
          'PRODUCT_BULK_DELETE',
          deletable.map((p) => p.id),
          deletable.map((p) => JSON.stringify({ code: p.code, name: p.name })),
          ip,
        ]
      );
      deleted.push(...deletable.map((p) => p.id));
    }
  });

  return { deleted: deleted.length, skipped };
}


export async function updateProduct(user: AuthUser, ip: string | undefined, id: number, input: Partial<ProductInput>) {
  if (input.unit) assertUnit(input.unit);
  return withTx(async (c) => {
    // UPDATE con RETURNING: ni SELECT previo para verificar existencia
    // (con >= 1 fila que recibe RETURNING como resultado) ni doble round-trip
    const result = await c.query(
      `UPDATE products SET
         code = COALESCE($1, code),
         barcode = COALESCE($2, barcode),
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         brand = COALESCE($5, brand),
         category_id = COALESCE($6, category_id),
         unit = COALESCE($7, unit),
         min_stock = COALESCE($8, min_stock),
         cost = $9,
         reference_price = $10,
         is_active = COALESCE($11, is_active)
       WHERE id = $12
       RETURNING id`,
      [
        ...(input.code ? [input.code.trim()] : [null]),
        input.barcode === undefined ? null : input.barcode?.trim() || null,
        input.name ? input.name.trim() : null,
        input.description ?? null,
        input.brand ?? null,
        input.categoryId ?? null,
        input.unit ?? null,
        input.minStock ?? null,
        input.cost ?? null,
        input.referencePrice ?? null,
        input.isActive ?? null,
        id,
      ]
    );
    if (result.rows.length === 0) throw ApiError.notFound('Producto no encontrado');

    if (input.barcode) {
      const dup = await c.query('SELECT id FROM products WHERE barcode = $1 AND id <> $2', [input.barcode.trim(), id]);
      if (dup.rows[0]) throw ApiError.conflict('Otro producto ya usa ese codigo de barras');
    }

    await writeAudit(c, {
      userId: user.id, action: 'PRODUCT_UPDATE', entity: 'product', entityId: id, details: input, ip,
    });
    return { ok: true };
  });
}

/** Quita el relleno de puntos que agregan los exportes ("1L...." → "1L"). */
function stripDotPadding(s: string): string {
  return s.replace(/\.{2,}$/, '').trim();
}

/** Normaliza texto: quita espacios invisibles de Excel, colapsa espacios múltiples y recorta. */
function cleanText(v: unknown): string {
  return String(v ?? '')
    .replace(/[\u00A0\u200B\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normaliza códigos: igual que el texto pero elimina TODOS los espacios internos
 *  (los exportes suelen rellenar con espacios) y corrige el sufijo ".0" de Excel. */
function cleanCodeValue(v: unknown): string {
  let s = stripDotPadding(cleanText(v).replace(/\s+/g, ''));
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s;
}

/** Nombre: texto limpio + sin relleno de puntos final. */
function cleanNameValue(v: unknown): string {
  return stripDotPadding(cleanText(v));
}

/** Convierte a numero tolerando coma decimal, simbolos y espacios. */
function parseNumberFlexible(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = cleanText(v).replace(/\$/g, '').replace(/\./g, (m, off, full: string) =>
    // si es separador de miles (3 digitos detras) se elimina, si es decimal se vuelve coma
    /\.\d{1,2}$/.test(full.slice(off)) ? ',' : ''
  ).replace(/,/g, '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Indica si la fila es un encabezado repetido dentro de los datos. */
function isHeaderLikeRow(code: string): boolean {
  return /^(codigo|cod|code|articulo|barcode|barras|codigobarras|codigodebarras)$/i.test(code);
}

/**
 * Importacion masiva tolerante al formato de exportes externos:
 * - limpia espacios (incluidos espacios invisibles de Excel)
 * - ignora filas totalmente vacias y encabezados repetidos
 * - tolera duplicados dentro del mismo archivo (procesa solo el primero)
 * - acepta numeros con coma decimal
 * Valida fila por fila, inserta las validas y reporta las invalidas.
 */
export interface ImportRow {
  code?: string;
  barcode?: string;
  name?: string;
  brand?: string;
  category?: string;
  unit?: string;
  minStock?: number | string;
  cost?: number | string;
  referencePrice?: number | string;
}

export interface ImportError {
  row: number;
  code?: string;
  message: string;
}

export async function importProducts(
  user: AuthUser,
  ip: string | undefined,
  rows: ImportRow[],
  updateExisting: boolean
) {
  let created = 0;
  let updated = 0;
  let skippedBlank = 0;
  let duplicatesInFile = 0;
  const errors: ImportError[] = [];

  type PreparedRow = {
    line: number; code: string; barcode: string | null; name: string;
    brand: string | null; categoryId: number | null; unit: string;
    minStock: number; cost: number | null; referencePrice: number | null;
    existingId: number | null;
  };

  await withTx(async (c) => {
    // Precarga de referencias en dos consultas, sin SELECT por producto.
    const [catRows, existingRows] = await Promise.all([
      c.query<{ id: number; name: string }>('SELECT id, name FROM categories'),
      c.query<{ id: number; code: string }>('SELECT id, lower(code) AS code FROM products'),
    ]);
    const catMap = new Map(catRows.rows.map((r) => [r.name.toLowerCase(), r.id]));
    const existingMap = new Map(existingRows.rows.map((r) => [r.code, r.id]));
    const seenCodes = new Set<string>();
    const prepared: PreparedRow[] = [];

    // Primera pasada: normalización y validaciones puras en memoria.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const line = i + 2;
      const code = cleanCodeValue(row.code);
      const name = cleanNameValue(row.name);
      if (!code && !name) { skippedBlank++; continue; }
      if (!name && isHeaderLikeRow(code)) { skippedBlank++; continue; }
      if (!code) { errors.push({ row: line, message: 'Falta el codigo interno' }); continue; }

      const codeKey = code.toLowerCase();
      if (seenCodes.has(codeKey)) { duplicatesInFile++; continue; }
      seenCodes.add(codeKey);

      let unit = cleanText(row.unit).toUpperCase();
      const unitAliases: Record<string, string> = {
        'UN': 'UNIDAD', 'UNIDADES': 'UNIDAD', 'L': 'LITRO', 'LT': 'LITRO',
        'LITROS': 'LITRO', 'KG': 'KG', 'KILOS': 'KG', 'M': 'METRO', 'MTS': 'METRO',
      };
      unit = unitAliases[unit] ?? unit;
      if (!UNIT_ENUM.includes(unit)) unit = 'UNIDAD';

      prepared.push({
        line, code, barcode: cleanCodeValue(row.barcode) || null,
        name: name || code, brand: cleanText(row.brand) || null,
        categoryId: null, unit,
        minStock: parseNumberFlexible(row.minStock) ?? 0,
        cost: parseNumberFlexible(row.cost),
        referencePrice: parseNumberFlexible(row.referencePrice),
        existingId: existingMap.get(codeKey) ?? null,
      });
    }

    // Crea categorías faltantes en bloque (normalmente son pocas).
    const missingCategories = new Map<string, string>();
    for (let i = 0; i < prepared.length; i++) {
      const original = rows[prepared[i].line - 2];
      const categoryName = cleanText(original.category);
      if (!categoryName) continue;
      const key = categoryName.toLowerCase();
      if (!catMap.has(key) && !missingCategories.has(key)) missingCategories.set(key, categoryName);
    }
    if (missingCategories.size > 0) {
      const names = [...missingCategories.values()];
      const inserted = await c.query<{ id: number; name: string }>(
        `INSERT INTO categories (name)
         SELECT value FROM unnest($1::text[]) AS value
         ON CONFLICT (name) DO UPDATE SET is_active = true
         RETURNING id, name`,
        [names]
      );
      for (const category of inserted.rows) catMap.set(category.name.toLowerCase(), category.id);
      // Recupera también posibles categorías preexistentes por diferencia de mayúsculas.
      const unresolved = names.filter((name) => !catMap.has(name.toLowerCase()));
      if (unresolved.length > 0) {
        const found = await c.query<{ id: number; name: string }>(
          'SELECT id, name FROM categories WHERE lower(name) = ANY($1::text[])',
          [unresolved.map((name) => name.toLowerCase())]
        );
        for (const category of found.rows) catMap.set(category.name.toLowerCase(), category.id);
      }
    }

    for (const item of prepared) {
      const categoryName = cleanText(rows[item.line - 2].category);
      item.categoryId = categoryName ? (catMap.get(categoryName.toLowerCase()) ?? null) : null;
    }

    const updates = prepared.filter((item) => item.existingId !== null);
    const inserts = prepared.filter((item) => item.existingId === null);

    if (!updateExisting) {
      for (const item of updates) {
        errors.push({ row: item.line, code: item.code, message: 'El codigo ya existe (no se actualizo)' });
      }
    } else {
      // UPDATE set-based por bloques: 1 round-trip por hasta 500 productos.
      for (let offset = 0; offset < updates.length; offset += 500) {
        const batch = updates.slice(offset, offset + 500);
        await c.query(
          `UPDATE products AS p SET
             name = v.name, brand = v.brand, category_id = v.category_id,
             unit = v.unit::unit_type, min_stock = v.min_stock,
             cost = COALESCE(v.cost, p.cost),
             reference_price = COALESCE(v.reference_price, p.reference_price)
           FROM unnest(
             $1::int[], $2::text[], $3::text[], $4::int[],
             $5::text[], $6::numeric[], $7::numeric[], $8::numeric[]
           ) AS v(id, name, brand, category_id, unit, min_stock, cost, reference_price)
           WHERE p.id = v.id`,
          [
            batch.map((x) => x.existingId), batch.map((x) => x.name),
            batch.map((x) => x.brand), batch.map((x) => x.categoryId),
            batch.map((x) => x.unit), batch.map((x) => x.minStock),
            batch.map((x) => x.cost), batch.map((x) => x.referencePrice),
          ]
        );
        updated += batch.length;
      }
    }

    // INSERT set-based. Si una fila tiene un barcode conflictivo, se reintenta
    // individualmente ese bloque para conservar el reporte preciso por fila.
    const insertOne = async (item: PreparedRow) => {
      const result = await c.query<{ code: string }>(
        `INSERT INTO products
           (code, barcode, name, brand, category_id, unit, min_stock, cost, reference_price, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::unit_type,$7,$8,$9,$10)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [item.code, item.barcode, item.name, item.brand, item.categoryId,
         item.unit, item.minStock, item.cost, item.referencePrice, user.id]
      );
      if (result.rows.length) created++;
      else errors.push({ row: item.line, code: item.code, message: 'El codigo ya existe (posible alta concurrente)' });
    };

    for (let offset = 0; offset < inserts.length; offset += 300) {
      const batch = inserts.slice(offset, offset + 300);
      try {
        const result = await c.query<{ code: string }>(
          `INSERT INTO products
             (code, barcode, name, brand, category_id, unit, min_stock, cost, reference_price, created_by)
           SELECT v.code, v.barcode, v.name, v.brand, v.category_id,
                  v.unit::unit_type, v.min_stock, v.cost, v.reference_price, $10
           FROM unnest(
             $1::text[], $2::text[], $3::text[], $4::text[], $5::int[],
             $6::text[], $7::numeric[], $8::numeric[], $9::numeric[]
           ) AS v(code, barcode, name, brand, category_id, unit, min_stock, cost, reference_price)
           ON CONFLICT (code) DO NOTHING
           RETURNING code`,
          [
            batch.map((x) => x.code), batch.map((x) => x.barcode),
            batch.map((x) => x.name), batch.map((x) => x.brand),
            batch.map((x) => x.categoryId), batch.map((x) => x.unit),
            batch.map((x) => x.minStock), batch.map((x) => x.cost),
            batch.map((x) => x.referencePrice), user.id,
          ]
        );
        const inserted = new Set(result.rows.map((r) => r.code.toLowerCase()));
        created += inserted.size;
        for (const item of batch) {
          if (!inserted.has(item.code.toLowerCase())) {
            errors.push({ row: item.line, code: item.code, message: 'El codigo ya existe (posible alta concurrente)' });
          }
        }
      } catch {
        // Un barcode duplicado invalida el INSERT set-based completo. El fallback
        // mantiene el comportamiento anterior de informar el error de cada fila.
        for (const item of batch) {
          try { await insertOne(item); }
          catch (err) { errors.push({ row: item.line, code: item.code, message: `Error: ${(err as Error).message}` }); }
        }
      }
    }

    await writeAudit(c, {
      userId: user.id, action: 'PRODUCT_IMPORT', entity: 'product',
      details: { created, updated, errores: errors.length, ignoradas: skippedBlank, duplicadosEnArchivo: duplicatesInFile, updateExisting }, ip,
    });
  });

  return { created, updated, errors, skipped: skippedBlank, duplicatesInFile };
}
