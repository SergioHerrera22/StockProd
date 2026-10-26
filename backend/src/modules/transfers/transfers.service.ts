import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { applyStockChange } from '../../services/stockEngine';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';
import { assertLocationAccess, assertTransferAccess } from '../../lib/locationGuard';
import { AuthUser } from '../../middleware/auth';
import { 
  reserveStockBatch, 
  consumeReservation, 
  releaseAllReservationsForReference 
} from '../../services/reservation.service';
import { evaluateBusinessRules } from '../../services/businessRules.service';
import { createApprovalRequest } from '../../services/approval.service';
import { createAlert } from '../../services/alerts.service';

export interface TransferDraftInput {
  originLocationId: number;
  destinationLocationId: number;
  notes?: string | null;
  items: { productId: number; quantity: number }[];
}

async function validateTransferItems(c: PoolClient, items: TransferDraftInput['items']) {
  if (!items.length) throw ApiError.badRequest('La transferencia debe tener al menos un producto');
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

/**
 * Crea la transferencia: RESERVA stock en origen y CONSUME (descuenta) atómicamente.
 * La mercaderia queda EN_TRANSITO: no suma al destino hasta recibir.
 * Ahora con: evaluación de reglas, solicitud de aprobación si corresponde, segregación de funciones.
 */
export async function createTransfer(user: AuthUser, ip: string | undefined, input: TransferDraftInput) {
  assertTransferAccess(user, input.originLocationId, input.destinationLocationId);
  return withTx(async (c) => {
    if (input.originLocationId === input.destinationLocationId) {
      throw ApiError.badRequest('El origen y el destino deben ser distintos');
    }
    await validateTransferItems(c, input.items);
    const locs = await c.query<{ id: number; name: string; is_active: boolean }>(
      'SELECT id, name, is_active FROM locations WHERE id = ANY($1)',
      [[input.originLocationId, input.destinationLocationId]]
    );
    if (locs.rows.length !== 2 || locs.rows.some((l) => !l.is_active)) {
      throw ApiError.badRequest('Ubicacion de origen o destino invalida');
    }

    const qtySum = input.items.reduce((s, it) => s + it.quantity, 0);
    const context = { qty_sum: qtySum, location_id: input.originLocationId, user_role: user.role };

    // Evaluar reglas de negocio ANTES de crear
    const rules = await evaluateBusinessRules('TRANSFER', 'BEFORE_CREATE', context);
    const requiresApproval = rules.some(r => r.action.require_approval);
    let status: 'BORRADOR' | 'EN_TRANSITO' = 'EN_TRANSITO';
    let approvalRequestId: number | null = null;

    if (requiresApproval) {
      status = 'BORRADOR';  // Queda en borrador hasta aprobación
    }

    const number = await nextDocNumber(c, 'transfer');
    const t = await c.query<{ id: number }>(
      `INSERT INTO transfers (number, origin_location_id, destination_location_id, notes, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [number, input.originLocationId, input.destinationLocationId, input.notes?.trim() || null, user.id, status]
    );
    const transferId = t.rows[0].id;

    // Insertar items
    for (const it of input.items) {
      await c.query(
        'INSERT INTO transfer_items (transfer_id, product_id, quantity_sent) VALUES ($1,$2,$3)',
        [transferId, it.productId, it.quantity]
      );
    }

    // Si requiere aprobación, crear solicitud y NO reservar/consumir aún
    if (requiresApproval) {
      const rule = rules.find(r => r.action.require_approval)!;
      await createApprovalRequest({
        ruleId: rule.ruleId,
        entityType: 'TRANSFER',
        entityId: transferId,
        entityNumber: number,
        requestedBy: user.id,
        context: { ...context, items: input.items, origin: locs.rows.find(l => l.id === input.originLocationId)?.name, destination: locs.rows.find(l => l.id === input.destinationLocationId)?.name },
      });
      await writeAudit(c, { userId: user.id, action: 'TRANSFER_CREATE_PENDING_APPROVAL', entity: 'transfer', entityId: transferId, details: { number, requiresApproval: true, rules: rules.map(r => r.ruleCode) }, ip });
      return { id: transferId, number, status: 'BORRADOR', requiresApproval: true };
    }

    // ===== RESERVAR + CONSUMIR stock en origen (atómico) =====
    const reservationInputs = input.items.map(it => ({
      referenceType: 'TRANSFER' as const,
      referenceId: transferId,
      productId: it.productId,
      sourceLocationId: input.originLocationId,
      quantity: it.quantity,
      reservedBy: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h para transferencias
    }));

    const reservations = await reserveStockBatch(c, reservationInputs);

    for (let i = 0; i < input.items.length; i++) {
      const it = input.items[i];
      const reservation = reservations[i];
      
      const consumeResult = await consumeReservation(c, {
        reservationId: reservation.reservationId,
        quantity: it.quantity,
        consumedBy: user.id,
        movementType: 'TRANS_SALIDA',
        reason: `Envio a transferencia ${number}`,
      });
      
      if (!consumeResult.success) {
        throw ApiError.conflict(`Error al consumir reserva: ${consumeResult.message}`);
      }
    }

    // Registrar dispatched_by y dispatched_at (quien despacha)
    await c.query(
      `UPDATE transfers SET dispatched_by = $1, dispatched_at = now() WHERE id = $2`,
      [user.id, transferId]
    );

    await writeAudit(c, {
      userId: user.id, action: 'TRANSFER_CREATE', entity: 'transfer', entityId: transferId,
      details: { number, origin: input.originLocationId, destination: input.destinationLocationId, dispatchedBy: user.id }, ip,
    });
    return { id: transferId, number, status: 'EN_TRANSITO', requiresApproval: false };
  });
}

/**
 * Aprobar transferencia en borrador: reserva y consume stock, pasa a EN_TRANSITO
 */
export async function approveTransfer(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    const t = await c.query<{ id: number; number: string; status: string; origin_location_id: number; destination_location_id: number; created_by: number }>(
      'SELECT id, number, status, origin_location_id, destination_location_id, created_by FROM transfers WHERE id = $1 FOR UPDATE', [id]
    );
    const transfer = t.rows[0];
    if (!transfer) throw ApiError.notFound('Transferencia no encontrada');
    if (transfer.status !== 'BORRADOR') throw ApiError.conflict('Solo se pueden aprobar transferencias en borrador');
    assertTransferAccess(user, transfer.origin_location_id, transfer.destination_location_id);

    // Verificar que el aprobador no sea el creador (segregación)
    if (transfer.created_by === user.id) {
      throw ApiError.forbidden('No puedes aprobar tu propia transferencia (segregación de funciones)');
    }

    const items = await c.query<{ product_id: number; quantity: string }>(
      'SELECT product_id, quantity_sent as quantity FROM transfer_items WHERE transfer_id = $1', [id]
    );

    const qtySum = items.rows.reduce((s, it) => s + Number(it.quantity), 0);
    const context = { qty_sum: qtySum, location_id: transfer.origin_location_id, user_role: user.role };

    // Evaluar reglas al momento de aprobar (por si cambiaron)
    const rules = await evaluateBusinessRules('TRANSFER', 'BEFORE_CONFIRM', context);
    const stillRequiresApproval = rules.some(r => r.action.require_approval);
    if (stillRequiresApproval && user.role === 'EMPLEADO') {
      throw ApiError.forbidden('Esta transferencia requiere aprobador con rol ENCARGADO o superior');
    }

    // Reservar y consumir
    const reservationInputs = items.rows.map(it => ({
      referenceType: 'TRANSFER' as const,
      referenceId: transfer.id,
      productId: it.product_id,
      sourceLocationId: transfer.origin_location_id,
      quantity: Number(it.quantity),
      reservedBy: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }));

    const reservations = await reserveStockBatch(c, reservationInputs);

    for (let i = 0; i < items.rows.length; i++) {
      const it = items.rows[i];
      const consumeResult = await consumeReservation(c, {
        reservationId: reservations[i].reservationId,
        quantity: Number(it.quantity),
        consumedBy: user.id,
        movementType: 'TRANS_SALIDA',
        reason: `Envio a transferencia ${transfer.number} (aprobada)`,
      });
      if (!consumeResult.success) {
        throw ApiError.conflict(`Error al consumir reserva: ${consumeResult.message}`);
      }
    }

    await c.query(
      `UPDATE transfers SET status = 'EN_TRANSITO', dispatched_by = $1, dispatched_at = now() WHERE id = $2`,
      [user.id, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'TRANSFER_APPROVE', entity: 'transfer', entityId: id,
      details: { number: transfer.number, approvedBy: user.id }, ip,
    });

    // Resolver solicitud de aprobación si existe
    await c.query(
      `UPDATE approval_requests SET status = 'APROBADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'TRANSFER' AND entity_id = $2 AND status = 'PENDIENTE'`,
      [user.id, id]
    );

    return { ok: true, status: 'EN_TRANSITO' };
  });
}

/**
 * Rechazar transferencia en borrador
 */
export async function rejectTransfer(user: AuthUser, ip: string | undefined, id: number, reason: string) {
  return withTx(async (c) => {
    const t = await c.query<{ id: number; number: string; status: string }>(
      'SELECT id, number, status FROM transfers WHERE id = $1 FOR UPDATE', [id]
    );
    if (!t.rows[0]) throw ApiError.notFound('Transferencia no encontrada');
    if (t.rows[0].status !== 'BORRADOR') throw ApiError.conflict('Solo se pueden rechazar transferencias en borrador');

    await c.query(`UPDATE transfers SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2 WHERE id = $3`, [user.id, `Rechazada: ${reason}`, id]);
    await c.query(`UPDATE approval_requests SET status = 'RECHAZADO', resolved_by = $1, resolved_at = now(), resolution_notes = $2 WHERE entity_type = 'TRANSFER' AND entity_id = $3 AND status = 'PENDIENTE'`, [user.id, reason, id]);
    await writeAudit(c, { userId: user.id, action: 'TRANSFER_REJECT', entity: 'transfer', entityId: id, details: { reason }, ip });
    return { ok: true };
  });
}

export async function receiveTransfer(
  user: AuthUser, ip: string | undefined, id: number,
  items: { itemId: number; quantityReceived: number }[]
) {
  return withTx(async (c) => {
    const t = await c.query<{ id: number; number: string; status: string; destination_location_id: number; origin_location_id: number }>(
      'SELECT id, number, status, destination_location_id, origin_location_id FROM transfers WHERE id = $1 FOR UPDATE',
      [id]
    );
    const transfer = t.rows[0];
    if (!transfer) throw ApiError.notFound('Transferencia no encontrada');
    assertLocationAccess(user, transfer.destination_location_id);
    if (transfer.status !== 'EN_TRANSITO') {
      throw ApiError.conflict(`La transferencia ${transfer.number} ya fue procesada`);
    }

    // Segregación: quien recibe NO puede ser quien despachó
    const dispatched = await c.query<{ dispatched_by: number }>('SELECT dispatched_by FROM transfers WHERE id = $1', [id]);
    if (dispatched.rows[0]?.dispatched_by === user.id) {
      throw ApiError.forbidden('No puedes recibir una transferencia que tú mismo despachaste (segregación de funciones)');
    }

    const dbItems = await c.query<{ id: number; product_id: number; quantity_sent: string }>(
      'SELECT id, product_id, quantity_sent FROM transfer_items WHERE transfer_id = $1', [id]
    );
    const byId = new Map(dbItems.rows.map((i) => [i.id, i]));

    let allComplete = true;
    let anyReceived = false;
    const updates: { itemId: number; qty: number }[] = [];

    // Si el cuerpo repite un itemId, las cantidades se SUMAN: duplicar el
    // elemento con la mitad de las unidades era admitir una segreccion que
    // validaba por item y acababa contabilizando el doble en destino.
    const receivedByItem = new Map<number, number>();
    for (const it of items) {
      const dbItem = byId.get(it.itemId);
      if (!dbItem) throw ApiError.badRequest('Item de transferencia invalido');
      if (!Number.isFinite(it.quantityReceived) || it.quantityReceived < 0) {
        throw ApiError.badRequest('Cantidades recibidas invalidas');
      }
      receivedByItem.set(it.itemId, (receivedByItem.get(it.itemId) ?? 0) + it.quantityReceived);
    }

    for (const [itemId, qty] of receivedByItem) {
      const dbItem = byId.get(itemId)!;
      if (qty > Number(dbItem.quantity_sent)) {
        throw ApiError.conflict(`No se puede recibir mas de lo enviado (${dbItem.quantity_sent})`);
      }
      if (qty > 0) anyReceived = true;
      if (qty !== Number(dbItem.quantity_sent)) allComplete = false;
      updates.push({ itemId, qty });
    }

    for (const dbItem of dbItems.rows) {
      if (!updates.some((u) => u.itemId === dbItem.id)) {
        updates.push({ itemId: dbItem.id, qty: 0 });
        allComplete = false;
      }
    }

    if (!anyReceived) throw ApiError.badRequest('Debes indicar cantidades recibidas para al menos un producto');

    // Orden determinista de lockeo (evita deadlocks con operaciones concurrentes)
    const sortedUpdates = [...updates].sort((a, b) =>
      (byId.get(a.itemId)!.product_id - byId.get(b.itemId)!.product_id));
    for (const u of sortedUpdates) {
      if (u.qty <= 0) continue;
      const dbItem = byId.get(u.itemId)!;
      await applyStockChange(c, {
        productId: dbItem.product_id,
        locationId: transfer.destination_location_id,
        delta: u.qty,
        type: 'TRANS_ENTRADA',
        referenceType: 'TRANSFER',
        referenceId: transfer.id,
        referenceNumber: transfer.number,
        userId: user.id,
        reason: `Recepcion de transferencia ${transfer.number}`,
      });
    }

    for (const u of updates) {
      await c.query('UPDATE transfer_items SET quantity_received = $1 WHERE id = $2', [u.qty, u.itemId]);
    }

    const status = allComplete ? 'RECIBIDO' : 'RECIBIDO_CON_DIF';
    await c.query(
      `UPDATE transfers SET status = $1, received_by = $2, received_at = now() WHERE id = $3`,
      [status, user.id, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'TRANSFER_RECEIVE', entity: 'transfer', entityId: id,
      details: { status, items: updates, receivedBy: user.id }, ip,
    });
    return { ok: true, status };
  });
}

/**
 * Verificar recepción (segunda persona) - opcional, para transferencias críticas
 */
export async function verifyTransferReceipt(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    const t = await c.query<{ id: number; number: string; status: string; received_by: number }>(
      'SELECT id, number, status, received_by FROM transfers WHERE id = $1 FOR UPDATE', [id]
    );
    if (!t.rows[0]) throw ApiError.notFound('Transferencia no encontrada');
    if (!['RECIBIDO', 'RECIBIDO_CON_DIF'].includes(t.rows[0].status)) {
      throw ApiError.conflict('Solo se pueden verificar transferencias recibidas');
    }
    if (t.rows[0].received_by === user.id) {
      throw ApiError.forbidden('No puedes verificar una recepción que tú mismo hiciste (segregación de funciones)');
    }

    await c.query(
      `UPDATE transfers SET verified_by = $1, verified_at = now() WHERE id = $2`,
      [user.id, id]
    );

    await writeAudit(c, { userId: user.id, action: 'TRANSFER_VERIFY', entity: 'transfer', entityId: id, details: { verifiedBy: user.id }, ip });
    return { ok: true };
  });
}

