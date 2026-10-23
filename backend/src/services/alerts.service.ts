import { query, withTx } from '../db/pool';
import { ApiError } from '../lib/errors';
import { writeAudit } from './audit.service';
import { AuthUser } from '../middleware/auth';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'PENDIENTE' | 'VISTA' | 'RESUELTA' | 'DESCARTADA';

export interface Alert {
  id: number;
  code: string;
  severity: AlertSeverity;
  entityType: string | null;
  entityId: number | null;
  title: string;
  message: string;
  data: Record<string, unknown>;
  targetRoles: string[];
  targetLocationId: number | null;
  status: AlertStatus;
  acknowledgedBy: number | null;
  acknowledgedAt: Date | null;
  resolvedBy: number | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  createdAt: Date;
}

export interface CreateAlertInput {
  code: string;
  severity: AlertSeverity;
  entityType?: string | null;
  entityId?: number | null;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  targetRoles?: string[];
  targetLocationId?: number | null;
}

/**
 * Crear alerta
 */
export async function createAlert(input: CreateAlertInput) {
  // Deduplicacion: si ya existe una alerta no resuelta para el mismo
  // codigo+entidad, no re-crear (permite correr checks programados en cron
  // sin llenar la tabla con duplicados).
  if (input.code && input.entityType && input.entityId !== undefined && input.entityId !== null) {
    const dupe = await query<{ id: string }>(
      `SELECT id FROM alerts
       WHERE code = $1 AND entity_type = $2 AND entity_id = $3
         AND status IN ('PENDIENTE', 'VISTA')
       LIMIT 1`,
      [input.code, input.entityType, input.entityId]
    );
    if (dupe.rows[0]) return { alertId: Number(dupe.rows[0].id), deduplicated: true };
  }

  const r = await query<{ id: number }>(
    `SELECT create_alert($1, $2::alert_severity, $3, $4, $5, $6, $7::jsonb, $8::varchar[], $9) AS id`,
    [
      input.code,
      input.severity,
      input.entityType ?? null,
      input.entityId ?? null,
      input.title,
      input.message,
      JSON.stringify(input.data ?? {}),
      input.targetRoles ?? ['ADMIN', 'ENCARGADO'],
      input.targetLocationId ?? null,
    ]
  );
  return { alertId: r.rows[0].id };
}

/**
 * Listar alertas con filtros
 */
