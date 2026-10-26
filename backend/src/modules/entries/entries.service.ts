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
import { notifyStockArrivalForEntryId } from '../../services/arrivalAlerts.service';

export interface EntryDraftInput {
  locationId: number;
  type: string;
  supplier?: string | null;
  notes?: string | null;
  items: { productId: number; quantity: number; unitCost?: number | null }[];
}

const ENTRY_TYPES = ['COMPRA', 'DEVOLUCION', 'OTRO'];

async function validateEntryItems(c: PoolClient, items: EntryDraftInput['items']) {
  if (!items.length) throw ApiError.badRequest('La entrada debe tener al menos un producto');
  const ids = items.map((i) => i.productId);
  const r = await c.query<{ id: number; name: string; is_active: boolean }>(
    'SELECT id, name, is_active FROM products WHERE id = ANY($1)', [ids]
  );
  const map = new Map(r.rows.map((p) => [p.id, p]));
  for (const it of items) {
    if (!Number.isFinite(it.quantity) || it.quantity <= 0) {
      throw ApiError.badRequest('Todas las cantidades deben ser mayores a cero');
    }
    const p = map.get(it.productId);
    if (!p) throw ApiError.badRequest(`Producto inexistente (id ${it.productId})`);
    if (!p.is_active) throw ApiError.badRequest(`El producto "${p.name}" esta inactivo`);
  }
}

