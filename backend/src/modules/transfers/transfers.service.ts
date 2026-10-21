import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { applyStockChange } from '../../services/stockEngine';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';
import { assertLocationAccess, assertTransferAccess } from '../../lib/locationGuard';
import { AuthUser } from '../../middleware/auth';

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
 * Crea la transferencia y SALIDA del stock del origen en la misma transaccion.
 * La mercaderia queda EN_TRANSITO: no suma al destino hasta recibir.
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

    const number = await nextDocNumber(c, 'transfer');
    const t = await c.query<{ id: number }>(
      `INSERT INTO transfers (number, origin_location_id, destination_location_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [number, input.originLocationId, input.destinationLocationId, input.notes?.trim() || null, user.id]
    );
    const transferId = t.rows[0].id;

    for (const it of input.items) {
      await c.query(
        'INSERT INTO transfer_items (transfer_id, product_id, quantity_sent) VALUES ($1,$2,$3)',
        [transferId, it.productId, it.quantity]
      );
      await applyStockChange(c, {
        productId: it.productId,
        locationId: input.originLocationId,
        delta: -Number(it.quantity),
        type: 'TRANS_SALIDA',
        referenceType: 'TRANSFER',
        referenceId: transferId,
        referenceNumber: number,
        userId: user.id,
        reason: `Envio a transferencia ${number}`,
      });
    }

    await writeAudit(c, {
      userId: user.id, action: 'TRANSFER_CREATE', entity: 'transfer', entityId: transferId,
      details: { number, origin: input.originLocationId, destination: input.destinationLocationId }, ip,
    });
    return { id: transferId, number };
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

    const dbItems = await c.query<{ id: number; product_id: number; quantity_sent: string }>(
      'SELECT id, product_id, quantity_sent FROM transfer_items WHERE transfer_id = $1', [id]
    );
    const byId = new Map(dbItems.rows.map((i) => [i.id, i]));

    let allComplete = true;
    let anyReceived = false;
    const updates: { itemId: number; qty: number }[] = [];

    for (const it of items) {
      const dbItem = byId.get(it.itemId);
      if (!dbItem) throw ApiError.badRequest('Item de transferencia invalido');
      if (!Number.isFinite(it.quantityReceived) || it.quantityReceived < 0) {
        throw ApiError.badRequest('Cantidades recibidas invalidas');
      }
      if (it.quantityReceived > Number(dbItem.quantity_sent)) {
        throw ApiError.conflict(`No se puede recibir mas de lo enviado (${dbItem.quantity_sent})`);
      }
      if (it.quantityReceived > 0) anyReceived = true;
      if (it.quantityReceived !== Number(dbItem.quantity_sent)) allComplete = false;
      updates.push({ itemId: it.itemId, qty: it.quantityReceived });
    }

    // Los items no informados se reciben en 0 (diferencia documentada)
    for (const dbItem of dbItems.rows) {
      if (!updates.some((u) => u.itemId === dbItem.id)) {
        updates.push({ itemId: dbItem.id, qty: 0 });
        allComplete = false;
      }
    }

    if (!anyReceived) throw ApiError.badRequest('Debes indicar cantidades recibidas para al menos un producto');

    for (const u of updates) {
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
      'UPDATE transfers SET status = $1, received_by = $2, received_at = now() WHERE id = $3',
      [status, user.id, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'TRANSFER_RECEIVE', entity: 'transfer', entityId: id,
      details: { status, items: updates }, ip,
    });
    return { ok: true, status };
  });
}

/** Anula una transferencia en transito y devuelve el stock al origen. */
export async function voidTransfer(user: AuthUser, ip: string | undefined, id: number, reason: string) {
  return withTx(async (c) => {
    const t = await c.query<{ status: string; number: string; origin_location_id: number }>(
      'SELECT status, number, origin_location_id FROM transfers WHERE id = $1 FOR UPDATE', [id]
    );
    const transfer = t.rows[0];
    if (!transfer) throw ApiError.notFound('Transferencia no encontrada');
    assertLocationAccess(user, transfer.origin_location_id);
    if (transfer.status !== 'EN_TRANSITO') {
      throw ApiError.conflict('Solo se pueden anular transferencias en transito');
    }
    const items = await c.query<{ product_id: number; quantity_sent: string }>(
      'SELECT product_id, quantity_sent FROM transfer_items WHERE transfer_id = $1', [id]
    );
    for (const it of items.rows) {
      await applyStockChange(c, {
        productId: it.product_id, locationId: transfer.origin_location_id,
        delta: Number(it.quantity_sent),
        type: 'TRANS_ENTRADA', referenceType: 'TRANSFER', referenceId: id,
        referenceNumber: transfer.number, userId: user.id,
        reason: `Anulacion de transferencia ${transfer.number}: ${reason}`,
      });
    }
    await c.query(
      `UPDATE transfers SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2 WHERE id = $3`,
      [user.id, reason, id]
    );
    await writeAudit(c, {
      userId: user.id, action: 'TRANSFER_VOID', entity: 'transfer', entityId: id, details: { reason }, ip,
    });
    return { ok: true };
  });
}

export async function getTransfer(id: number) {
  return withTx(async (c) => {
    const head = await c.query(
      `SELECT t.*, lo.name AS origin_name, ld.name AS destination_name,
              cu.full_name AS created_by_name, ru.full_name AS received_by_name
       FROM transfers t
       JOIN locations lo ON lo.id = t.origin_location_id
       JOIN locations ld ON ld.id = t.destination_location_id
       JOIN users cu ON cu.id = t.created_by
       LEFT JOIN users ru ON ru.id = t.received_by
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
            t.created_at, t.received_at, cu.full_name AS created_by_name,
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
