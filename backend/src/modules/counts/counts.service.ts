import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { applyStockChange } from '../../services/stockEngine';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';
import { assertLocationAccess } from '../../lib/locationGuard';
import { AuthUser } from '../../middleware/auth';
import { evaluateBusinessRules } from '../../services/businessRules.service';
import { createApprovalRequest } from '../../services/approval.service';
import { createAlert } from '../../services/alerts.service';
import { createSnapshot } from '../../services/snapshot.service';

/**
 * Crea un recuento por ubicacion. Toma una fotografia del stock del sistema
 * (system_quantity) por producto. productIds opcional: si no viene, incluye
 * todos los productos activos.
 */
export async function createCount(
  user: AuthUser, ip: string | undefined,
  locationId: number, notes: string | null, productIds?: number[]
) {
  assertLocationAccess(user, locationId);
  return withTx(async (c) => {
    const loc = await c.query('SELECT id, name FROM locations WHERE id = $1 AND is_active', [locationId]);
    if (!loc.rows[0]) throw ApiError.badRequest('Ubicacion invalida');

    // Crear snapshot PRE_COUNT para referencia
    await createSnapshot(user, ip, locationId, 'PRE_COUNT', undefined, undefined);

    const number = await nextDocNumber(c, 'count');
    const r = await c.query<{ id: number }>(
      `INSERT INTO stock_counts (number, location_id, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [number, locationId, notes, user.id]
    );
    const countId = r.rows[0].id;

    await c.query(
      `INSERT INTO stock_count_items (count_id, product_id, system_quantity)
       SELECT $1, p.id, COALESCE(sb.quantity, 0)
       FROM products p
       LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.location_id = $2
       WHERE p.is_active
         AND ($3::int[] IS NULL OR p.id = ANY($3))
       ORDER BY p.name`,
      [countId, locationId, productIds?.length ? productIds : null]
    );

    await writeAudit(c, {
      userId: user.id, action: 'COUNT_CREATE', entity: 'count', entityId: countId,
      details: { number, locationId }, ip,
    });
    return { id: countId, number };
  });
}

/** Guarda cantidades contadas (parcial o total, cuantas veces haga falta mientras este ABIERTO). */
export async function saveCountItems(
  user: AuthUser, ip: string | undefined, id: number,
  items: { itemId: number; countedQuantity: number }[]
) {
  return withTx(async (c) => {
    const countRow = await c.query<{ status: string; location_id: number }>(
      'SELECT status, location_id FROM stock_counts WHERE id = $1 FOR UPDATE', [id]
    );
    if (!countRow.rows[0]) throw ApiError.notFound('Inventario no encontrado');
    assertLocationAccess(user, countRow.rows[0].location_id);
    if (countRow.rows[0].status !== 'ABIERTO') throw ApiError.conflict('El inventario ya fue cerrado o aplicado');

    for (const it of items) {
      if (!Number.isFinite(it.countedQuantity) || it.countedQuantity < 0) {
        throw ApiError.badRequest('Las cantidades contadas deben ser cero o mayores');
      }
      const r = await c.query(
        `UPDATE stock_count_items SET counted_quantity = $1 WHERE id = $2 AND count_id = $3`,
        [it.countedQuantity, it.itemId, id]
      );
      if (!r.rowCount) throw ApiError.badRequest('Item de inventario invalido');
    }
    await writeAudit(c, {
      userId: user.id, action: 'COUNT_SAVE_ITEMS', entity: 'count', entityId: id,
      details: { items: items.length }, ip,
    });
    return { ok: true };
  });
}

/**
 * Aplica el inventario: genera los movimientos de ajuste necesarios para que
 * cada producto quede exactamente en la cantidad contada. Motivo obligatorio.
 * Ahora con: evaluación de reglas, solicitud de aprobación si corresponde, segregación de funciones.
 */
export async function applyCount(user: AuthUser, ip: string | undefined, id: number, reason: string) {
  return withTx(async (c) => {
    const head = await c.query<{ status: string; number: string; location_id: number; created_by: number }>(
      'SELECT status, number, location_id, created_by FROM stock_counts WHERE id = $1 FOR UPDATE', [id]
    );
    const count = head.rows[0];
    if (!count) throw ApiError.notFound('Inventario no encontrado');
    assertLocationAccess(user, count.location_id);
    if (count.status !== 'ABIERTO') throw ApiError.conflict('El inventario ya fue procesado');
    if (!reason || reason.trim().length < 5) throw ApiError.badRequest('El motivo del ajuste es obligatorio');

    // Segregación: quien aplica NO debe ser quien creó
    if (count.created_by === user.id) {
      throw ApiError.forbidden('No puedes aplicar un inventario que tú mismo creaste (segregación de funciones)');
    }

    const items = await c.query<{ id: number; product_id: number; counted_quantity: string | null; system_quantity: string }>(
      'SELECT id, product_id, counted_quantity, system_quantity FROM stock_count_items WHERE count_id = $1', [id]
    );

    const adjustments = items.rows.filter(it => it.counted_quantity !== null && Number(it.counted_quantity) !== Number(it.system_quantity));
    const adjustmentsCount = adjustments.length;
    const totalLines = items.rows.filter(it => it.counted_quantity !== null).length;
    const context = { 
      lines_count: totalLines, 
      adjustments_count: adjustmentsCount,
      location_id: count.location_id, 
      user_role: user.role 
    };

    // Evaluar reglas ANTES de aplicar
    const rules = await evaluateBusinessRules('COUNT', 'BEFORE_APPLY', context);
    const requiresApproval = rules.some(r => r.action.require_approval);
    if (requiresApproval && user.role === 'EMPLEADO') {
      throw ApiError.forbidden('Este inventario requiere aprobador con rol ENCARGADO o superior');
    }

    if (requiresApproval) {
      const rule = rules.find(r => r.action.require_approval)!;
      await createApprovalRequest({
        ruleId: rule.ruleId,
        entityType: 'COUNT',
        entityId: id,
        entityNumber: count.number,
        requestedBy: user.id,
        context: { ...context, reason, adjustments: adjustmentsCount },
      });
      await writeAudit(c, { userId: user.id, action: 'COUNT_APPLY_PENDING_APPROVAL', entity: 'count', entityId: id, details: { reason, adjustments: adjustmentsCount, requiresApproval: true }, ip });
      return { ok: false, requiresApproval: true, adjustments: adjustmentsCount };
    }

    let appliedAdjustments = 0;
    for (const it of items.rows) {
      if (it.counted_quantity === null) continue; // no contado: no se ajusta
      const bal = await c.query<{ quantity: string }>(
        `INSERT INTO stock_balances (product_id, location_id, quantity)
         VALUES ($1,$2,0) ON CONFLICT (product_id, location_id) DO NOTHING
         RETURNING quantity`,
        [it.product_id, count.location_id]
      );
      const cur = bal.rows[0]
        ? Number(bal.rows[0].quantity)
        : Number((await c.query<{ quantity: string }>(
            'SELECT quantity FROM stock_balances WHERE product_id = $1 AND location_id = $2 FOR UPDATE',
            [it.product_id, count.location_id]
          )).rows[0].quantity);

      const delta = Number(it.counted_quantity) - cur;
      if (delta === 0) continue;

      await applyStockChange(c, {
        productId: it.product_id,
        locationId: count.location_id,
        delta,
        type: delta > 0 ? 'AJUSTE_POS' : 'AJUSTE_NEG',
        referenceType: 'COUNT',
        referenceId: id,
        referenceNumber: count.number,
        userId: user.id,
        reason: `Inventario ${count.number}: ${reason}`,
      });
      await c.query('UPDATE stock_count_items SET adjusted = true WHERE id = $1', [it.id]);
      appliedAdjustments++;
    }

    // Crear snapshot POST_COUNT
    await createSnapshot(user, ip, count.location_id, 'POST_COUNT', id, 'COUNT');

    await c.query(
      `UPDATE stock_counts SET status = 'APLICADO', approved_by = $1, applied_at = now() WHERE id = $2`,
      [user.id, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'COUNT_APPLY', entity: 'count', entityId: id,
      details: { reason, adjustments: appliedAdjustments }, ip,
    });

    // Resolver aprobación si existía
    await c.query(
      `UPDATE approval_requests SET status = 'APROBADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'COUNT' AND entity_id = $2 AND status = 'PENDIENTE'`,
      [user.id, id]
    );

    return { ok: true, adjustments: appliedAdjustments };
  });
}

