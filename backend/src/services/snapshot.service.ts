// @ts-nocheck
import { query, withTx } from '../db/pool';
import { ApiError } from '../lib/errors';
import { writeAudit } from './audit.service';
import { AuthUser } from '../middleware/auth';

export type SnapshotType = 'DAILY' | 'WEEKLY' | 'MANUAL' | 'PRE_COUNT' | 'POST_COUNT' | 'PRE_TRANSFER' | 'POST_TRANSFER';

export interface StockSnapshot {
  id: number;
  locationId: number;
  snapshotType: SnapshotType;
  referenceId: number | null;
  referenceType: string | null;
  totalProducts: number;
  totalQuantity: number;
  totalValue: number | null;
  dataHash: string;
  createdBy: number | null;
  createdAt: Date;
  locationName?: string;
  locationCode?: string;
  createdByName?: string;
  items?: StockSnapshotItem[];
}

export interface StockSnapshotItem {
  snapshotId: number;
  productId: number;
  locationCode?: string;
  locationName?: string;
  quantity: number;
  unitCost: number | null;
  productCode?: string;
  productName?: string;
  unit?: string;
}

/**
 * Crear snapshot manual o programado
 */
export async function createSnapshot(
  user: AuthUser | null,
  ip: string | undefined,
  locationId: number,
  snapshotType: SnapshotType,
  referenceId?: number,
  referenceType?: string
) {
  return withTx((c) => createSnapshotInTx(c, user, ip, locationId, snapshotType, referenceId, referenceType));
}

/**
 * Crear snapshot usando el cliente de una transaccion EXISTENTE.
 * Antes abria su propia withTx: invocada dentro de la tx de un conteo,
 * el snapshot quedaba commiteado aunque el conteo se revertiera (o al
 * revés). Compartir el cliente garantiza atomicidad con el conteo.
 */
export async function createSnapshotInTx(
  c: any,
  user: AuthUser | null,
  ip: string | undefined,
  locationId: number,
  snapshotType: SnapshotType,
  referenceId?: number,
  referenceType?: string
) {
  // Verificar ubicacion activa
  const loc = await c.query('SELECT id FROM locations WHERE id = $1 AND is_active = true', [locationId]);
  if (!loc.rows[0]) throw ApiError.notFound('Ubicación no encontrada o inactiva');

  // Usar funcion BD para crear snapshot atomico
  const r = await c.query<{ id: number }>(
    `SELECT create_stock_snapshot($1, $2, $3, $4, $5) AS id`,
    [locationId, snapshotType, referenceId ?? null, referenceType ?? null, user?.id ?? null]
  );

  const snapshotId = r.rows[0].id;

  // Obtener detalle para respuesta (usar el mismo cliente de transaccion para ver datos no confirmados)
  const snap = await getSnapshotInTx(c, snapshotId);
  if (!snap) throw ApiError.badRequest('Error creando snapshot');

  await writeAudit(c, {
    userId: user?.id ?? null,
    action: 'STOCK_SNAPSHOT_CREATE',
    entity: 'stock_snapshot',
    entityId: snapshotId,
    details: { locationId, snapshotType, referenceId, referenceType, totalProducts: snap.totalProducts, totalQuantity: String(snap.totalQuantity) },
    ip,
  });

  return snap;
}

/**
 * Obtener snapshot por ID con items (dentro de una transaccion)
 */
export async function getSnapshotInTx(c: any, id: number): Promise<StockSnapshot & { items: StockSnapshotItem[] } | null> {
  const head = await c.query(
    `SELECT s.*, l.name AS location_name, l.code AS location_code, u.full_name AS created_by_name
     FROM stock_snapshots s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.id = $1`, [id]
  );
  if (!head.rows[0]) return null;

  const items = await c.query(
    `SELECT si.*, p.code AS product_code, p.name AS product_name, p.unit
     FROM stock_snapshot_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.snapshot_id = $1 ORDER BY p.name`, [id]
  );

  const row = head.rows[0] as Record<string, unknown>;
  const snapshot: StockSnapshot & { items: StockSnapshotItem[] } = {
    id: Number(row.id),
    locationId: Number(row.location_id),
    snapshotType: String(row.snapshot_type) as SnapshotType,
    referenceId: row.reference_id ? Number(row.reference_id) : null,
    referenceType: row.reference_type ? String(row.reference_type) : null,
    totalProducts: Number(row.total_products),
    totalQuantity: Number(row.total_quantity),
    totalValue: row.total_value ? Number(row.total_value) : null,
    dataHash: String(row.data_hash),
    createdBy: row.created_by ? Number(row.created_by) : null,
    createdAt: new Date(String(row.created_at)),
    locationName: row.location_name ? String(row.location_name) : undefined,
    locationCode: row.location_code ? String(row.location_code) : undefined,
    createdByName: row.created_by_name ? String(row.created_by_name) : undefined,
    items: items.rows.map(r => ({
      snapshotId: Number(r.snapshot_id),
      productId: Number(r.product_id),
      quantity: Number(r.quantity),
      unitCost: r.unit_cost ? Number(r.unit_cost) : null,
      productCode: r.product_code ? String(r.product_code) : undefined,
      productName: r.product_name ? String(r.product_name) : undefined,
      unit: r.unit ? String(r.unit) : undefined,
    })),
  };
  return snapshot;
}

