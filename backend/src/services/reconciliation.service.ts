import { query, withTx, pool } from '../db/pool';
import { writeAudit } from './audit.service';
import { AuthUser } from '../middleware/auth';
import { createAlert } from './alerts.service';

export interface ReconciliationResult {
  locationId: number;
  locationName: string;
  checkType: string;
  status: 'OK' | 'WARNING' | 'ERROR' | 'FIXED';
  expectedValue: number;
  actualValue: number;
  difference: number;
  details: Record<string, unknown>;
}

/**
 * Conciliacion 1: Saldos vs Movimientos (detecta gaps)
 * stock_balances.quantity debe ser igual a SUM(stock_movements) con signo
 */
export async function reconcileBalancesVsMovements(locationId?: number) {
  const locFilter = locationId ? 'AND sb.location_id = $1' : '';
  const params = locationId ? [locationId] : [];

  const gaps = await query(
    `SELECT sb.location_id, l.name AS location_name, sb.product_id, p.code, p.name,
            sb.quantity AS balance_qty,
            COALESCE(SUM(CASE
              WHEN sm.type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA') THEN sm.quantity
              WHEN sm.type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA') THEN -sm.quantity
              ELSE 0 END), 0) AS movements_sum
     FROM stock_balances sb
     JOIN products p ON p.id = sb.product_id
     JOIN locations l ON l.id = sb.location_id
     LEFT JOIN stock_movements sm ON sm.product_id = sb.product_id AND sm.location_id = sb.location_id
     WHERE sb.quantity > 0 ${locFilter}
     GROUP BY sb.location_id, l.name, sb.product_id, p.code, p.name, sb.quantity
     HAVING sb.quantity <> COALESCE(SUM(CASE
              WHEN sm.type IN ('ENTRADA','AJUSTE_POS','TRANS_ENTRADA') THEN sm.quantity
              WHEN sm.type IN ('SALIDA','AJUSTE_NEG','TRANS_SALIDA') THEN -sm.quantity
              ELSE 0 END), 0)
     ORDER BY l.name, p.name`,
    params
  );

  const results: ReconciliationResult[] = [];
  for (const g of gaps.rows) {
    const diff = Number(g.balance_qty) - Number(g.movements_sum);
    const status = diff === 0 ? 'OK' : (Math.abs(diff) < 0.001 ? 'WARNING' : 'ERROR');
    results.push({
      locationId: g.location_id,
      locationName: g.location_name,
      checkType: 'BALANCE_VS_MOVEMENTS',
      status,
      expectedValue: Number(g.movements_sum),
      actualValue: Number(g.balance_qty),
      difference: diff,
      details: { productId: g.product_id, productCode: g.code, productName: g.name },
    });

    if (status !== 'OK') {
      await createAlert({
        code: 'RECONCILIATION_GAP',
        severity: status === 'ERROR' ? 'CRITICAL' : 'WARNING',
        entityType: 'PRODUCT',
        entityId: g.product_id,
        title: `Gap de conciliación: ${g.code} en ${g.location_name}`,
        message: `Stock balance (${g.balance_qty}) ≠ suma movimientos (${g.movements_sum}). Diferencia: ${diff.toFixed(3)}`,
        data: { locationId: g.location_id, locationName: g.location_name, productId: g.product_id, productCode: g.code, balanceQty: Number(g.balance_qty), movementsSum: Number(g.movements_sum), difference: diff },
        targetRoles: ['ADMIN', 'ENCARGADO'],
        targetLocationId: g.location_id,
      });
    }
  }
  return results;
}

/**
 * Conciliacion 2: Transferencias en tránsito sin movimiento de salida correspondiente
 */
export async function reconcileTransitTransfers() {
  const gaps = await query(
    `SELECT t.id, t.number, t.origin_location_id, t.destination_location_id,
            lo.name AS origin_name, ld.name AS dest_name,
            t.sent_at, t.status
     FROM transfers t
     JOIN locations lo ON lo.id = t.origin_location_id
     JOIN locations ld ON ld.id = t.destination_location_id
     WHERE t.status = 'EN_TRANSITO'
       AND NOT EXISTS (
         SELECT 1 FROM stock_movements sm
         WHERE sm.reference_type = 'TRANSFER' AND sm.reference_id = t.id AND sm.type = 'TRANS_SALIDA'
       )`
  );

  const results: ReconciliationResult[] = [];
  for (const g of gaps.rows) {
    results.push({
      locationId: g.origin_location_id,
      locationName: g.origin_name,
      checkType: 'TRANSFER_GAP',
      status: 'ERROR',
      expectedValue: 1,
      actualValue: 0,
      difference: 1,
      details: { transferId: g.id, transferNumber: g.number, origin: g.origin_name, destination: g.dest_name, sentAt: g.sent_at },
    });

    await createAlert({
      code: 'TRANSFER_MOVEMENT_MISSING',
      severity: 'CRITICAL',
      entityType: 'TRANSFER',
      entityId: g.id,
      title: `Transferencia sin movimiento de salida: ${g.number}`,
      message: `La transferencia ${g.number} de ${g.origin_name} a ${g.dest_name} está EN_TRANSITO pero no tiene movimiento TRANS_SALIDA registrado.`,
      data: { transferId: g.id, transferNumber: g.number, origin: g.origin_name, destination: g.dest_name },
      targetRoles: ['ADMIN', 'ENCARGADO'],
      targetLocationId: g.origin_location_id,
    });
  }
  return results;
}

/**
 * Conciliacion 3: Entregas pendientes con reservas expiradas
 */