/**
 * Aprobar inventario en ABIERTO (para flujo con aprobación)
 */
export async function approveCount(user: AuthUser, ip: string | undefined, id: number, reason: string) {
  return withTx(async (c) => {
    const head = await c.query<{ status: string; location_id: number; created_by: number }>(
      'SELECT status, location_id, created_by FROM stock_counts WHERE id = $1 FOR UPDATE', [id]
    );
    if (!head.rows[0]) throw ApiError.notFound('Inventario no encontrado');
    if (head.rows[0].status !== 'ABIERTO') throw ApiError.conflict('El inventario ya fue procesado');
    if (head.rows[0].created_by === user.id) throw ApiError.forbidden('No puedes aprobar un inventario que tú mismo creaste (segregación de funciones)');
    assertLocationAccess(user, head.rows[0].location_id);
    return applyCount(user, ip, id, reason);
  });
}

/**
 * Anulacion de inventario ABIERTO (no aplicado)
 * Si ya fue APLICADO, requiere DOBLE AUTORIZACION
 */
export async function voidCount(user: AuthUser, ip: string | undefined, id: number, reason: string, voidApprovedBy?: number) {
  return withTx(async (c) => {
    const head = await c.query<{ status: string; location_id: number; void_approved_by: number | null }>(
      'SELECT status, location_id, void_approved_by FROM stock_counts WHERE id = $1 FOR UPDATE', [id]
    );
    if (!head.rows[0]) throw ApiError.notFound('Inventario no encontrado');
    assertLocationAccess(user, head.rows[0].location_id);
    
    const count = head.rows[0];
    if (count.status === 'ANULADO') throw ApiError.conflict('El inventario ya esta anulado');

    const requiresDualAuth = count.status === 'APLICADO';
    if (requiresDualAuth) {
      if (!voidApprovedBy) throw ApiError.badRequest('Anulación de inventario aplicado requiere segundo autorizador (voidApprovedBy)');
      if (voidApprovedBy === user.id) throw ApiError.forbidden('El segundo autorizador debe ser distinto del solicitante');
      const approver = await c.query('SELECT role_code FROM users WHERE id = $1', [voidApprovedBy]);
      if (!approver.rows[0] || !['ENCARGADO', 'ADMIN'].includes(approver.rows[0].role_code)) {
        throw ApiError.forbidden('El segundo autorizador debe tener rol ENCARGADO o ADMIN');
      }
    } else if (count.status !== 'ABIERTO') {
      throw ApiError.conflict('Solo se pueden anular inventarios abiertos o aplicados (con doble auth)');
    }

    // Evaluar reglas
    const rules = await evaluateBusinessRules('VOID', 'VOID', { entity_id: id, user_role: user.role });
    const requiresApproval = rules.some(r => r.action.require_approval);
    if (requiresApproval && !voidApprovedBy) {
      throw ApiError.badRequest('Esta anulación requiere aprobación según reglas de negocio');
    }

    await c.query(
      `UPDATE stock_counts SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2, void_approved_by = $3 WHERE id = $4`,
      [user.id, reason, voidApprovedBy ?? null, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'COUNT_VOID', entity: 'count', entityId: id,
      details: { reason, voidApprovedBy, requiresDualAuth, wasApplied: requiresDualAuth }, ip,
    });

    if (requiresDualAuth) {
      await createAlert({
        code: 'COUNT_VOID_DUAL_AUTH',
        severity: 'WARNING',
        entityType: 'COUNT',
        entityId: id,
        title: `Inventario anulado con doble autorización`,
        message: `Anulado por ${user.fullName}, autorizado por usuario ${voidApprovedBy}. Motivo: ${reason}`,
        data: { countId: id, voidedBy: user.id, voidApprovedBy, reason },
        targetRoles: ['ADMIN'],
      });
    }

    return { ok: true };
  });
}