/**
 * Obtener snapshot por ID con items
 */
export async function getSnapshot(id: number): Promise<StockSnapshot & { items: StockSnapshotItem[] } | null> {
  const head = await query(
    `SELECT s.*, l.name AS location_name, l.code AS location_code, u.full_name AS created_by_name
     FROM stock_snapshots s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.id = $1`, [id]
  );
  if (!head.rows[0]) return null;

  const items = await query(
    `SELECT si.*, p.code AS product_code, p.name AS product_name, p.unit
     FROM stock_snapshot_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.snapshot_id = $1 ORDER BY p.name`, [id]
  );

  const row = head.rows[0] as Record<string, unknown>;
  const snapshot: StockSnapshot & { items: StockSnapshotItem[] } = {
    id: Number(row.id),
    locationId: Number(row.location_id),
    snapshotType: String(row.snapshot_type) as SnapshotType,
    referenceId: row.reference_id ? Number(row.reference_id) : null,
    referenceType: row.reference_type ? String(row.reference_type) : null,
    totalProducts: Number(row.total_products),
    totalQuantity: Number(row.total_quantity),
    totalValue: row.total_value ? Number(row.total_value) : null,
    dataHash: String(row.data_hash),
    createdBy: row.created_by ? Number(row.created_by) : null,
    createdAt: new Date(String(row.created_at)),
    locationName: row.location_name ? String(row.location_name) : undefined,
    locationCode: row.location_code ? String(row.location_code) : undefined,
    createdByName: row.created_by_name ? String(row.created_by_name) : undefined,
    items: items.rows.map(r => ({
      snapshotId: Number(r.snapshot_id),
      productId: Number(r.product_id),
      quantity: Number(r.quantity),
      unitCost: r.unit_cost ? Number(r.unit_cost) : null,
      productCode: r.product_code ? String(r.product_code) : undefined,
      productName: r.product_name ? String(r.product_name) : undefined,
      unit: r.unit ? String(r.unit) : undefined,
    })),
  };
  return snapshot;
}

/**
 * Listar snapshots
 */