export async function listAlerts(opts: {
  status?: AlertStatus;
  severity?: AlertSeverity;
  code?: string;
  targetRole?: string;
  targetLocationId?: number;
  entityType?: string;
  entityId?: number;
  page: number; pageSize: number; offset: number;
}) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.severity) { params.push(opts.severity); where.push(`severity = $${params.length}`); }
  if (opts.code) { params.push(opts.code); where.push(`code = $${params.length}`); }
  if (opts.targetRole) { params.push(opts.targetRole); where.push(`$${params.length} = ANY(target_roles)`); }
  if (opts.targetLocationId) { params.push(opts.targetLocationId); where.push(`(target_location_id IS NULL OR target_location_id = $${params.length})`); }
  if (opts.entityType) { params.push(opts.entityType); where.push(`entity_type = $${params.length}`); }
  if (opts.entityId) { params.push(opts.entityId); where.push(`entity_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM alerts ${whereSql}`, params);
  const rows = await query(
    `SELECT a.*, u1.full_name AS ack_by_name, u2.full_name AS res_by_name
     FROM alerts a
     LEFT JOIN users u1 ON u1.id = a.acknowledged_by
     LEFT JOIN users u2 ON u2.id = a.resolved_by
     ${whereSql} ORDER BY
       CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
       created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { alerts: rows.rows.map(mapAlert), total: Number(count.rows[0].total) };
}

function mapAlert(r: any): Alert & { ackByName?: string; resByName?: string } {
  return {
    id: r.id,
    code: r.code,
    severity: r.severity,
    entityType: r.entity_type,
    entityId: r.entity_id,
    title: r.title,
    message: r.message,
    data: r.data,
    targetRoles: r.target_roles,
    targetLocationId: r.target_location_id,
    status: r.status,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: r.acknowledged_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
    ackByName: r.ack_by_name,
    resByName: r.res_by_name,
  };
}

/**
 * Obtener alerta por ID
 */
export async function getAlert(id: number) {
  const r = await query(
    `SELECT a.*, u1.full_name AS ack_by_name, u2.full_name AS res_by_name
     FROM alerts a
     LEFT JOIN users u1 ON u1.id = a.acknowledged_by
     LEFT JOIN users u2 ON u2.id = a.resolved_by
     WHERE a.id = $1`, [id]
  );
  if (!r.rows[0]) return null;
  return mapAlert(r.rows[0]);
}

/**
 * Marcar alerta como VISTA (acknowledge)
 */
export async function acknowledgeAlert(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    const r = await c.query(
      `UPDATE alerts SET status = 'VISTA', acknowledged_by = $1, acknowledged_at = now() WHERE id = $2 AND status = 'PENDIENTE' RETURNING id`,
      [user.id, id]
    );
    if (!r.rowCount) throw ApiError.notFound('Alerta no encontrada o ya no esta pendiente');
    await writeAudit(c, { userId: user.id, action: 'ALERT_ACKNOWLEDGE', entity: 'alert', entityId: id, ip });
    return { ok: true };
  });
}

/**
 * Resolver alerta
 */
export async function resolveAlert(user: AuthUser, ip: string | undefined, id: number, notes?: string) {
  return withTx(async (c) => {
    const r = await c.query(
      `UPDATE alerts SET status = 'RESUELTA', resolved_by = $1, resolved_at = now(), resolution_notes = $2 WHERE id = $3 AND status IN ('PENDIENTE','VISTA') RETURNING id`,
      [user.id, notes ?? null, id]
    );
    if (!r.rowCount) throw ApiError.notFound('Alerta no encontrada o ya resuelta');
    await writeAudit(c, { userId: user.id, action: 'ALERT_RESOLVE', entity: 'alert', entityId: id, details: { notes }, ip });
    return { ok: true };
  });
}

/**
 * Descartar alerta (solo ADMIN/ENCARGADO)
 */
export async function dismissAlert(user: AuthUser, ip: string | undefined, id: number, notes?: string) {
  return withTx(async (c) => {
    const r = await c.query(
      `UPDATE alerts SET status = 'DESCARTADA', resolved_by = $1, resolved_at = now(), resolution_notes = $2 WHERE id = $3 RETURNING id`,
      [user.id, notes ?? null, id]
    );
    if (!r.rowCount) throw ApiError.notFound('Alerta no encontrada');
    await writeAudit(c, { userId: user.id, action: 'ALERT_DISMISS', entity: 'alert', entityId: id, details: { notes }, ip });
    return { ok: true };
  });
}

/**
 * Contar alertas pendientes por rol/ubicacion (para badge en UI)
 */
export async function countPendingAlerts(targetRole: string, targetLocationId?: number) {
  const r = await query<{ total: string }>(
    `SELECT COUNT(*) total FROM alerts
     WHERE status = 'PENDIENTE'
       AND $1 = ANY(target_roles)
       AND (target_location_id IS NULL OR target_location_id = $2)`,
    [targetRole, targetLocationId ?? null]
  );
  return Number(r.rows[0].total);
}

/**
 * Job: Verificar transferencias vencidas (EN_TRANSITO > 24h)
 */
export async function checkOverdueTransfers() {
  const transfers = await query(
    `SELECT t.id, t.number, t.origin_location_id, t.destination_location_id,
            lo.name AS origin_name, ld.name AS dest_name,
            EXTRACT(EPOCH FROM (now() - t.sent_at))/3600 AS hours_in_transit
     FROM transfers t
     JOIN locations lo ON lo.id = t.origin_location_id
     JOIN locations ld ON ld.id = t.destination_location_id
     WHERE t.status = 'EN_TRANSITO'
       AND t.sent_at < now() - interval '24 hours'`
  );

  for (const t of transfers.rows) {
    const hours = Number(t.hours_in_transit);
    await createAlert({
      code: 'TRANSFER_OVERDUE',
      severity: hours > 48 ? 'CRITICAL' : 'WARNING',
      entityType: 'TRANSFER',
      entityId: t.id,
      title: `Transferencia vencida: ${t.number}`,
      message: `La transferencia ${t.number} de ${t.origin_name} a ${t.dest_name} lleva ${hours.toFixed(1)}h en tránsito sin confirmar recepción.`,
      data: { transferId: t.id, hoursInTransit: hours, origin: t.origin_name, destination: t.dest_name },
      targetRoles: ['ADMIN', 'ENCARGADO'],
      targetLocationId: t.destination_location_id,
    });
  }
  return { checked: transfers.rows.length, alertsCreated: transfers.rows.length };
}

/**
 * Job: Verificar entregas pendientes por expirar (PENDING_DELIVERY > 40h de 48h)
 */
export async function checkExpiringPendingDeliveries() {
  const pending = await query(
    `SELECT pd.id, pd.number, pd.barcode, pd.pickup_location_id, pd.created_at,
            pl.name AS pickup_name,
            EXTRACT(EPOCH FROM (now() - pd.created_at))/3600 AS hours_pending
     FROM pending_deliveries pd
     JOIN locations pl ON pl.id = pd.pickup_location_id
     WHERE pd.status IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO')
       AND pd.created_at < now() - interval '40 hours'`
  );

  for (const p of pending.rows) {
    const hours = Number(p.hours_pending);
    await createAlert({
      code: 'PENDING_DELIVERY_EXPIRING',
      severity: hours > 46 ? 'CRITICAL' : 'WARNING',
      entityType: 'PENDING_DELIVERY',
      entityId: p.id,
      title: `Entrega pendiente por expirar: ${p.number}`,
      message: `La orden pendiente ${p.number} (código ${p.barcode}) en ${p.pickup_name} lleva ${hours.toFixed(1)}h sin retirar. Expira en ${(48 - hours).toFixed(1)}h.`,
      data: { pendingDeliveryId: p.id, barcode: p.barcode, hoursPending: hours, pickupLocation: p.pickup_name },
      targetRoles: ['ADMIN', 'ENCARGADO'],
      targetLocationId: p.pickup_location_id,
    });
  }
  return { checked: pending.rows.length, alertsCreated: pending.rows.length };
}

/**
 * Job: Verificar stock bajo minimo
 */
export async function checkLowStock() {
  const lowStock = await query(
    `SELECT sb.product_id, sb.location_id, sb.quantity, p.min_stock, p.code, p.name, l.name AS location_name
     FROM stock_balances sb
     JOIN products p ON p.id = sb.product_id
     JOIN locations l ON l.id = sb.location_id
     WHERE sb.quantity > 0 AND sb.quantity <= p.min_stock AND p.min_stock > 0 AND l.is_active`
  );

  for (const s of lowStock.rows) {
    await createAlert({
      code: 'STOCK_BELOW_MIN',
      severity: s.quantity === 0 ? 'CRITICAL' : 'WARNING',
      entityType: 'PRODUCT',
      entityId: s.product_id,
      title: `Stock bajo mínimo: ${s.code} - ${s.name}`,
      message: `En ${s.location_name} hay ${s.quantity} ${s.name} (mínimo: ${s.min_stock}).`,
      data: { productId: s.product_id, productCode: s.code, productName: s.name, locationId: s.location_id, locationName: s.location_name, currentQty: s.quantity, minStock: s.min_stock },
      targetRoles: ['ADMIN', 'ENCARGADO'],
      targetLocationId: s.location_id,
    });
  }
  return { checked: lowStock.rows.length, alertsCreated: lowStock.rows.length };
}

/**
 * Job: Verificar anulaciones anómalas (mismo usuario anula > 3/dia)
 */
export async function checkVoidAnomalies() {
  const anomalies = await query(
    `SELECT voided_by, COUNT(*) as void_count, DATE(voided_at) as void_date
     FROM (
       SELECT voided_by, voided_at FROM transfers WHERE voided_at > now() - interval '24 hours' AND voided_by IS NOT NULL
       UNION ALL SELECT voided_by, voided_at FROM deliveries WHERE voided_at > now() - interval '24 hours' AND voided_by IS NOT NULL
       UNION ALL SELECT voided_by, voided_at FROM stock_entries WHERE voided_at > now() - interval '24 hours' AND voided_by IS NOT NULL
       UNION ALL SELECT voided_by, voided_at FROM stock_counts WHERE voided_at > now() - interval '24 hours' AND voided_by IS NOT NULL
     ) v
     GROUP BY voided_by, DATE(voided_at)
     HAVING COUNT(*) > 3`
  );

  for (const a of anomalies.rows) {
    const user = await query('SELECT full_name FROM users WHERE id = $1', [a.voided_by]);
    await createAlert({
      code: 'VOID_ANOMALY',
      severity: 'WARNING',
      entityType: 'USER',
      entityId: a.voided_by,
      title: `Anomalía de anulaciones: ${user.rows[0]?.full_name || 'Usuario ' + a.voided_by}`,
      message: `El usuario anuló ${a.void_count} documentos en ${a.void_date}. Revisar patrones.`,
      data: { userId: a.voided_by, voidCount: a.void_count, voidDate: a.void_date },
      targetRoles: ['ADMIN'],
    });
  }
  return { checked: anomalies.rows.length, alertsCreated: anomalies.rows.length };
}

/**
 * Ejecutar todos los checks programados (llamar desde cron/job scheduler)
 */
export async function runAllScheduledChecks() {
  const results = await Promise.allSettled([
    checkOverdueTransfers(),
    checkExpiringPendingDeliveries(),
    checkLowStock(),
    checkVoidAnomalies(),
  ]);
  return results.map((r, i) => ({ check: ['overdueTransfers', 'expiringPending', 'lowStock', 'voidAnomalies'][i], ...(r.status === 'fulfilled' ? r.value : { error: r.reason }) }));
}