export async function getCount(id: number) {
  return withTx(async (c) => {
    const head = await c.query(
      `SELECT sc.*, l.name AS location_name, cu.full_name AS created_by_name, au.full_name AS approved_by_name,
              vau.full_name AS void_approved_by_name
       FROM stock_counts sc
       JOIN locations l ON l.id = sc.location_id
       JOIN users cu ON cu.id = sc.created_by
       LEFT JOIN users au ON au.id = sc.approved_by
       LEFT JOIN users vau ON vau.id = sc.void_approved_by
       WHERE sc.id = $1`, [id]
    );
    if (!head.rows[0]) return null;
    const items = await c.query(
      `SELECT si.id, si.product_id, si.system_quantity, si.counted_quantity, si.adjusted,
              p.code, p.name, p.unit, p.min_stock
       FROM stock_count_items si JOIN products p ON p.id = si.product_id
       WHERE si.count_id = $1 ORDER BY p.name`, [id]
    );
    return { ...head.rows[0], items: items.rows };
  });
}

export async function listCounts(opts: { locationId?: number; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.locationId) { params.push(opts.locationId); where.push(`sc.location_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM stock_counts sc ${whereSql}`, params);
  const rows = await query(
    `SELECT sc.id, sc.number, sc.status, sc.location_id, l.name AS location_name,
            sc.created_at, sc.applied_at, cu.full_name AS created_by_name,
            (SELECT COUNT(*) FROM stock_count_items WHERE count_id = sc.id) AS line_count,
            (SELECT COUNT(*) FROM stock_count_items WHERE count_id = sc.id AND counted_quantity IS NOT NULL) AS counted_lines,
            (SELECT COUNT(*) FROM stock_count_items WHERE count_id = sc.id AND adjusted) AS adjusted_lines
     FROM stock_counts sc
     JOIN locations l ON l.id = sc.location_id
     JOIN users cu ON cu.id = sc.created_by
     ${whereSql} ORDER BY sc.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { counts: rows.rows, total: Number(count.rows[0].total) };
}