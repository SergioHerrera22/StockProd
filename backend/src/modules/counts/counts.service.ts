import { PoolClient } from 'pg';
import { pool, query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { applyStockChange } from '../../services/stockEngine';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';
import { assertLocationAccess } from '../../lib/locationGuard';
import { AuthUser } from '../../middleware/auth';
import { evaluateBusinessRules } from '../../services/businessRules.service';
import { createApprovalRequest } from '../../services/approval.service';
import { createAlert } from '../../services/alerts.service';
import { createSnapshotInTx } from '../../services/snapshot.service';
import { getConfirmationSetting } from '../../services/confirmationSettings.service';

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
    await createSnapshotInTx(c, user, ip, locationId, 'PRE_COUNT', undefined, undefined);

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

    if (items.some((it) => !Number.isFinite(it.countedQuantity) || it.countedQuantity < 0)) {
      throw ApiError.badRequest('Las cantidades contadas deben ser cero o mayores');
    }
    // UPDATE multi-row con unnest: 1 query en vez de N
    const r = await c.query(
      `UPDATE stock_count_items sci SET counted_quantity = v.qty
       FROM unnest($2::int[], $3::numeric[]) AS v(iid, qty)
       WHERE sci.id = v.iid AND sci.count_id = $1`,
      [id, items.map((it) => it.itemId), items.map((it) => it.countedQuantity)]
    );
    if (r.rowCount !== items.length) throw ApiError.badRequest('Item de inventario invalido');
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
  return withTx((c) => applyCountTx(c, user, ip, id, reason));
}

/**
 * Logica central de aplicacion de inventario. Recibe el cliente de la
 * transaccion para poder ser invocada desde approveCount SIN abrir una
 * segunda transaccion (antes abria withTx propia dentro de la tx de
 * aprobacion que retenia el lock de la misma fila -> deadlock seguro).
 */