/** Anula una transferencia en transito y devuelve el stock al origen. Libera reservas.
 *  Requiere DOBLE AUTORIZACIÓN: voided_by != void_approved_by (rol >= ENCARGADO)
 */
export async function voidTransfer(user: AuthUser, ip: string | undefined, id: number, reason: string, voidApprovedBy?: number) {
  return withTx(async (c) => {
    const t = await c.query<{ status: string; number: string; origin_location_id: number; destination_location_id: number; void_approved_by: number | null }>(
      'SELECT status, number, origin_location_id, destination_location_id, void_approved_by FROM transfers WHERE id = $1 FOR UPDATE', [id]
    );
    const transfer = t.rows[0];
    if (!transfer) throw ApiError.notFound('Transferencia no encontrada');
    assertLocationAccess(user, transfer.origin_location_id);

    // Si ya estaba recibida, requiere doble autorización. 'CONFIRMADO' no es un
    // estado de transferencia (estados: BORRADOR/EN_TRANSITO/RECIBIDO/
    // RECIBIDO_CON_DIF/ANULADO) y figuraba en la lista por error.
    const requiresDualAuth = ['RECIBIDO', 'RECIBIDO_CON_DIF'].includes(transfer.status);
    if (requiresDualAuth) {
      if (!voidApprovedBy) throw ApiError.badRequest('Anulación de transferencia procesada requiere segundo autorizador (voidApprovedBy)');
      if (voidApprovedBy === user.id) throw ApiError.forbidden('El segundo autorizador debe ser distinto del solicitante');
      // Verificar rol del aprobador
      const approver = await c.query('SELECT role_code FROM users WHERE id = $1', [voidApprovedBy]);
      if (!approver.rows[0] || !['ENCARGADO', 'ADMIN'].includes(approver.rows[0].role_code)) {
        throw ApiError.forbidden('El segundo autorizador debe tener rol ENCARGADO o ADMIN');
      }
    }

    if (transfer.status === 'ANULADO') throw ApiError.conflict('La transferencia ya esta anulada');

    // Evaluar reglas de anulación
    const rules = await evaluateBusinessRules('VOID', 'VOID', { entity_id: id, user_role: user.role });
    const requiresApproval = rules.some(r => r.action.require_approval);
    if (requiresApproval && !voidApprovedBy) {
      throw ApiError.badRequest('Esta anulación requiere aprobación según reglas de negocio');
    }

    // Liberar reservas de la transferencia
    await releaseAllReservationsForReference(c, 'TRANSFER', id, user.id, `Anulación: ${reason}`);

    // Anular una transferencia RECIBIDA debe revertir TODO el movimiento:
    // lo no recibido vuelve a origin, y lo ya recibido sale de destino y
    // vuelve a origin (antes el stock recibido quedaba en destino amparado
    // por un documento ANULADO, sin rastro).
    if (['EN_TRANSITO', 'RECIBIDO', 'RECIBIDO_CON_DIF'].includes(transfer.status)) {
      const items = await c.query<{ product_id: number; quantity_sent: string; quantity_received: string | null }>(
        'SELECT product_id, quantity_sent, quantity_received FROM transfer_items WHERE transfer_id = $1', [id]
      );
      for (const it of items.rows) {
        const sent = Number(it.quantity_sent);
        const received = it.quantity_received ? Number(it.quantity_received) : 0;
        if (received > 0) {
          // Revertir lo ya recibido en destino
          await applyStockChange(c, {
            productId: it.product_id, locationId: transfer.destination_location_id,
            delta: -received,
            type: 'TRANS_SALIDA', referenceType: 'TRANSFER', referenceId: id,
            referenceNumber: transfer.number, userId: user.id,
            reason: `Anulacion de transferencia ${transfer.number}: retiro de lo recibido`,
          });
        }
        if (sent > 0) {
          // Recuperar el total enviado en origen
          await applyStockChange(c, {
            productId: it.product_id, locationId: transfer.origin_location_id,
            delta: sent,
            type: 'TRANS_ENTRADA', referenceType: 'TRANSFER', referenceId: id,
            referenceNumber: transfer.number, userId: user.id,
            reason: `Anulacion de transferencia ${transfer.number}: ${reason}`,
          });
        }
      }
    }

    await c.query(
      `UPDATE transfers SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2, void_approved_by = $3 WHERE id = $4`,
      [user.id, reason, voidApprovedBy ?? null, id]
    );

    // Resolver solicitudes de aprobacion pendientes del documento anulado
    await c.query(
      `UPDATE approval_requests SET status = 'RECHAZADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'TRANSFER' AND entity_id = $2 AND status = 'PENDIENTE'`,
      [user.id, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'TRANSFER_VOID', entity: 'transfer', entityId: id,
      details: { reason, voidApprovedBy, requiresDualAuth }, ip,
    });

    // Alerta si anulación inusual
    if (requiresDualAuth) {
      await createAlert({
        code: 'TRANSFER_VOID_DUAL_AUTH',
        severity: 'WARNING',
        entityType: 'TRANSFER',
        entityId: id,
        title: `Transferencia anulada con doble autorización: ${transfer.number}`,
        message: `Anulada por ${user.fullName}, autorizada por usuario ${voidApprovedBy}. Motivo: ${reason}`,
        data: { transferId: id, voidedBy: user.id, voidApprovedBy, reason },
        targetRoles: ['ADMIN'],
      });
    }

    return { ok: true };
  });
}

