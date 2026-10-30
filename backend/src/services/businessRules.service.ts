import { query, withTx } from '../db/pool';
import { ApiError } from '../lib/errors';
import { writeAudit } from './audit.service';
import { AuthUser } from '../middleware/auth';
import { cached, cacheInvalidate } from '../lib/memCache';

export interface BusinessRuleInput {
  code: string;
  name: string;
  description?: string;
  entityType: 'TRANSFER' | 'DELIVERY' | 'ENTRY' | 'COUNT' | 'VOID' | 'STOCK_ADJUST';
  triggerEvent: 'BEFORE_CREATE' | 'BEFORE_CONFIRM' | 'BEFORE_RECEIVE' | 'BEFORE_VOID' | 'BEFORE_APPLY' | 'BEFORE_ADJUST';
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  severity?: 'INFO' | 'WARNING' | 'BLOCKING';
  isActive?: boolean;
}

export interface BusinessRule extends BusinessRuleInput {
  id: number;
  isActive: boolean;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ControlThresholdInput {
  locationId: number | null;  // null = global
  entityType: 'TRANSFER' | 'DELIVERY' | 'ENTRY' | 'COUNT' | 'VOID' | 'STOCK_ADJUST' | 'PRODUCT';
  metric: string;  // 'qty_sum', 'value_sum', 'lines_count', 'days_in_transit', 'pending_hours', 'stock_below_min', 'void_count_per_user_day'
  thresholdValue: number;
  thresholdOperator: 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ';
  action: Record<string, unknown>;  // { "require_approval": true, "min_role": "ENCARGADO", "alert": true, "alert_code": "CODE" }
}

export interface ControlThreshold extends ControlThresholdInput {
  id: number;
  isActive: boolean;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Listar reglas de negocio
 */
export async function listBusinessRules(opts: { entityType?: string; triggerEvent?: string; isActive?: boolean; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.entityType) { params.push(opts.entityType); where.push(`entity_type = $${params.length}`); }
  if (opts.triggerEvent) { params.push(opts.triggerEvent); where.push(`trigger_event = $${params.length}`); }
  if (opts.isActive !== undefined) { params.push(opts.isActive); where.push(`is_active = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM business_rules ${whereSql}`, params);
  const rows = await query(
    `SELECT * FROM business_rules ${whereSql} ORDER BY entity_type, trigger_event, priority ASC, id ASC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { rules: rows.rows.map(mapRule), total: Number(count.rows[0].total) };
}

function mapRule(r: any): BusinessRule {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    entityType: r.entity_type,
    triggerEvent: r.trigger_event,
    condition: r.condition,
    action: r.action,
    severity: r.severity,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Crear regla de negocio
 */
export async function createBusinessRule(user: AuthUser, ip: string | undefined, input: BusinessRuleInput) {
  return withTx(async (c) => {
    const r = await c.query<{ id: number }>(
      `INSERT INTO business_rules (code, name, description, entity_type, trigger_event, condition, action, severity, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.code, input.name, input.description ?? null, input.entityType, input.triggerEvent, JSON.stringify(input.condition), JSON.stringify(input.action), input.severity ?? 'WARNING', user.id]
    );
    await writeAudit(c, { userId: user.id, action: 'BUSINESS_RULE_CREATE', entity: 'business_rule', entityId: r.rows[0].id, details: input, ip });
    cacheInvalidate('business-rules:');
    return { id: r.rows[0].id };
  });
}

/**
 * Actualizar regla
 */
export async function updateBusinessRule(user: AuthUser, ip: string | undefined, id: number, input: Partial<BusinessRuleInput>) {
  return withTx(async (c) => {
    const existing = await c.query('SELECT id FROM business_rules WHERE id = $1', [id]);
    if (!existing.rows[0]) throw ApiError.notFound('Regla no encontrada');
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) { fields.push(`name = $${idx++}`); values.push(input.name); }
    if (input.description !== undefined) { fields.push(`description = $${idx++}`); values.push(input.description); }
    if (input.condition !== undefined) { fields.push(`condition = $${idx++}`); values.push(JSON.stringify(input.condition)); }
    if (input.action !== undefined) { fields.push(`action = $${idx++}`); values.push(JSON.stringify(input.action)); }
    if (input.severity !== undefined) { fields.push(`severity = $${idx++}`); values.push(input.severity); }
    if (input.isActive !== undefined) { fields.push(`is_active = $${idx++}`); values.push(input.isActive); }
    if (!fields.length) return { ok: true };
    fields.push(`updated_at = now()`);
    values.push(id);
    await c.query(`UPDATE business_rules SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    await writeAudit(c, { userId: user.id, action: 'BUSINESS_RULE_UPDATE', entity: 'business_rule', entityId: id, details: input, ip });
    cacheInvalidate('business-rules:');
    return { ok: true };
  });
}

/**
 * Evaluar reglas para un contexto (usa funcion BD evaluate_approval_rules extendida)
 */
export async function evaluateBusinessRules(entityType: string, triggerEvent: string, context: Record<string, unknown>) {
  // Las reglas activas se consultan en cada crear/confirmar/anular y casi
  // nunca cambian: cache de 30s (se invalida al editar una regla).
  const rules = await cached(`business-rules:${entityType}:${triggerEvent}`, 30_000, async () => {
    const r = await query(
      `SELECT id, code, name, severity, action, condition FROM business_rules
       WHERE entity_type = $1 AND trigger_event = $2 AND is_active = true
       ORDER BY priority ASC`,
      [entityType, triggerEvent]
    );
    return r.rows;
  });

  const results = [];
  for (const rule of rules) {
    const matches = evaluateCondition(rule.condition, context);
    if (matches) {
      results.push({
        ruleId: rule.id,
        ruleCode: rule.code,
        ruleName: rule.name,
        severity: rule.severity,
        action: rule.action,
      });
    }
  }
  return results;
}

/**
 * Evaluar condicion JSON simple contra contexto
 */
function evaluateCondition(condition: Record<string, unknown>, context: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(condition)) {
    const actual = context[key];
    if (actual === undefined || actual === null) {
      // Si la condicion exige un campo que no esta en contexto, no match
      return false;
    }
    // Soportar operadores sufijos: _gt, _gte, _lt, _lte, _eq, _in
    if (key.endsWith('_gt')) {
      const field = key.slice(0, -3);
      if (Number(context[field]) <= Number(expected)) return false;
    } else if (key.endsWith('_gte')) {
      const field = key.slice(0, -4);
      if (Number(context[field]) < Number(expected)) return false;
    } else if (key.endsWith('_lt')) {
      const field = key.slice(0, -3);
      if (Number(context[field]) >= Number(expected)) return false;
    } else if (key.endsWith('_lte')) {
      const field = key.slice(0, -4);
      if (Number(context[field]) > Number(expected)) return false;
    } else if (key.endsWith('_eq')) {
      const field = key.slice(0, -3);
      if (context[field] !== expected) return false;
    } else if (key.endsWith('_in')) {
      const field = key.slice(0, -3);
      const arr = Array.isArray(expected) ? expected : [expected];
      if (!arr.includes(context[field])) return false;
    } else {
      // Igualdad exacta
      if (context[key] !== expected) return false;
    }
  }
  return true;
}

/**
 * Listar umbrales de control
 */
export async function listControlThresholds(opts: { locationId?: number | null; entityType?: string; isActive?: boolean; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.locationId !== undefined) { params.push(opts.locationId); where.push(`location_id ${opts.locationId === null ? 'IS NULL' : '= $' + params.length}`); }
  if (opts.entityType) { params.push(opts.entityType); where.push(`entity_type = $${params.length}`); }
  if (opts.isActive !== undefined) { params.push(opts.isActive); where.push(`is_active = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM control_thresholds ${whereSql}`, params);
  const rows = await query(
    `SELECT * FROM control_thresholds ${whereSql} ORDER BY entity_type, metric LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { thresholds: rows.rows.map(mapThreshold), total: Number(count.rows[0].total) };
}

function mapThreshold(r: any): ControlThreshold {
  return {
    id: r.id,
    locationId: r.location_id,
    entityType: r.entity_type,
    metric: r.metric,
    thresholdValue: Number(r.threshold_value),
    thresholdOperator: r.threshold_operator,
    action: r.action,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Crear/actualizar umbral (upsert por unique key)
 */
export async function upsertControlThreshold(user: AuthUser, ip: string | undefined, input: ControlThresholdInput) {
  return withTx(async (c) => {
    await c.query(
      `INSERT INTO control_thresholds (location_id, entity_type, metric, threshold_value, threshold_operator, action, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (location_id, entity_type, metric) DO UPDATE SET
         threshold_value = EXCLUDED.threshold_value,
         threshold_operator = EXCLUDED.threshold_operator,
         action = EXCLUDED.action,
         updated_at = now()`,
      [input.locationId, input.entityType, input.metric, input.thresholdValue, input.thresholdOperator, JSON.stringify(input.action), user.id]
    );
    await writeAudit(c, { userId: user.id, action: 'CONTROL_THRESHOLD_UPSERT', entity: 'control_threshold', details: input, ip });
    return { ok: true };
  });
}

/**
 * Eliminar umbral
 */
export async function deleteControlThreshold(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    const r = await c.query(`DELETE FROM control_thresholds WHERE id = $1`, [id]);
    if (!r.rowCount) throw ApiError.notFound('Umbral no encontrado');
    await writeAudit(c, { userId: user.id, action: 'CONTROL_THRESHOLD_DELETE', entity: 'control_threshold', entityId: id, ip });
    return { ok: true };
  });
}

/**
 * Evaluar umbrales para un contexto y crear alertas si corresponde
 */
export async function evaluateThresholdsAndAlert(
  entityType: string,
  context: Record<string, unknown>,
  targetLocationId?: number
) {
  const thresholds = await query(
    `SELECT * FROM control_thresholds
     WHERE entity_type = $1 AND is_active = true
       AND (location_id IS NULL OR location_id = $2)`,
    [entityType, targetLocationId ?? null]
  );

  const alerts = [];
  for (const t of thresholds.rows) {
    const actual = context[t.metric];
    if (actual === undefined) continue;

    const threshold = Number(t.threshold_value);
    const op = t.threshold_operator;
    let triggered = false;

    if (op === 'GT' && Number(actual) > threshold) triggered = true;
    else if (op === 'GTE' && Number(actual) >= threshold) triggered = true;
    else if (op === 'LT' && Number(actual) < threshold) triggered = true;
    else if (op === 'LTE' && Number(actual) <= threshold) triggered = true;
    else if (op === 'EQ' && Number(actual) === threshold) triggered = true;

    if (triggered) {
      const action = t.action as Record<string, unknown>;
      if (action.alert) {
        alerts.push({
          code: action.alert_code || `${entityType}_${t.metric}_THRESHOLD`,
          severity: action.alert_severity || 'WARNING',
          entityType,
          entityId: context.entityId as number,
          title: `Umbral superado: ${t.metric}`,
          message: `${t.metric} = ${actual} (umbral: ${op} ${threshold})`,
          data: { ...context, threshold, operator: op, actual: Number(actual) },
          targetRoles: action.alert_roles || ['ADMIN', 'ENCARGADO'],
          targetLocationId,
        });
      }
    }
  }
  return alerts;
}