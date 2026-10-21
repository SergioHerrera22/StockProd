import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { applyStockChange } from '../../services/stockEngine';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';
import { assertLocationAccess } from '../../lib/locationGuard';
import { AuthUser } from '../../middleware/auth';

export interface DeliveryItemInput {
  productId: number;
  quantity: number;
  requestedQuantity?: number | null;
}

export interface DeliveryDraftInput {
  locationId: number;
  invoiceNumber?: string | null;
  notes?: string | null;
  items: DeliveryItemInput[];
}

async function validateItems(c: PoolClient, items: DeliveryItemInput[]) {
  if (!items.length) throw ApiError.badRequest('La entrega debe tener al menos un producto');
  for (const it of items) {
    if (!Number.isFinite(it.quantity) || it.quantity <= 0) {
      throw ApiError.badRequest('Todas las cantidades deben ser mayores a cero');
    }
    if (it.requestedQuantity !== undefined && it.requestedQuantity !== null && it.requestedQuantity < 0) {
      throw ApiError.badRequest('La cantidad facturada no puede ser negativa');
    }
  }
  const ids = items.map((i) => i.productId);
  const r = await c.query<{ id: number; name: string; is_active: boolean }>(
    `SELECT id, name, is_active FROM products WHERE id = ANY($1)`,
    [ids]
  );
  const map = new Map(r.rows.map((p) => [p.id, p]));
  for (const it of items) {
    const p = map.get(it.productId);
    if (!p) throw ApiError.badRequest(`Producto inexistente (id ${it.productId})`);
    if (!p.is_active) throw ApiError.badRequest(`El producto "${p.name}" esta inactivo`);
  }
  // Sin duplicados (UNIQUE en BD tambien protege)
  const seen = new Set<number>();
  for (const it of items) {
    if (seen.has(it.productId)) throw ApiError.badRequest('Hay productos duplicados en la lista');
    seen.add(it.productId);
  }
}

async function loadDelivery(client: PoolClient, id: number) {
  const head = await client.query(
    `SELECT d.*, l.name AS location_name, l.code AS location_code,
            cu.full_name AS created_by_name, vu.full_name AS confirmed_by_name
     FROM deliveries d
     JOIN locations l ON l.id = d.location_id
     JOIN users cu ON cu.id = d.created_by
     LEFT JOIN users vu ON vu.id = d.confirmed_by
     WHERE d.id = $1`,
    [id]
  );
  if (!head.rows[0]) return null;
  const items = await client.query(
    `SELECT di.id, di.product_id, di.quantity, di.requested_quantity,
            p.code, p.name, p.unit, p.brand, p.min_stock,
            COALESCE(sb.quantity, 0) AS stock_now
     FROM delivery_items di
     JOIN products p ON p.id = di.product_id
     LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.location_id = $2
     WHERE di.delivery_id = $1
     ORDER BY di.id`,
    [id, (head.rows[0] as { location_id: number }).location_id]
  );
  return { ...head.rows[0], items: items.rows };
}

