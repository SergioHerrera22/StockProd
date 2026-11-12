"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSnapshot = createSnapshot;
exports.createSnapshotInTx = createSnapshotInTx;
exports.getSnapshotInTx = getSnapshotInTx;
exports.getSnapshot = getSnapshot;
exports.listSnapshots = listSnapshots;
exports.compareSnapshots = compareSnapshots;
exports.verifySnapshotIntegrity = verifySnapshotIntegrity;
exports.createDailySnapshots = createDailySnapshots;
exports.createWeeklySnapshots = createWeeklySnapshots;
exports.getProductStockHistory = getProductStockHistory;
// @ts-nocheck
const pool_1 = require("../db/pool");
const errors_1 = require("../lib/errors");
const audit_service_1 = require("./audit.service");
/**
 * Crear snapshot manual o programado
 */
async function createSnapshot(user, ip, locationId, snapshotType, referenceId, referenceType) {
    return (0, pool_1.withTx)((c) => createSnapshotInTx(c, user, ip, locationId, snapshotType, referenceId, referenceType));
}
/**
 * Crear snapshot usando el cliente de una transaccion EXISTENTE.
 * Antes abria su propia withTx: invocada dentro de la tx de un conteo,
 * el snapshot quedaba commiteado aunque el conteo se revertiera (o al
 * revés). Compartir el cliente garantiza atomicidad con el conteo.
 */