export async function reconcileStalePendingDeliveries() {
  const stale = await query(
    `SELECT pd.id, pd.number, pd.barcode, pd.pickup_location_id, pd.status, pd.created_at,
            pl.name AS pickup_name
     FROM pending_deliveries pd
     JOIN locations pl ON pl.id = pd.pickup_location_id
     WHERE pd.status IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL')
       AND pd.created_at < now() - interval '48 hours'`
  );

  const results: ReconciliationResult[] = [];
  for (const s of stale.rows) {
    results.push({
      locationId: s.pickup_location_id,
      locationName: s.pickup_name,
      checkType: 'PENDING_DELIVERY_STALE',
      status: 'WARNING',
      expectedValue: 0,
      actualValue: 1,
      difference: 1,
      details: { pendingDeliveryId: s.id, number: s.number, barcode: s.barcode, status: s.status, createdAt: s.created_at },
    });
  }
  return results;
}

/**
 * Conciliacion 4: Stock negativo (no deberia existir por constraint, pero verificamos)
 */
export async function reconcileNegativeStock() {
  const neg = await query(
    `SELECT sb.product_id, sb.location_id, sb.quantity, p.code, p.name, l.name AS location_name
     FROM stock_balances sb
     JOIN products p ON p.id = sb.product_id
     JOIN locations l ON l.id = sb.location_id
     WHERE sb.quantity < 0`
  );

  const results: ReconciliationResult[] = [];
  for (const n of neg.rows) {
    results.push({
      locationId: n.location_id,
      locationName: n.location_name,
      checkType: 'NEGATIVE_STOCK',
      status: 'ERROR',
      expectedValue: 0,
      actualValue: Number(n.quantity),
      difference: Number(n.quantity),
      details: { productId: n.product_id, productCode: n.code, productName: n.name, quantity: Number(n.quantity) },
    });

    await createAlert({
      code: 'NEGATIVE_STOCK_DETECTED',
      severity: 'CRITICAL',
      entityType: 'PRODUCT',
      entityId: n.product_id,
      title: `Stock negativo detectado: ${n.code}`,
      message: `En ${n.location_name} el producto ${n.code} - ${n.name} tiene stock ${n.quantity} (negativo).`,
      data: { locationId: n.location_id, locationName: n.location_name, productId: n.product_id, productCode: n.code, quantity: Number(n.quantity) },
      targetRoles: ['ADMIN'],
      targetLocationId: n.location_id,
    });
  }
  return results;
}

/**
 * Conciliacion 5: Movimientos huerfanos (sin documento de referencia valido)
 */
export async function reconcileOrphanMovements() {
  const orphans = await query(
    `SELECT sm.id, sm.reference_type, sm.reference_id, sm.type, sm.quantity, sm.created_at, sm.user_id, u.full_name
     FROM stock_movements sm
     JOIN users u ON u.id = sm.user_id
     WHERE sm.reference_type = 'DELIVERY' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id = sm.reference_id)
        OR sm.reference_type = 'ENTRY' AND NOT EXISTS (SELECT 1 FROM stock_entries e WHERE e.id = sm.reference_id)
        OR sm.reference_type = 'TRANSFER' AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.id = sm.reference_id)
        OR sm.reference_type = 'COUNT' AND NOT EXISTS (SELECT 1 FROM stock_counts c WHERE c.id = sm.reference_id)`
  );

  const results: ReconciliationResult[] = [];
  for (const o of orphans.rows) {
    results.push({
      locationId: 0,
      locationName: 'GLOBAL',
      checkType: 'ORPHAN_MOVEMENT',
      status: 'WARNING',
      expectedValue: 0,
      actualValue: 1,
      difference: 1,
      details: { movementId: o.id, referenceType: o.reference_type, referenceId: o.reference_id, movementType: o.type, quantity: Number(o.quantity), user: o.full_name },
    });
  }
  return results;
}

/**
 * Ejecutar conciliacion completa para una ubicacion (o todas)
 */
export async function runFullReconciliation(user: AuthUser, ip: string | undefined, locationId?: number) {
  const allResults: ReconciliationResult[] = [];

  const [r1, r2, r3, r4, r5] = await Promise.all([
    reconcileBalancesVsMovements(locationId),
    reconcileTransitTransfers(),
    reconcileStalePendingDeliveries(),
    reconcileNegativeStock(),
    reconcileOrphanMovements(),
  ]);

  allResults.push(...r1, ...r2, ...r3, ...r4, ...r5);

  // Log en reconciliation_logs
  // location_id es FK: los checks globales usan 0 como marcador de "GLOBAL"
  // en la respuesta, pero en la tabla debe guardarse NULL.
  for (const r of allResults) {
    await query(
      `INSERT INTO reconciliation_logs (location_id, check_type, status, expected_value, actual_value, difference, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.locationId || null, r.checkType, r.status, r.expectedValue, r.actualValue, r.difference, JSON.stringify(r.details)]
    );
  }

  await writeAudit(pool, { userId: user.id, action: 'RECONCILIATION_RUN', entity: 'reconciliation', entityId: null, details: { locationId, checksRun: 5, issuesFound: allResults.filter(x => x.status !== 'OK').length }, ip });

  return {
    locationId,
    totalChecks: 5,
    totalIssues: allResults.filter(x => x.status !== 'OK').length,
    results: allResults,
  };
}

/**
 * Obtener historial de conciliaciones
 */
export async function getReconciliationHistory(opts: { locationId?: number; status?: string; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.locationId) { params.push(opts.locationId); where.push(`location_id = $${params.length}`); }
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM reconciliation_logs ${whereSql}`, params);
  const rows = await query(
    `SELECT rl.*, l.name AS location_name
     FROM reconciliation_logs rl
     LEFT JOIN locations l ON l.id = rl.location_id
     ${whereSql} ORDER BY rl.run_at DESC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { logs: rows.rows, total: Number(count.rows[0].total) };
}