export async function createEntry(user: AuthUser, ip: string | undefined, input: EntryDraftInput, confirm: boolean) {
  assertLocationAccess(user, input.locationId);
  return withTx(async (c) => {
    if (!ENTRY_TYPES.includes(input.type)) throw ApiError.badRequest('Tipo de entrada invalido');
    await validateEntryItems(c, input.items);
    const loc = await c.query('SELECT id FROM locations WHERE id = $1 AND is_active', [input.locationId]);
    if (!loc.rows[0]) throw ApiError.badRequest('Ubicacion de destino invalida');

    const qtySum = input.items.reduce((s, it) => s + it.quantity, 0);
    const context = { qty_sum: qtySum, location_id: input.locationId, user_role: user.role };

    // Evaluar reglas ANTES de crear
    const rules = await evaluateBusinessRules('ENTRY', 'BEFORE_CREATE', context);
    const requiresApproval = rules.some(r => r.action.require_approval);
    let status: 'BORRADOR' | 'CONFIRMADO' = 'BORRADOR';

    const number = await nextDocNumber(c, 'entry');
    const r = await c.query<{ id: number }>(
      `INSERT INTO stock_entries (number, location_id, type, supplier, notes, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [number, input.locationId, input.type, input.supplier?.trim() || null, input.notes?.trim() || null, user.id, status]
    );
    const entryId = r.rows[0].id;
    for (const it of input.items) {
      await c.query(
        `INSERT INTO stock_entry_items (entry_id, product_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)`,
        [entryId, it.productId, it.quantity, it.unitCost ?? null]
      );
    }

    if (requiresApproval) {
      const rule = rules.find(r => r.action.require_approval)!;
      await createApprovalRequest({
        ruleId: rule.ruleId,
        entityType: 'ENTRY',
        entityId: entryId,
        entityNumber: number,
        requestedBy: user.id,
        context: { ...context, items: input.items },
      });
      await writeAudit(c, { userId: user.id, action: 'ENTRY_CREATE_PENDING_APPROVAL', entity: 'entry', entityId: entryId, details: { number, requiresApproval: true }, ip });
      return { id: entryId, number, status: 'BORRADOR', requiresApproval: true };
    }

    if (confirm) {
      await confirmEntryTx(c, entryId, user, { skipSegregation: true });
    } else {
      await writeAudit(c, { userId: user.id, action: 'ENTRY_CREATE_DRAFT', entity: 'entry', entityId: entryId, details: { number }, ip });
    }
    return { id: entryId, number, status: confirm ? 'CONFIRMADO' : 'BORRADOR', requiresApproval: false };
  }).then(async (r) => {
    // Mejora 9: el ?confirm=true también mete stock real: misma alerta de llegada.
    if (r.status === 'CONFIRMADO') void notifyStockArrivalForEntryId(r.id);
    return r;
  });
}

async function confirmEntryTx(c: PoolClient, id: number, user: AuthUser, opts?: { skipSegregation?: boolean }) {
  const e = await c.query<{ id: number; number: string; status: string; location_id: number; created_by: number }>(
    'SELECT id, number, status, location_id, created_by FROM stock_entries WHERE id = $1 FOR UPDATE', [id]
  );
  const entry = e.rows[0];
  if (!entry) throw ApiError.notFound('Entrada no encontrada');
  assertLocationAccess(user, entry.location_id);
  if (entry.status === 'CONFIRMADO') throw ApiError.conflict(`La entrada ${entry.number} ya fue confirmada`);
  if (entry.status === 'ANULADO') throw ApiError.conflict('La entrada esta anulada');

  // Segregación: quien confirma NO debe ser quien creó. Se omite SOLO cuando
  // la confirmacion sucede dentro del propio alta (?confirm=true): exigirla
  // ahi bloqueaba el flujo para siempre (el creador no puede confirmar su
  // propia creacion). Para POST /:id/confirm sigue aplicando.
  if (!opts?.skipSegregation && entry.created_by === user.id) {
    throw ApiError.forbidden('No puedes confirmar una entrada que tú mismo creaste (segregación de funciones)');
  }

  // Evaluar reglas al confirmar
  const itemsPreview = await c.query<{ product_id: number; quantity: string }>(
    'SELECT product_id, quantity FROM stock_entry_items WHERE entry_id = $1', [id]
  );
  const qtySum = itemsPreview.rows.reduce((s, it) => s + Number(it.quantity), 0);
  const context = { qty_sum: qtySum, location_id: entry.location_id, user_role: user.role };
  const rules = await evaluateBusinessRules('ENTRY', 'BEFORE_CONFIRM', context);
  const stillRequiresApproval = rules.some(r => r.action.require_approval);
  if (stillRequiresApproval && user.role === 'EMPLEADO') {
    throw ApiError.forbidden('Esta entrada requiere aprobador con rol ENCARGADO o superior');
  }

  const items = await c.query<{ product_id: number; quantity: string; unit_cost: string | null }>(
    'SELECT product_id, quantity, unit_cost FROM stock_entry_items WHERE entry_id = $1', [id]
  );
  if (!items.rows.length) throw ApiError.badRequest('La entrada no tiene productos');

  // Orden determinista de lockeo (evita deadlocks con operaciones concurrentes)
  const sortedItems = [...items.rows].sort((a, b) => a.product_id - b.product_id);
  for (const it of sortedItems) {
    await applyStockChange(c, {
      productId: it.product_id,
      locationId: entry.location_id,
      delta: Number(it.quantity),
      type: 'ENTRADA',
      referenceType: 'ENTRY',
      referenceId: entry.id,
      referenceNumber: entry.number,
      userId: user.id,
      reason: `Ingreso de mercaderia ${entry.number}`,
      notes: it.unit_cost ? `Costo unitario: ${it.unit_cost}` : undefined,
    });
    if (it.unit_cost) {
      await c.query('UPDATE products SET cost = $1 WHERE id = $2 AND (cost IS NULL OR cost = 0)', [it.unit_cost, it.product_id]);
    }
  }

  await c.query(
    `UPDATE stock_entries SET status = 'CONFIRMADO', confirmed_by = $1, confirmed_at = now(), received_by = $2, received_at = now() WHERE id = $3`,
    [user.id, user.id, id]
  );

  // Resolver aprobación si existía
  await c.query(
    `UPDATE approval_requests SET status = 'APROBADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'ENTRY' AND entity_id = $2 AND status = 'PENDIENTE'`,
    [user.id, id]
  );
}

export async function confirmEntry(user: AuthUser, ip: string | undefined, id: number) {
  const result = await withTx(async (c) => {
    await confirmEntryTx(c, id, user);
    await writeAudit(c, { userId: user.id, action: 'ENTRY_CONFIRM', entity: 'entry', entityId: id, ip });
    return { ok: true };
  });
  // Mejora 9: llegada de mercadería que cubre deuda sin derivar -> alerta con
  // clic directo. POST-COMMIT y no bloquea: si falla queda solo en el log.
  void notifyStockArrivalForEntryId(id);
  return result;
}

/**
 * Aprobar entrada en borrador (para flujo con aprobación)
 */
export async function approveEntry(user: AuthUser, ip: string | undefined, id: number) {
  const result = await withTx(async (c) => {
    const e = await c.query<{ id: number; number: string; status: string; location_id: number; created_by: number }>(
      'SELECT id, number, status, location_id, created_by FROM stock_entries WHERE id = $1 FOR UPDATE', [id]
    );
    if (!e.rows[0]) throw ApiError.notFound('Entrada no encontrada');
    if (e.rows[0].status !== 'BORRADOR') throw ApiError.conflict('Solo se pueden aprobar entradas en borrador');
    if (e.rows[0].created_by === user.id) throw ApiError.forbidden('No puedes aprobar tu propia entrada (segregación de funciones)');
    assertLocationAccess(user, e.rows[0].location_id);
    await confirmEntryTx(c, id, user);
    return { ok: true };
  });
  // Mejora 9: igual que confirmEntry, la entrada aprobada también llega a stock.
  void notifyStockArrivalForEntryId(id);
  return result;
}

/**
 * Anulacion con DOBLE AUTORIZACION para entradas confirmadas
 */
export async function voidEntry(user: AuthUser, ip: string | undefined, id: number, reason: string, voidApprovedBy?: number) {
  return withTx(async (c) => {
    const e = await c.query<{ status: string; number: string; location_id: number; void_approved_by: number | null }>(
      'SELECT status, number, location_id, void_approved_by FROM stock_entries WHERE id = $1 FOR UPDATE', [id]
    );
    const entry = e.rows[0];
    if (!entry) throw ApiError.notFound('Entrada no encontrada');
    assertLocationAccess(user, entry.location_id);
    if (entry.status === 'ANULADO') throw ApiError.conflict('La entrada ya esta anulada');

    const requiresDualAuth = entry.status === 'CONFIRMADO';
    if (requiresDualAuth) {
      if (!voidApprovedBy) throw ApiError.badRequest('Anulación de entrada confirmada requiere segundo autorizador (voidApprovedBy)');
      if (voidApprovedBy === user.id) throw ApiError.forbidden('El segundo autorizador debe ser distinto del solicitante');
      const approver = await c.query('SELECT role_code FROM users WHERE id = $1', [voidApprovedBy]);
      if (!approver.rows[0] || !['ENCARGADO', 'ADMIN'].includes(approver.rows[0].role_code)) {
        throw ApiError.forbidden('El segundo autorizador debe tener rol ENCARGADO o ADMIN');
      }
    }

    // Evaluar reglas
    const rules = await evaluateBusinessRules('VOID', 'VOID', { entity_id: id, user_role: user.role });
    const requiresApproval = rules.some(r => r.action.require_approval);
    if (requiresApproval && !voidApprovedBy) {
      throw ApiError.badRequest('Esta anulación requiere aprobación según reglas de negocio');
    }

    if (entry.status === 'CONFIRMADO') {
      const items = await c.query<{ product_id: number; quantity: string }>(
        'SELECT product_id, quantity FROM stock_entry_items WHERE entry_id = $1', [id]
      );
      // Orden determinista de lockeo
      const sorted = [...items.rows].sort((a, b) => a.product_id - b.product_id);
      for (const it of sorted) {
        await applyStockChange(c, {
          productId: it.product_id, locationId: entry.location_id, delta: -Number(it.quantity),
          type: 'SALIDA', referenceType: 'ENTRY', referenceId: id, referenceNumber: entry.number,
          userId: user.id, reason: `Anulacion de entrada ${entry.number}: ${reason}`,
        });
      }
    }

    await c.query(
      `UPDATE stock_entries SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2, void_approved_by = $3 WHERE id = $4`,
      [user.id, reason, voidApprovedBy ?? null, id]
    );

    // Si el borrador tenia una solicitud de aprobacion pendiente (se genero al
    // crear bajo reglas), dejarla PENDIENTE para siempre ensuciaba el modulo
    // de aprobaciones: se marca rechazada al anular el documento.
    await c.query(
      `UPDATE approval_requests SET status = 'RECHAZADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'ENTRY' AND entity_id = $2 AND status = 'PENDIENTE'`,
      [user.id, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'ENTRY_VOID', entity: 'entry', entityId: id,
      details: { reason, voidApprovedBy, requiresDualAuth, wasConfirmed: requiresDualAuth }, ip,
    });

    if (requiresDualAuth) {
      await createAlert({
        code: 'ENTRY_VOID_DUAL_AUTH',
        severity: 'WARNING',
        entityType: 'ENTRY',
        entityId: id,
        title: `Entrada anulada con doble autorización: ${entry.number}`,
        message: `Anulada por ${user.fullName}, autorizada por usuario ${voidApprovedBy}. Motivo: ${reason}`,
        data: { entryId: id, voidedBy: user.id, voidApprovedBy, reason },
        targetRoles: ['ADMIN'],
      });
    }

    return { ok: true };
  });
}

export async function getEntry(id: number) {
  return withTx(async (c) => {
    const head = await c.query(
      `SELECT e.*, l.name AS location_name, cu.full_name AS created_by_name,
              confu.full_name AS confirmed_by_name, recu.full_name AS received_by_name,
              vau.full_name AS void_approved_by_name
       FROM stock_entries e
       JOIN locations l ON l.id = e.location_id
       JOIN users cu ON cu.id = e.created_by
       LEFT JOIN users confu ON confu.id = e.confirmed_by
       LEFT JOIN users recu ON recu.id = e.received_by
       LEFT JOIN users vau ON vau.id = e.void_approved_by
       WHERE e.id = $1`, [id]
    );
    if (!head.rows[0]) return null;
    const items = await c.query(
      `SELECT ei.id, ei.product_id, ei.quantity, ei.unit_cost, p.code, p.name, p.unit
       FROM stock_entry_items ei JOIN products p ON p.id = ei.product_id
       WHERE ei.entry_id = $1 ORDER BY ei.id`, [id]
    );
    return { ...head.rows[0], items: items.rows };
  });
}

export async function listEntries(opts: { status?: string; locationId?: number; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status) { params.push(opts.status); where.push(`e.status = $${params.length}`); }
  if (opts.locationId) { params.push(opts.locationId); where.push(`e.location_id = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM stock_entries e ${whereSql}`, params);
  const rows = await query(
    `SELECT e.id, e.number, e.status, e.type, e.supplier, e.location_id, l.name AS location_name,
            e.created_at, e.confirmed_at, e.received_at, cu.full_name AS created_by_name,
            (SELECT COUNT(*) FROM stock_entry_items WHERE entry_id = e.id) AS line_count
     FROM stock_entries e
     JOIN locations l ON l.id = e.location_id
     JOIN users cu ON cu.id = e.created_by
     ${whereSql} ORDER BY e.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { entries: rows.rows, total: Number(count.rows[0].total) };
}