async function applyCountTx(c: PoolClient, user: AuthUser, ip: string | undefined, id: number, reason: string) {
  const head = await c.query<{ status: string; number: string; location_id: number; created_by: number; created_at: Date }>(
    'SELECT status, number, location_id, created_by, created_at FROM stock_counts WHERE id = $1 FOR UPDATE', [id]
  );
  const count = head.rows[0];
  if (!count) throw ApiError.notFound('Inventario no encontrado');
  assertLocationAccess(user, count.location_id);
  if (count.status !== 'ABIERTO') throw ApiError.conflict('El inventario ya fue procesado');
  if (!reason || reason.trim().length < 5) throw ApiError.badRequest('El motivo del ajuste es obligatorio');

  // Segregación: quien aplica NO debe ser quien creó (configurable)
  const cfgApply = await getConfirmationSetting(c, 'COUNT', 'APPLY');
  if (cfgApply?.enabled && cfgApply.require_different_user && !cfgApply.allow_same_user) {
    if (count.created_by === user.id) {
      throw ApiError.forbidden('No puedes aplicar un inventario que tú mismo creaste (segregación de funciones)');
    }
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
    }, c);
    await writeAudit(c, { userId: user.id, action: 'COUNT_APPLY_PENDING_APPROVAL', entity: 'count', entityId: id, details: { reason, adjustments: adjustmentsCount, requiresApproval: true }, ip });
    return { ok: false, requiresApproval: true, adjustments: adjustmentsCount };
  }

  // El conteo compara contra el SNAPSHOT tomado al crear (system_quantity).
  // Basar el ajuste en el saldo actual revertiria en silencio ventas/movimientos
  // posteriores. Si hubo movimientos despues del snapshot, ese item se
  // detecta como conflicto (el stock fisico puede haber cambiado): no se
  // ajusta automaticamente, se reporta para volver a contar.
  const moved = await c.query<{ product_id: number }>(
    `SELECT DISTINCT m.product_id
     FROM stock_movements m
     WHERE m.location_id = $1 AND m.reference_type <> 'COUNT'
       AND m.created_at > $2
       AND m.product_id IN (SELECT product_id FROM stock_count_items WHERE count_id = $3 AND counted_quantity IS NOT NULL)`,
    [count.location_id, count.created_at, id]
  );
  const movedSet = new Set(moved.rows.map(r => r.product_id));

  // Reservas activas: si hay stock comprometido para un producto contado en
  // esta ubicacion, ajustar por arriba dejaria un respaldo fantasma y por
  // abajo revienta el CHECK reserved_quantity <= quantity. Se reporta y el
  // usuario debe consumir/cancelar esas reservas antes de aplicar.
  const reservedRows = await c.query<{ product_id: number }>(
    `SELECT DISTINCT sb.product_id
     FROM stock_balances sb
     JOIN stock_reservations r ON r.product_id = sb.product_id AND r.source_location_id = sb.location_id
     WHERE sb.location_id = $1
       AND sb.reserved_quantity > 0
       AND r.status IN ('ACTIVA', 'PARCIAL')
       AND sb.product_id IN (SELECT product_id FROM stock_count_items WHERE count_id = $2 AND counted_quantity IS NOT NULL)`,
    [count.location_id, id]
  );
  const reservedSet = new Set(reservedRows.rows.map(r => r.product_id));

  const conflictProducts = new Set<number>([...movedSet, ...reservedSet]);
  if (conflictProducts.size > 0) {
    const names = await c.query<{ id: number; code: string; name: string }>(
      'SELECT id, code, name FROM products WHERE id = ANY($1)', [[...conflictProducts]]
    );
    await writeAudit(c, { userId: user.id, action: 'COUNT_APPLY_BLOCKED', entity: 'count', entityId: id, details: { reason: 'movimientos posteriores o reservas activas', products: names.rows }, ip });
    throw ApiError.conflict(
      `El inventario no se puede aplicar: hubo movimientos de stock o hay reservas activas desde que se creó ` +
      `para: ${names.rows.map(p => `${p.code} — ${p.name}`).join(', ')}. ` +
      `Recontá esos productos o liberá las reservas (consumir órdenes de retiro) y volvé a intentar.`
    );
  }

  // Orden determinista de lockeo (evita deadlocks con operaciones concurrentes)
  let appliedAdjustments = 0;
  const sortedRows = [...items.rows].sort((a, b) => a.product_id - b.product_id);
  for (const it of sortedRows) {
    if (it.counted_quantity === null) continue; // no contado: no se ajusta
    const bal = await c.query<{ quantity: string }>(
      `SELECT COALESCE(quantity, 0) AS quantity FROM stock_balances
       WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
      [it.product_id, count.location_id]
    );
    // applyStockChange asegura la existencia de la fila y su lock si no existe.
    const cur = Number(bal.rows[0]?.quantity ?? 0);

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
  await createSnapshotInTx(c, user, ip, count.location_id, 'POST_COUNT', id, 'COUNT');

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
    assertLocationAccess(user, head.rows[0].location_id);
    const cfgApp = await getConfirmationSetting(c, 'COUNT', 'APPROVE');
    if (cfgApp?.enabled && cfgApp.require_different_user && !cfgApp.allow_same_user) {
      if (head.rows[0].created_by === user.id) throw ApiError.forbidden('No puedes aprobar un inventario que tú mismo creaste (segregación de funciones)');
    }
    // Comparte la MISMA transaccion: la fila del conteo ya esta bloqueada aqui.
    const result = await applyCountTx(c, user, ip, id, reason);
    await writeAudit(c, { userId: user.id, action: 'COUNT_APPROVE', entity: 'count', entityId: id, details: { reason }, ip });
    return result;
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
  // Lectura pura: sin transaccion (antes withTx = BEGIN/COMMIT de regalo)
  const c = await pool.connect();
  try {
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
  } finally {
    c.release();
  }
}

export async function listCounts(opts: { locationId?: number; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.locationId) { params.push(opts.locationId); where.push(`sc.location_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Un solo round-trip: el total viene en cada fila con COUNT(*) OVER()
  const rows = await query<{ total?: string }>(
    `SELECT sc.id, sc.number, sc.status, sc.location_id, l.name AS location_name,
            sc.created_at, sc.applied_at, cu.full_name AS created_by_name,
            (SELECT COUNT(*) FROM stock_count_items WHERE count_id = sc.id) AS line_count,
            (SELECT COUNT(*) FROM stock_count_items WHERE count_id = sc.id AND counted_quantity IS NOT NULL) AS counted_lines,
            (SELECT COUNT(*) FROM stock_count_items WHERE count_id = sc.id AND adjusted) AS adjusted_lines,
            COUNT(*) OVER() AS total
     FROM stock_counts sc
     JOIN locations l ON l.id = sc.location_id
     JOIN users cu ON cu.id = sc.created_by
     ${whereSql} ORDER BY sc.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  const total = rows.rows.length > 0 && rows.rows[0].total != null ? Number(rows.rows[0].total) : 0;
  return { counts: rows.rows.map(({ total: _t, ...rest }) => rest) as never[], total };
}