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
  const exact: unknown[] = [];
  if (input.code) {
    const r = await c.query('SELECT id, code, name FROM products WHERE lower(code) = lower($1) AND is_active', [input.code.trim()]);
    exact.push(...r.rows);
  }
  if (input.barcode) {
    const r = await c.query('SELECT id, code, name FROM products WHERE barcode = $1 AND is_active', [input.barcode.trim()]);
    exact.push(...r.rows);
  }
  let similar: { id: number; code: string; name: string; brand: string | null }[] = [];
  if (input.name && input.name.trim().length >= 4) {
    const r = await c.query(
      `SELECT id, code, name, brand FROM products
       WHERE is_active AND lower(name) LIKE '%' || lower($1::text) || '%'
         AND (brand IS NULL OR $2::text IS NULL OR lower(brand) = lower($2::text))
       LIMIT 5`,
      [input.name.trim(), input.brand?.trim() || null]
    );
    similar = r.rows;
  }
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

  await withTx(async (c) => {
    for (const id of ids) {
      const p = await c.query('SELECT id, code, name FROM products WHERE id = $1', [id]);
      if (!p.rows[0]) {
        skipped.push({ id, reason: 'No encontrado' });
        continue;
      }
      const stock = await c.query<{ total: string }>(
        'SELECT COALESCE(SUM(quantity), 0) AS total FROM stock_balances WHERE product_id = $1',
        [id]
      );
      const total = Number(stock.rows[0]?.total ?? 0);
      if (total > 0) {
        skipped.push({ id, reason: 'Tiene stock > 0' });
        continue;
      }
      await c.query('UPDATE products SET is_active = false WHERE id = $1', [id]);
      deleted.push(id);
      await writeAudit(c, {
        userId: user.id,
        action: 'PRODUCT_BULK_DELETE',
        entity: 'product',
        entityId: id,
        details: { code: p.rows[0].code, name: p.rows[0].name },
        ip,
      });
    }
  });

  return { deleted: deleted.length, skipped };
}


export async function updateProduct(user: AuthUser, ip: string | undefined, id: number, input: Partial<ProductInput>) {
  if (input.unit) assertUnit(input.unit);
  return withTx(async (c) => {
    const existing = await c.query('SELECT id FROM products WHERE id = $1', [id]);
    if (!existing.rows[0]) throw ApiError.notFound('Producto no encontrado');

    if (input.barcode) {
      const dup = await c.query('SELECT id FROM products WHERE barcode = $1 AND id <> $2', [input.barcode.trim(), id]);
      if (dup.rows[0]) throw ApiError.conflict('Otro producto ya usa ese codigo de barras');
    }

    await c.query(
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
       WHERE id = $12`,
      [
        input.code ? input.code.trim() : null,
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

  await withTx(async (c) => {
    // Mapa de categorias existentes + cache para crear al vuelo
    const catRows = await c.query<{ id: number; name: string }>('SELECT id, name FROM categories');
    const catMap = new Map(catRows.rows.map((r) => [r.name.toLowerCase(), r.id]));
    const seenCodes = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const line = i + 2; // +2: encabezado y base 1

      const code = cleanCodeValue(row.code);
      const name = cleanNameValue(row.name);

      // Fila totalmente vacia (o solo espacios): se ignora en silencio
      if (!code && !name) { skippedBlank++; continue; }
      // Encabezado repetido dentro de los datos
      if (!name && isHeaderLikeRow(code)) { skippedBlank++; continue; }

      if (!code) {
        errors.push({ row: line, message: 'Falta el codigo interno' });
        continue;
      }

      // Duplicado dentro del mismo archivo: se procesa solo la primera aparicion
      const codeKey = code.toLowerCase();
      if (seenCodes.has(codeKey)) { duplicatesInFile++; continue; }
      seenCodes.add(codeKey);

      const finalName = name || code; // sin columna de nombre: usa el codigo como nombre

      let unit = cleanText(row.unit).toUpperCase();
      const unitAliases: Record<string, string> = { 'UN': 'UNIDAD', 'UNIDADES': 'UNIDAD', 'L': 'LITRO', 'LT': 'LITRO', 'LITROS': 'LITRO', 'KG': 'KG', 'KILOS': 'KG', 'M': 'METRO', 'MTS': 'METRO' };
      unit = unitAliases[unit] ?? unit;
      if (!UNIT_ENUM.includes(unit)) unit = 'UNIDAD';

      const minStock = parseNumberFlexible(row.minStock) ?? 0;
      const cost = parseNumberFlexible(row.cost);
      const referencePrice = parseNumberFlexible(row.referencePrice);

      let categoryId: number | null = null;
      const catName = cleanText(row.category);
      if (catName) {
        const key = catName.toLowerCase();
        if (catMap.has(key)) {
          categoryId = catMap.get(key)!;
        } else {
          const inserted = await c.query<{ id: number }>(
            'INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET is_active = true RETURNING id',
            [catName]
          );
          categoryId = inserted.rows[0].id;
          catMap.set(key, categoryId);
        }
      }

      const existing = await c.query<{ id: number }>('SELECT id FROM products WHERE lower(code) = lower($1)', [code]);
      if (existing.rows[0]) {
        if (updateExisting) {
          await c.query(
            `UPDATE products SET name = $1, brand = $2, category_id = $3, unit = $4, min_stock = $5,
             cost = COALESCE($6, cost), reference_price = COALESCE($7, reference_price) WHERE id = $8`,
            [finalName, cleanText(row.brand) || null, categoryId, unit, minStock, cost, referencePrice, existing.rows[0].id]
          );
          updated++;
        } else {
          errors.push({ row: line, code, message: 'El codigo ya existe (no se actualizo)' });
        }
        continue;
      }

      try {
        await c.query(
          `INSERT INTO products (code, barcode, name, brand, category_id, unit, min_stock, cost, reference_price, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [code, cleanCodeValue(row.barcode) || null, finalName, cleanText(row.brand) || null,
           categoryId, unit, minStock, cost, referencePrice, user.id]
        );
        created++;
      } catch (err) {
        errors.push({ row: line, code, message: `Error: ${(err as Error).message}` });
      }
    }

    await writeAudit(c, {
      userId: user.id, action: 'PRODUCT_IMPORT', entity: 'product',
      details: { created, updated, errores: errors.length, ignoradas: skippedBlank, duplicadosEnArchivo: duplicatesInFile, updateExisting }, ip,
    });
  });

  return { created, updated, errors, skipped: skippedBlank, duplicatesInFile };
}
