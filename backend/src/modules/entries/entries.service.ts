import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { applyStockChange } from '../../services/stockEngine';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';
import { assertLocationAccess } from '../../lib/locationGuard';
import { AuthUser } from '../../middleware/auth';

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

    const number = await nextDocNumber(c, 'entry');
    const r = await c.query<{ id: number }>(
      `INSERT INTO stock_entries (number, location_id, type, supplier, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [number, input.locationId, input.type, input.supplier?.trim() || null, input.notes?.trim() || null, user.id]
    );
    const entryId = r.rows[0].id;
    for (const it of input.items) {
      await c.query(
        `INSERT INTO stock_entry_items (entry_id, product_id, quantity, unit_cost) VALUES ($1,$2,$3,$4)`,
        [entryId, it.productId, it.quantity, it.unitCost ?? null]
      );
    }
    if (confirm) await confirmEntryTx(c, entryId, user);
    await writeAudit(c, {
      userId: user.id, action: confirm ? 'ENTRY_CREATE_CONFIRM' : 'ENTRY_CREATE_DRAFT',
      entity: 'entry', entityId: entryId, details: { number }, ip,
    });
    return { id: entryId, number };
  });
}

async function confirmEntryTx(c: PoolClient, id: number, user: AuthUser) {
  const e = await c.query<{ id: number; number: string; status: string; location_id: number }>(
    'SELECT id, number, status, location_id FROM stock_entries WHERE id = $1 FOR UPDATE', [id]
  );
  const entry = e.rows[0];
  if (!entry) throw ApiError.notFound('Entrada no encontrada');
  assertLocationAccess(user, entry.location_id);
  if (entry.status === 'CONFIRMADO') throw ApiError.conflict(`La entrada ${entry.number} ya fue confirmada`);
  if (entry.status === 'ANULADO') throw ApiError.conflict('La entrada esta anulada');

  const items = await c.query<{ product_id: number; quantity: string; unit_cost: string | null }>(
    'SELECT product_id, quantity, unit_cost FROM stock_entry_items WHERE entry_id = $1', [id]
  );
  if (!items.rows.length) throw ApiError.badRequest('La entrada no tiene productos');

  for (const it of items.rows) {
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
    `UPDATE stock_entries SET status = 'CONFIRMADO', confirmed_by = $1, confirmed_at = now() WHERE id = $2`,
    [user.id, id]
  );
}

export async function confirmEntry(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    await confirmEntryTx(c, id, user);
    await writeAudit(c, { userId: user.id, action: 'ENTRY_CONFIRM', entity: 'entry', entityId: id, ip });
    return { ok: true };
  });
}

export async function voidEntry(user: AuthUser, ip: string | undefined, id: number, reason: string) {
  return withTx(async (c) => {
    const e = await c.query<{ status: string; number: string; location_id: number }>(
      'SELECT status, number, location_id FROM stock_entries WHERE id = $1 FOR UPDATE', [id]
    );
    const entry = e.rows[0];
    if (!entry) throw ApiError.notFound('Entrada no encontrada');
    assertLocationAccess(user, entry.location_id);
    if (entry.status === 'ANULADO') throw ApiError.conflict('La entrada ya esta anulada');

    if (entry.status === 'CONFIRMADO') {
      const items = await c.query<{ product_id: number; quantity: string }>(
        'SELECT product_id, quantity FROM stock_entry_items WHERE entry_id = $1', [id]
      );
      for (const it of items.rows) {
        await applyStockChange(c, {
          productId: it.product_id, locationId: entry.location_id, delta: -Number(it.quantity),
          type: 'SALIDA', referenceType: 'ENTRY', referenceId: id, referenceNumber: entry.number,
          userId: user.id, reason: `Anulacion de entrada ${entry.number}: ${reason}`,
        });
      }
    }
    await c.query(
      `UPDATE stock_entries SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2 WHERE id = $3`,
      [user.id, reason, id]
    );
    await writeAudit(c, {
      userId: user.id, action: 'ENTRY_VOID', entity: 'entry', entityId: id, details: { reason }, ip,
    });
    return { ok: true };
  });
}

export async function getEntry(id: number) {
  return withTx(async (c) => {
    const head = await c.query(
      `SELECT e.*, l.name AS location_name, cu.full_name AS created_by_name
       FROM stock_entries e
       JOIN locations l ON l.id = e.location_id
       JOIN users cu ON cu.id = e.created_by
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
            e.created_at, e.confirmed_at, cu.full_name AS created_by_name,
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