export async function getTransfer(id: number) {
  return withTx(async (c) => {
    const head = await c.query(
      `SELECT t.*, lo.name AS origin_name, ld.name AS destination_name,
              cu.full_name AS created_by_name, ru.full_name AS received_by_name,
              du.full_name AS dispatched_by_name, vu.full_name AS verified_by_name,
              vau.full_name AS void_approved_by_name
       FROM transfers t
       JOIN locations lo ON lo.id = t.origin_location_id
       JOIN locations ld ON ld.id = t.destination_location_id
       JOIN users cu ON cu.id = t.created_by
       LEFT JOIN users ru ON ru.id = t.received_by
       LEFT JOIN users du ON du.id = t.dispatched_by
       LEFT JOIN users vu ON vu.id = t.verified_by
       LEFT JOIN users vau ON vau.id = t.void_approved_by
       WHERE t.id = $1`, [id]
    );
    if (!head.rows[0]) return null;
    const items = await c.query(
      `SELECT ti.id, ti.product_id, ti.quantity_sent, ti.quantity_received,
              p.code, p.name, p.unit
       FROM transfer_items ti JOIN products p ON p.id = ti.product_id
       WHERE ti.transfer_id = $1 ORDER BY ti.id`, [id]
    );
    return { ...head.rows[0], items: items.rows };
  });
}

export async function listTransfers(opts: { status?: string; locationId?: number; page: number; pageSize: number; offset: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status) { params.push(opts.status); where.push(`t.status = $${params.length}`); }
  if (opts.locationId) { params.push(opts.locationId); where.push(`(t.origin_location_id = $${params.length} OR t.destination_location_id = $${params.length})`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM transfers t ${whereSql}`, params);
  const rows = await query(
    `SELECT t.id, t.number, t.status, t.origin_location_id, t.destination_location_id,
            lo.name AS origin_name, ld.name AS destination_name,
            t.created_at, t.dispatched_at, t.received_at, t.verified_at,
            cu.full_name AS created_by_name,
            (SELECT COUNT(*) FROM transfer_items WHERE transfer_id = t.id) AS line_count
     FROM transfers t
     JOIN locations lo ON lo.id = t.origin_location_id
     JOIN locations ld ON ld.id = t.destination_location_id
     JOIN users cu ON cu.id = t.created_by
     ${whereSql} ORDER BY t.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { transfers: rows.rows, total: Number(count.rows[0].total) };
}