export async function createDelivery(user: AuthUser, ip: string | undefined, input: DeliveryDraftInput, confirm: boolean) {
  assertLocationAccess(user, input.locationId);
  return withTx(async (c) => {
    await validateItems(c, input.items);
    const loc = await c.query('SELECT id FROM locations WHERE id = $1 AND is_active', [input.locationId]);
    if (!loc.rows[0]) throw ApiError.badRequest('Ubicacion de salida invalida');

    const number = await nextDocNumber(c, 'delivery');
    const r = await c.query<{ id: number }>(
      `INSERT INTO deliveries (number, location_id, invoice_number, notes, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [number, input.locationId, input.invoiceNumber?.trim() || null, input.notes?.trim() || null, user.id]
    );
    const deliveryId = r.rows[0].id;

    for (const it of input.items) {
      await c.query(
        `INSERT INTO delivery_items (delivery_id, product_id, quantity, requested_quantity)
         VALUES ($1,$2,$3,$4)`,
        [deliveryId, it.productId, it.quantity, it.requestedQuantity ?? null]
      );
    }

    if (confirm) {
      await confirmDeliveryTx(c, deliveryId, user);
    }

    await writeAudit(c, {
      userId: user.id, action: confirm ? 'DELIVERY_CREATE_CONFIRM' : 'DELIVERY_CREATE_DRAFT',
      entity: 'delivery', entityId: deliveryId, details: { number }, ip,
    });

    return { id: deliveryId, number };
  });
}

export async function updateDelivery(user: AuthUser, ip: string | undefined, id: number, input: DeliveryDraftInput) {
  assertLocationAccess(user, input.locationId);
  return withTx(async (c) => {
    const d = await c.query<{ status: string; number: string }>(
      'SELECT status, number FROM deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!d.rows[0]) throw ApiError.notFound('Entrega no encontrada');
    if (d.rows[0].status !== 'BORRADOR') {
      throw ApiError.conflict('Solo se pueden modificar entregas en borrador');
    }
    await validateItems(c, input.items);

    await c.query(
      `UPDATE deliveries SET location_id = $1, invoice_number = $2, notes = $3 WHERE id = $4`,
      [input.locationId, input.invoiceNumber?.trim() || null, input.notes?.trim() || null, id]
    );
    await c.query('DELETE FROM delivery_items WHERE delivery_id = $1', [id]);
    for (const it of input.items) {
      await c.query(
        `INSERT INTO delivery_items (delivery_id, product_id, quantity, requested_quantity)
         VALUES ($1,$2,$3,$4)`,
        [id, it.productId, it.quantity, it.requestedQuantity ?? null]
      );
    }
    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_UPDATE_DRAFT', entity: 'delivery', entityId: id, ip,
    });
    return { id, number: d.rows[0].number };
  });
}

/** Confirmacion transaccional: bloquea la fila, valida estado y descuenta stock atómicamente. */
async function confirmDeliveryTx(c: PoolClient, id: number, user: AuthUser) {
  const d = await c.query<{ id: number; number: string; status: string; location_id: number }>(
    'SELECT id, number, status, location_id FROM deliveries WHERE id = $1 FOR UPDATE',
    [id]
  );
  const delivery = d.rows[0];
  if (!delivery) throw ApiError.notFound('Entrega no encontrada');
  assertLocationAccess(user, delivery.location_id);

  // ===== Idempotencia: no permitir confirmar dos veces =====
  if (delivery.status === 'CONFIRMADO') {
    throw ApiError.conflict(`La entrega ${delivery.number} ya fue confirmada`);
  }
  if (delivery.status === 'ANULADO') {
    throw ApiError.conflict(`La entrega ${delivery.number} esta anulada`);
  }

  const items = await c.query<{ product_id: number; quantity: string; name: string }>(
    `SELECT di.product_id, di.quantity, p.name
     FROM delivery_items di JOIN products p ON p.id = di.product_id
     WHERE di.delivery_id = $1`,
    [id]
  );
  if (!items.rows.length) throw ApiError.badRequest('La entrega no tiene productos');

  for (const it of items.rows) {
    await applyStockChange(c, {
      productId: it.product_id,
      locationId: delivery.location_id,
      delta: -Number(it.quantity),
      type: 'SALIDA',
      referenceType: 'DELIVERY',
      referenceId: delivery.id,
      referenceNumber: delivery.number,
      userId: user.id,
      reason: `Entrega de mercaderia ${delivery.number}`,
    });
  }

  await c.query(
    `UPDATE deliveries SET status = 'CONFIRMADO', confirmed_by = $1, confirmed_at = now() WHERE id = $2`,
    [user.id, id]
  );
}

export async function confirmDelivery(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    await confirmDeliveryTx(c, id, user);
    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_CONFIRM', entity: 'delivery', entityId: id, ip,
    });
    return { ok: true };
  });
}

/**
 * Anulacion: las entregas confirmadas NO se eliminan. Requiere permiso de admin
 * y genera movimientos compensatorios (reingreso) auditados.
 */
export async function voidDelivery(user: AuthUser, ip: string | undefined, id: number, reason: string) {
  return withTx(async (c) => {
    const d = await c.query<{ status: string; number: string; location_id: number }>(
      'SELECT status, number, location_id FROM deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    const delivery = d.rows[0];
    if (!delivery) throw ApiError.notFound('Entrega no encontrada');
    assertLocationAccess(user, delivery.location_id);
    if (delivery.status === 'ANULADO') throw ApiError.conflict('La entrega ya esta anulada');

    if (delivery.status === 'CONFIRMADO') {
      const items = await c.query<{ product_id: number; quantity: string }>(
        'SELECT product_id, quantity FROM delivery_items WHERE delivery_id = $1',
        [id]
      );
      for (const it of items.rows) {
        await applyStockChange(c, {
          productId: it.product_id,
          locationId: delivery.location_id,
          delta: Number(it.quantity),
          type: 'ENTRADA',
          referenceType: 'DELIVERY',
          referenceId: id,
          referenceNumber: delivery.number,
          userId: user.id,
          reason: `Anulacion de entrega ${delivery.number}: ${reason}`,
        });
      }
    }

    await c.query(
      `UPDATE deliveries SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2 WHERE id = $3`,
      [user.id, reason, id]
    );
    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_VOID', entity: 'delivery', entityId: id,
      details: { reason, wasConfirmed: delivery.status === 'CONFIRMADO' }, ip,
    });
    return { ok: true };
  });
}

export async function getDelivery(id: number) {
  const result = await withTx(async (c) => loadDelivery(c, id));
  return result;
}

export async function listDeliveries(opts: {
  status?: string; locationId?: number; q?: string; page: number; pageSize: number; offset: number;
}) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status) { params.push(opts.status); where.push(`d.status = $${params.length}`); }
  if (opts.locationId) { params.push(opts.locationId); where.push(`d.location_id = $${params.length}`); }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    const n = params.length;
    where.push(`(d.number ILIKE $${n} OR d.invoice_number ILIKE $${n})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM deliveries d ${whereSql}`, params);
  const rows = await query(
    `SELECT d.id, d.number, d.status, d.invoice_number, d.location_id, l.name AS location_name,
           d.created_at, d.confirmed_at, cu.full_name AS created_by_name,
           (SELECT COALESCE(SUM(quantity),0) FROM delivery_items WHERE delivery_id = d.id) AS total_items,
           (SELECT COUNT(*) FROM delivery_items WHERE delivery_id = d.id) AS line_count
     FROM deliveries d
     JOIN locations l ON l.id = d.location_id
     JOIN users cu ON cu.id = d.created_by
     ${whereSql}
     ORDER BY d.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  return { deliveries: rows.rows, total: Number(count.rows[0].total) };
}
