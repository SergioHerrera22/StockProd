import { PoolClient } from 'pg';
import { query, withTx } from '../db/pool';
import { ApiError } from '../lib/errors';
import { writeAudit } from './audit.service';
import { AuthUser } from '../middleware/auth';

export interface ApprovalRuleInput {
  name: string;
  entityType: 'TRANSFER' | 'DELIVERY' | 'ENTRY' | 'COUNT' | 'VOID' | 'STOCK_ADJUST';
  operation: 'CREATE' | 'CONFIRM' | 'RECEIVE' | 'VOID' | 'APPLY' | 'ADJUST';
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  priority?: number;
  isActive?: boolean;
}

export interface ApprovalRule extends ApprovalRuleInput {
  id: number;
  isActive: boolean;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRequestInput {
  ruleId: number;
  entityType: 'TRANSFER' | 'DELIVERY' | 'ENTRY' | 'COUNT' | 'VOID' | 'STOCK_ADJUST';
  entityId: number;
  entityNumber: string;
  requestedBy: number;
  context: Record<string, unknown>;
  expiresHours?: number;
}

export interface ApprovalRequest {
  id: number;
  ruleId: number;
  entityType: string;
  entityId: number;
  entityNumber: string;
  requestedBy: number;
  requestedAt: Date;
  status: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | 'EXPIRADO' | 'CANCELADO';
  context: Record<string, unknown>;
  resolvedBy: number | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalHistoryEntry {
  id: number;
  approvalRequestId: number;
  action: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  performedBy: number;
  performedAt: Date;
  notes: string | null;
  previousStatus: string | null;
  newStatus: string;
}

/**
 * Listar reglas de aprobacion
 */
export async function listApprovalRules(opts: { entityType?: string; operation?: string; isActive?: boolean; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.entityType) { params.push(opts.entityType); where.push(`entity_type = $${params.length}`); }
  if (opts.operation) { params.push(opts.operation); where.push(`operation = $${params.length}`); }
  if (opts.isActive !== undefined) { params.push(opts.isActive); where.push(`is_active = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM approval_rules ${whereSql}`, params);
  const rows = await query(
    `SELECT * FROM approval_rules ${whereSql} ORDER BY priority ASC, id ASC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { rules: rows.rows.map(mapRule), total: Number(count.rows[0].total) };
}

function mapRule(r: any): ApprovalRule {
  return {
    id: r.id,
    name: r.name,
    entityType: r.entity_type,
    operation: r.operation,
    condition: r.condition,
    action: r.action,
    isActive: r.is_active,
    priority: r.priority,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Crear regla de aprobacion
 */
export async function createApprovalRule(user: AuthUser, ip: string | undefined, input: ApprovalRuleInput) {
  return withTx(async (c) => {
    const r = await c.query<{ id: number }>(
      `INSERT INTO approval_rules (name, entity_type, operation, condition, action, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.name, input.entityType, input.operation, JSON.stringify(input.condition), JSON.stringify(input.action), input.priority ?? 100, user.id]
    );
    await writeAudit(c, { userId: user.id, action: 'APPROVAL_RULE_CREATE', entity: 'approval_rule', entityId: r.rows[0].id, details: input, ip });
    return { id: r.rows[0].id };
  });
}

/**
 * Actualizar regla
 */
export async function updateApprovalRule(user: AuthUser, ip: string | undefined, id: number, input: Partial<ApprovalRuleInput>) {
  return withTx(async (c) => {
    const existing = await c.query('SELECT id FROM approval_rules WHERE id = $1', [id]);
    if (!existing.rows[0]) throw ApiError.notFound('Regla no encontrada');
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) { fields.push(`name = $${idx++}`); values.push(input.name); }
    if (input.condition !== undefined) { fields.push(`condition = $${idx++}`); values.push(JSON.stringify(input.condition)); }
    if (input.action !== undefined) { fields.push(`action = $${idx++}`); values.push(JSON.stringify(input.action)); }
    if (input.priority !== undefined) { fields.push(`priority = $${idx++}`); values.push(input.priority); }
    if (input.isActive !== undefined) { fields.push(`is_active = $${idx++}`); values.push(input.isActive); }
    if (!fields.length) return { ok: true };
    fields.push(`updated_at = now()`);
    values.push(id);
    await c.query(`UPDATE approval_rules SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    await writeAudit(c, { userId: user.id, action: 'APPROVAL_RULE_UPDATE', entity: 'approval_rule', entityId: id, details: input, ip });
    return { ok: true };
  });
}

/**
 * Evaluar reglas para una operacion (devuelve reglas que aplican)
 */
export async function evaluateApprovalRules(entityType: string, operation: string, context: Record<string, unknown>) {
  const rows = await query(
    `SELECT * FROM evaluate_approval_rules($1::approval_entity, $2, $3::jsonb)`,
    [entityType, operation, JSON.stringify(context)]
  );
  return rows.rows;
}

/**
 * Crear solicitud de aprobacion.
 * Acepta un PoolClient OPCIONAL: invocada dentro de la transaccion del
 * documento padre (entrada/transferencia/entrega/conteo), corre en esa MISMA
 * tx. Antes abria withTx propia: obtenia una SEGUNDA conexion del pool con la
 * primera retenida (agotamiento/bloqueos bajo carga) y, peor, si el padre
 * hacia ROLLBACK la solicitud quedaba COMMITTEADA apuntando a un documento
 * que nunca existio. Con client opcional queda todo atomico.
 */
export async function createApprovalRequest(input: ApprovalRequestInput, client?: PoolClient) {
  const run = async (c: PoolClient) => {
    const r = await c.query<{ id: number }>(
      `SELECT create_approval_request($1,$2,$3,$4,$5,$6::jsonb,$7) AS id`,
      [input.ruleId, input.entityType, input.entityId, input.entityNumber, input.requestedBy, JSON.stringify(input.context), input.expiresHours ?? 48]
    );
    return { approvalRequestId: r.rows[0].id };
  };
  return client ? run(client) : withTx(run);
}

/**
 * Listar solicitudes pendientes (para el aprobador)
 */
export async function listApprovalRequests(opts: {
  status?: string; entityType?: string; requestedBy?: number; page: number; pageSize: number; offset: number;
}) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.entityType) { params.push(opts.entityType); where.push(`entity_type = $${params.length}`); }
  if (opts.requestedBy) { params.push(opts.requestedBy); where.push(`requested_by = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM approval_requests ${whereSql}`, params);
  const rows = await query(
    `SELECT ar.*, u.full_name AS requested_by_name
     FROM approval_requests ar
     JOIN users u ON u.id = ar.requested_by
     ${whereSql} ORDER BY ar.requested_at DESC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { requests: rows.rows.map(mapRequest), total: Number(count.rows[0].total) };
}

function mapRequest(r: any): ApprovalRequest & { requestedByName: string } {
  return {
    id: r.id,
    ruleId: r.rule_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityNumber: r.entity_number,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    status: r.status,
    context: r.context,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    resolutionNotes: r.resolution_notes,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    requestedByName: r.requested_by_name,
  };
}

/**
 * Obtener detalle de solicitud con historial
 */
export async function getApprovalRequest(id: number) {
  const head = await query(
    `SELECT ar.*, u.full_name AS requested_by_name, ru.full_name AS resolved_by_name
     FROM approval_requests ar
     JOIN users u ON u.id = ar.requested_by
     LEFT JOIN users ru ON ru.id = ar.resolved_by
     WHERE ar.id = $1`, [id]
  );
  if (!head.rows[0]) return null;
  const hist = await query(
    `SELECT ah.*, u.full_name AS performed_by_name
     FROM approval_history ah
     JOIN users u ON u.id = ah.performed_by
     WHERE ah.approval_request_id = $1 ORDER BY ah.performed_at`, [id]
  );
  return { ...mapRequest(head.rows[0]), history: hist.rows.map(mapHistory) };
}

function mapHistory(r: any): ApprovalHistoryEntry {
  return {
    id: r.id,
    approvalRequestId: r.approval_request_id,
    action: r.action,
    performedBy: r.performed_by,
    performedAt: r.performed_at,
    notes: r.notes,
    previousStatus: r.previous_status,
    newStatus: r.new_status,
  };
}

/**
 * Resolver solicitud (aprobar/rechazar)
 */
export async function resolveApprovalRequest(
  user: AuthUser, ip: string | undefined, id: number, action: 'APPROVE' | 'REJECT', notes?: string
) {
  return withTx(async (c) => {
    const r = await c.query<{ success: boolean }>(
      `SELECT resolve_approval_request($1, $2, $3, $4) AS success`,
      [id, user.id, action, notes ?? null]
    );
    if (!r.rows[0].success) throw ApiError.conflict('No se pudo resolver la solicitud');
    const req = await getApprovalRequest(id);
    await writeAudit(c, { userId: user.id, action: `APPROVAL_REQUEST_${action}`, entity: 'approval_request', entityId: id, details: { action, notes, entityType: req?.entityType, entityNumber: req?.entityNumber }, ip });
    return { ok: true, request: req };
  });
}

/**
 * Cancelar solicitud propia (solo si PENDIENTE)
 */
export async function cancelApprovalRequest(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    const req = await c.query('SELECT status, requested_by FROM approval_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!req.rows[0]) throw ApiError.notFound('Solicitud no encontrada');
    if (req.rows[0].requested_by !== user.id) throw ApiError.forbidden('Solo el solicitante puede cancelar');
    if (req.rows[0].status !== 'PENDIENTE') throw ApiError.conflict('Solo se pueden cancelar solicitudes pendientes');
    await c.query(`UPDATE approval_requests SET status = 'CANCELADO', updated_at = now() WHERE id = $1`, [id]);
    await c.query(`INSERT INTO approval_history (approval_request_id, action, performed_by, previous_status, new_status, notes) VALUES ($1, 'CANCELLED', $2, $3, 'CANCELADO', 'Cancelada por solicitante')`, [id, user.id, req.rows[0].status]);
    await writeAudit(c, { userId: user.id, action: 'APPROVAL_REQUEST_CANCEL', entity: 'approval_request', entityId: id, ip });
    return { ok: true };
  });
}

/**
 * Verificar si una entidad tiene aprobacion pendiente o aprobada
 */
export async function checkApprovalStatus(entityType: string, entityId: number): Promise<{ status: string; approvalId: number | null }> {
  const r = await query(
    `SELECT status, id FROM approval_requests WHERE entity_type = $1 AND entity_id = $2 ORDER BY requested_at DESC LIMIT 1`,
    [entityType, entityId]
  );
  if (!r.rows[0]) return { status: 'NOT_REQUIRED', approvalId: null };
  return { status: r.rows[0].status, approvalId: r.rows[0].id };
}