async function createSnapshotInTx(c, user, ip, locationId, snapshotType, referenceId, referenceType) {
    // Verificar ubicacion activa
    const loc = await c.query('SELECT id FROM locations WHERE id = $1 AND is_active = true', [locationId]);
    if (!loc.rows[0])
        throw errors_1.ApiError.notFound('Ubicación no encontrada o inactiva');
    // Usar funcion BD para crear snapshot atomico
    const r = await c.query(`SELECT create_stock_snapshot($1, $2, $3, $4, $5) AS id`, [locationId, snapshotType, referenceId ?? null, referenceType ?? null, user?.id ?? null]);
    const snapshotId = r.rows[0].id;
    // Obtener detalle para respuesta (usar el mismo cliente de transaccion para ver datos no confirmados)
    const snap = await getSnapshotInTx(c, snapshotId);
    if (!snap)
        throw errors_1.ApiError.badRequest('Error creando snapshot');
    await (0, audit_service_1.writeAudit)(c, {
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
async function getSnapshotInTx(c, id) {
    const head = await c.query(`SELECT s.*, l.name AS location_name, l.code AS location_code, u.full_name AS created_by_name
     FROM stock_snapshots s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.id = $1`, [id]);
    if (!head.rows[0])
        return null;
    const items = await c.query(`SELECT si.*, p.code AS product_code, p.name AS product_name, p.unit
     FROM stock_snapshot_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.snapshot_id = $1 ORDER BY p.name`, [id]);
    const row = head.rows[0];
    const snapshot = {
        id: Number(row.id),
        locationId: Number(row.location_id),
        snapshotType: String(row.snapshot_type),
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
async function getSnapshot(id) {
    const head = await (0, pool_1.query)(`SELECT s.*, l.name AS location_name, l.code AS location_code, u.full_name AS created_by_name
     FROM stock_snapshots s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN users u ON u.id = s.created_by
     WHERE s.id = $1`, [id]);
    if (!head.rows[0])
        return null;
    const items = await (0, pool_1.query)(`SELECT si.*, p.code AS product_code, p.name AS product_name, p.unit
     FROM stock_snapshot_items si
     JOIN products p ON p.id = si.product_id
     WHERE si.snapshot_id = $1 ORDER BY p.name`, [id]);
    const row = head.rows[0];
    const snapshot = {
        id: Number(row.id),
        locationId: Number(row.location_id),
        snapshotType: String(row.snapshot_type),
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
async function listSnapshots(opts) {
    const params = [];
    const where = [];
    if (opts.locationId) {
        params.push(opts.locationId);
        where.push(`s.location_id = $${params.length}`);
    }
    if (opts.snapshotType) {
        params.push(opts.snapshotType);
        where.push(`s.snapshot_type = $${params.length}`);
    }
    if (opts.referenceType) {
        params.push(opts.referenceType);
        where.push(`s.reference_type = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await (0, pool_1.query)(`SELECT COUNT(*) total FROM stock_snapshots s ${whereSql}`, params);
    const rows = await (0, pool_1.query)(`SELECT s.*, l.name AS location_name, l.code AS location_code, u.full_name AS created_by_name
     FROM stock_snapshots s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN users u ON u.id = s.created_by
     ${whereSql} ORDER BY s.created_at DESC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`, params);
    return { snapshots: rows.rows, total: Number(count.rows[0].total) };
}
/**
 * Comparar dos snapshots (diferencias de stock)
 */
async function compareSnapshots(snapshotId1, snapshotId2) {
    const [s1, s2] = await Promise.all([getSnapshot(snapshotId1), getSnapshot(snapshotId2)]);
    if (!s1 || !s2)
        throw errors_1.ApiError.notFound('Uno o ambos snapshots no encontrados');
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
        locationName: s1.location_name,
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
async function verifySnapshotIntegrity(snapshotId) {
    const snap = await getSnapshot(snapshotId);
    if (!snap)
        throw errors_1.ApiError.notFound('Snapshot no encontrado');
    // La funcion de BD usa COALESCE(..., '[]') para snapshots vacios: replicar
    // exactamente la misma expresion o los vacios dara "manipulado".
    const r = await (0, pool_1.query)(`SELECT encode(digest(
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'productId', si.product_id,
             'quantity', si.quantity,
             'unitCost', si.unit_cost
         ) ORDER BY si.product_id)
         FROM stock_snapshot_items si WHERE si.snapshot_id = $1), '[]'::jsonb)::text,
        'sha256'
     ), 'hex') AS computed_hash,
     (SELECT COUNT(*) FROM stock_snapshot_items WHERE snapshot_id = $1) AS item_count`, [snapshotId]);
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
async function createDailySnapshots(user) {
    const locations = await (0, pool_1.query)('SELECT id FROM locations WHERE is_active = true');
    const results = [];
    for (const loc of locations.rows) {
        try {
            const snap = await createSnapshot(user, undefined, loc.id, 'DAILY');
            results.push({ locationId: loc.id, snapshotId: snap.id, status: 'OK' });
        }
        catch (err) {
            results.push({ locationId: loc.id, status: 'ERROR', error: err.message });
        }
    }
    return results;
}
/**
 * Job programado: crear snapshots semanales
 */
async function createWeeklySnapshots(user) {
    const locations = await (0, pool_1.query)('SELECT id FROM locations WHERE is_active = true');
    const results = [];
    for (const loc of locations.rows) {
        try {
            const snap = await createSnapshot(user, undefined, loc.id, 'WEEKLY');
            results.push({ locationId: loc.id, snapshotId: snap.id, status: 'OK' });
        }
        catch (err) {
            results.push({ locationId: loc.id, status: 'ERROR', error: err.message });
        }
    }
    return results;
}
/**
 * Obtener serie temporal de stock para un producto en una ubicacion (desde snapshots)
 */
async function getProductStockHistory(locationId, productId, limit = 30) {
    const rows = await (0, pool_1.query)(`SELECT s.created_at, s.snapshot_type, si.quantity, si.unit_cost
     FROM stock_snapshots s
     JOIN stock_snapshot_items si ON si.snapshot_id = s.id
     WHERE s.location_id = $1 AND si.product_id = $2
     ORDER BY s.created_at DESC LIMIT $3`, [locationId, productId, limit]);
    return rows.rows.map(r => ({
        date: r.created_at,
        type: r.snapshot_type,
        quantity: Number(r.quantity),
        unitCost: r.unit_cost ? Number(r.unit_cost) : null,
    }));
}