export async function listSnapshots(opts: {
  locationId?: number;
  snapshotType?: SnapshotType;
  referenceType?: string;
  page: number; pageSize: number; offset: number;
}) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.locationId) { params.push(opts.locationId); where.push(`s.location_id = $${params.length}`); }
  if (opts.snapshotType) { params.push(opts.snapshotType); where.push(`s.snapshot_type = $${params.length}`); }
  if (opts.referenceType) { params.push(opts.referenceType); where.push(`s.reference_type = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM stock_snapshots s ${whereSql}`, params);
  const rows = await query(
    `SELECT s.*, l.name AS location_name, l.code AS location_code, u.full_name AS created_by_name
     FROM stock_snapshots s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN users u ON u.id = s.created_by
     ${whereSql} ORDER BY s.created_at DESC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { snapshots: rows.rows, total: Number(count.rows[0].total) };
}

/**
 * Comparar dos snapshots (diferencias de stock)
 */
export async function compareSnapshots(snapshotId1: number, snapshotId2: number) {
  const [s1, s2] = await Promise.all([getSnapshot(snapshotId1), getSnapshot(snapshotId2)]);
  if (!s1 || !s2) throw ApiError.notFound('Uno o ambos snapshots no encontrados');

  const map1 = new Map(s1.items.map(i => [i.productId, i]));
  const map2 = new Map(s2.items.map(i => [i.productId, i]));
  const allIds = new Set([...map1.keys(), ...map2.keys()]);

  const differences = [];
  for (const pid of allIds) {
    const i1 = map1.get(pid);
    const i2 = map2.get(pid);
    const q1 = i1?.quantity ?? 0;
    const q2 = i2?.quantity ?? 0;
    if (q1 !== q2) {
      differences.push({
        productId: pid,
        productCode: i1?.productCode ?? i2?.productCode,
        productName: i1?.productName ?? i2?.productName,
        qtySnapshot1: q1,
        qtySnapshot2: q2,
        difference: q2 - q1,
        snapshot1Date: s1.createdAt,
        snapshot2Date: s2.createdAt,
      });
    }
  }

  return {
    snapshot1: { id: s1.id, createdAt: s1.createdAt, type: s1.snapshotType },
    snapshot2: { id: s2.id, createdAt: s2.createdAt, type: s2.snapshotType },
    locationId: s1.locationId,
    locationName: (s1 as any).location_name,
    totalDifferences: differences.length,
    totalQtyDiff: differences.reduce((sum, d) => sum + Math.abs(d.difference), 0),
    differences: differences.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)),
  };
}

/**
 * Verificar integridad de snapshot (hash).
 * El hash canonico se recalcula en SQL con la MISMA expresion que usa
 * create_stock_snapshot al crear (jsonb_build_object productId/quantity/
 * unitCost + digest sha256): antes el calculo en JSON.stringify de rows
 * snake_case nunca podia coincidir con la funcion de BD y toda verificacion
 * daba "manipulado" por desformato, no por tampering.
 */
export async function verifySnapshotIntegrity(snapshotId: number) {
  const snap = await getSnapshot(snapshotId);
  if (!snap) throw ApiError.notFound('Snapshot no encontrado');

  // La funcion de BD usa COALESCE(..., '[]') para snapshots vacios: replicar
  // exactamente la misma expresion o los vacios dara "manipulado".
  const r = await query<{ computed_hash: string | null; item_count: string }>(
    `SELECT encode(digest(
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'productId', si.product_id,
             'quantity', si.quantity,
             'unitCost', si.unit_cost
         ) ORDER BY si.product_id)
         FROM stock_snapshot_items si WHERE si.snapshot_id = $1), '[]'::jsonb)::text,
        'sha256'
     ), 'hex') AS computed_hash,
     (SELECT COUNT(*) FROM stock_snapshot_items WHERE snapshot_id = $1) AS item_count`,
    [snapshotId]
  );
  const computedHash = r.rows[0].computed_hash ?? '';

  return {
    snapshotId,
    storedHash: snap.dataHash,
    computedHash,
    itemCount: Number(r.rows[0].item_count),
    isValid: snap.dataHash === computedHash,
  };
}

/**
 * Job programado: crear snapshots diarios para todas las ubicaciones activas
 */
export async function createDailySnapshots(user: AuthUser | null) {
  const locations = await query('SELECT id FROM locations WHERE is_active = true');
  const results = [];

  for (const loc of locations.rows) {
    try {
      const snap = await createSnapshot(user, undefined, loc.id, 'DAILY');
      results.push({ locationId: loc.id, snapshotId: snap.id, status: 'OK' });
    } catch (err) {
      results.push({ locationId: loc.id, status: 'ERROR', error: (err as Error).message });
    }
  }
  return results;
}

/**
 * Job programado: crear snapshots semanales
 */
export async function createWeeklySnapshots(user: AuthUser | null) {
  const locations = await query('SELECT id FROM locations WHERE is_active = true');
  const results = [];

  for (const loc of locations.rows) {
    try {
      const snap = await createSnapshot(user, undefined, loc.id, 'WEEKLY');
      results.push({ locationId: loc.id, snapshotId: snap.id, status: 'OK' });
    } catch (err) {
      results.push({ locationId: loc.id, status: 'ERROR', error: (err as Error).message });
    }
  }
  return results;
}

/**
 * Obtener serie temporal de stock para un producto en una ubicacion (desde snapshots)
 */
export async function getProductStockHistory(locationId: number, productId: number, limit = 30) {
  const rows = await query(
    `SELECT s.created_at, s.snapshot_type, si.quantity, si.unit_cost
     FROM stock_snapshots s
     JOIN stock_snapshot_items si ON si.snapshot_id = s.id
     WHERE s.location_id = $1 AND si.product_id = $2
     ORDER BY s.created_at DESC LIMIT $3`,
    [locationId, productId, limit]
  );
  return rows.rows.map(r => ({
    date: r.created_at,
    type: r.snapshot_type,
    quantity: Number(r.quantity),
    unitCost: r.unit_cost ? Number(r.unit_cost) : null,
  }));
}