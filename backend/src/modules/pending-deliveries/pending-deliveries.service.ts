import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../services/audit.service';
import { AuthUser } from '../../middleware/auth';
import { 
  reserveStockBatch, 
  consumeReservation, 
  releaseAllReservationsForReference,
  getAvailableStock,
  checkMultiLocationAvailability,
  getActiveReservationsForReference
} from '../../services/reservation.service';
import { nextDocNumber } from '../../services/numbering';

export interface PendingDeliveryItemInput {
  productId: number;
  quantityRequested: number;      // Lo que pidió el cliente
  sourceLocationId: number;       // De qué sucursal/depósito sale
  quantityReserved: number;       // Lo que se puede reservar realmente (<= disponible)
}

export interface PendingDeliveryCreateInput {
  saleLocationId: number;         // Donde se vendió
  pickupLocationId: number;       // Donde retira el cliente
  customerName?: string | null;
  customerPhone?: string | null;
  customerDocument?: string | null;
  notes?: string | null;
  // Entrega que originó el faltante (derivación multi-sucursal). Permite que
  // anular la entrega cancele también la orden de retiro.
  deliveryId?: number | null;
  items: PendingDeliveryItemInput[];
}

export interface PendingDeliveryConfirmPickupInput {
  barcode: string;
  items: { productId: number; quantityDelivered: number }[];
}

/**
 * Verifica disponibilidad multi-sucursal para UI (antes de crear orden)
 */
export async function checkAvailability(
  productIds: number[],
  saleLocationId: number,
  qtyRequested: number[]
) {
  return withTx(async (c) => {
    return checkMultiLocationAvailability(c, productIds, saleLocationId, qtyRequested);
  });
}

/**
 * Obtiene stock disponible (total - reservado) para un producto en todas las ubicaciones
 */
export async function getStockAvailability(
  productId?: number,
  locationId?: number
) {
  return withTx(async (c) => {
    return getAvailableStock(c, productId, locationId);
  });
}

/**
 * Crea una orden de entrega pendiente con reservas
 * 1. Valida que haya stock en las ubicaciones origen indicadas
 * 2. Crea la orden pendiente (estado PENDIENTE)
 * 3. Reserva el stock en stock_reservations (con expiración 48h)
 * 4. Genera código de barras EAN-13 único
 */
export async function createPendingDelivery(
  user: AuthUser,
  ip: string | undefined,
  input: PendingDeliveryCreateInput,
  // Cuando se llama desde otra operacion (p. ej. confirmacion de entrega),
  // se le pasa el cliente de la transaccion exterior para que la orden, sus
  // items y las reservas queden en la MISMA transaccion. Abrir una segunda
  // transaccion mientras la primera retiene locks (SELECT ... FOR UPDATE)
  // provoca un deadlock a nivel de aplicacion: la conexion interior espera la
  // fila que la exterior tiene bloqueada, y la exterior espera el resultado.
  client?: PoolClient
) {
  const run = async (c: PoolClient) => {
    // Validaciones básicas
    if (!input.items.length) throw ApiError.badRequest('La orden debe tener al menos un producto');
    if (input.saleLocationId === input.pickupLocationId) {
      throw ApiError.badRequest('La sucursal de venta y retiro deben ser distintas para órdenes pendientes');
    }

    // Validar productos y ubicaciones
    const productIds = input.items.map(i => i.productId);
    const locationIds = [...new Set(input.items.map(i => i.sourceLocationId))];
    locationIds.push(input.saleLocationId, input.pickupLocationId);

    const products = await c.query<{ id: number; name: string; is_active: boolean }>(
      'SELECT id, name, is_active FROM products WHERE id = ANY($1)', [productIds]
    );
    const productMap = new Map(products.rows.map(p => [p.id, p]));
    for (const it of input.items) {
      const p = productMap.get(it.productId);
      if (!p) throw ApiError.badRequest(`Producto inexistente (id ${it.productId})`);
      if (!p.is_active) throw ApiError.badRequest(`El producto "${p.name}" esta inactivo`);
    }

    const locations = await c.query<{ id: number; is_active: boolean }>(
      'SELECT id, is_active FROM locations WHERE id = ANY($1)', [locationIds]
    );
    const locMap = new Map(locations.rows.map(l => [l.id, l]));
    for (const locId of locationIds) {
      const l = locMap.get(locId);
      if (!l || !l.is_active) throw ApiError.badRequest(`Ubicación inválida o inactiva (id ${locId})`);
    }

    // Verificar stock disponible en cada ubicación origen
    for (const it of input.items) {
      const available = await c.query<{ available: string }>(
        `SELECT (quantity - reserved_quantity) AS available
         FROM stock_balances
         WHERE product_id = $1 AND location_id = $2`,
        [it.productId, it.sourceLocationId]
      );
      const avail = Number(available.rows[0]?.available ?? 0);
      if (avail < it.quantityReserved) {
        throw ApiError.conflict(
          `Stock insuficiente en ubicación origen para producto ${it.productId}: ` +
          `disponible ${avail}, intentando reservar ${it.quantityReserved}`
        );
      }
    }

    // Crear orden pendiente
    const number = await nextDocNumber(c, 'pending_delivery');
    
    // Generar código de barras único (usar función DB)
    const barcodeResult = await c.query<{ barcode: string }>(
      `SELECT generate_ean13_barcode() AS barcode`
    );
    const barcode = barcodeResult.rows[0].barcode;

    const pdResult = await c.query<{ id: number }>(
      `INSERT INTO pending_deliveries (
        number, barcode, sale_location_id, pickup_location_id,
        customer_name, customer_phone, customer_document, notes, delivery_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        number, barcode, input.saleLocationId, input.pickupLocationId,
        input.customerName?.trim() || null,
        input.customerPhone?.trim() || null,
        input.customerDocument?.trim() || null,
        input.notes?.trim() || null,
        input.deliveryId ?? null,
        user.id
      ]
    );
    const pendingDeliveryId = pdResult.rows[0].id;

    // Insertar items y crear reservas
    for (const it of input.items) {
      // Item en la orden pendiente
      await c.query(
        `INSERT INTO pending_delivery_items (
          pending_delivery_id, product_id, quantity_requested, quantity_reserved, source_location_id
        ) VALUES ($1,$2,$3,$4,$5)`,
        [pendingDeliveryId, it.productId, it.quantityRequested, it.quantityReserved, it.sourceLocationId]
      );

      // Reserva en stock_reservations (con expiración 48h)
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
      await c.query(
        `INSERT INTO stock_reservations (
          number, reference_type, reference_id, pending_delivery_id, product_id, source_location_id,
          quantity_reserved, reserved_by, expires_at, status
        ) VALUES (
          'RES-' || lpad(nextval('seq_reservation_number')::text, 6, '0'),
          'PENDING_DELIVERY', $1, $2, $3, $4, $5, $6, $7, 'ACTIVA'
        )`,
        [pendingDeliveryId, pendingDeliveryId, it.productId, it.sourceLocationId, it.quantityReserved, user.id, expiresAt]
      );
    }

    await writeAudit(c, {
      userId: user.id, action: 'PENDING_DELIVERY_CREATE', entity: 'pending_delivery', entityId: pendingDeliveryId,
      details: { number, barcode, itemsCount: input.items.length }, ip,
    });

    return { id: pendingDeliveryId, number, barcode };
  };

  return client ? run(client) : withTx(run);
}

/**
 * Escanea código de barras y devuelve la orden pendiente completa
 * Usado por el empleado en la sucursal de retiro
 */
export async function scanPendingDeliveryBarcode(barcode: string) {
  const result = await query(
    `SELECT * FROM scan_pending_delivery_barcode($1)`,
    [barcode]
  );
  if (!result.rows[0]) throw ApiError.notFound('Código de barras no encontrado');
  return result.rows[0];
}

/**
 * Confirma retiro/entrega: descuenta stock real y marca items como entregados
 * Se llama cuando el cliente presenta el código de barras en la sucursal
 */
export async function confirmPickup(
  user: AuthUser,
  ip: string | undefined,
  input: PendingDeliveryConfirmPickupInput
) {
  return withTx(async (c) => {
    // Verificar que el usuario puede operar en la sucursal de retiro
    const pd = await c.query<{ id: number; pickup_location_id: number; status: string; number: string }>(
      'SELECT id, pickup_location_id, status, number FROM pending_deliveries WHERE barcode = $1',
      [input.barcode]
    );
    if (!pd.rows[0]) throw ApiError.notFound('Orden no encontrada');
    const delivery = pd.rows[0];

    if (!['PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO'].includes(delivery.status)) {
      throw ApiError.conflict(`Orden en estado inválido para entrega: ${delivery.status}`);
    }

    // TODO: Verificar que user.default_location_id === delivery.pickup_location_id si restrict_to_location

    // Procesar cada item entregado
    for (const item of input.items) {
      if (item.quantityDelivered <= 0) continue;

      // Buscar reserva activa para este producto en la orden
      const reservation = await c.query<{ 
        id: number; 
        product_id: number; 
        source_location_id: number; 
        quantity_reserved: number; 
        quantity_consumed: number;
        status: string;
      }>(
        `SELECT id, product_id, source_location_id, quantity_reserved, quantity_consumed, status
         FROM stock_reservations
         WHERE pending_delivery_id = $1 AND product_id = $2 AND status IN ('ACTIVA', 'PARCIAL')
         ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [delivery.id, item.productId]
      );

      if (!reservation.rows[0]) {
        throw ApiError.conflict(`No hay reserva activa para producto ${item.productId}`);
      }

      const res = reservation.rows[0];
      const pendingQty = res.quantity_reserved - res.quantity_consumed;
      
      if (item.quantityDelivered > pendingQty) {
        throw ApiError.conflict(
          `Cantidad entregada (${item.quantityDelivered}) supera lo reservado pendiente (${pendingQty})`
        );
      }

      // Verificar stock real en la ubicación de retiro (source_location_id de la reserva)
      const stock = await c.query<{ quantity: string }>(
        `SELECT quantity FROM stock_balances 
         WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
        [res.product_id, res.source_location_id]
      );
      const realStock = Number(stock.rows[0]?.quantity ?? 0);
      if (realStock < item.quantityDelivered) {
        throw ApiError.conflict(`Stock real insuficiente en ubicación de retiro: ${realStock} disponible`);
      }

      // Consumir reserva (descuenta stock real + registra movimiento)
      const consumeResult = await consumeReservation(c, {
        reservationId: res.id,
        quantity: item.quantityDelivered,
        consumedBy: user.id,
        movementType: 'SALIDA',
        reason: `Entrega orden pendiente ${delivery.number}`,
      });

      if (!consumeResult.success) {
        throw ApiError.conflict(`Error al confirmar entrega: ${consumeResult.message}`);
      }

      // Actualizar item de la orden pendiente
      await c.query(
        `UPDATE pending_delivery_items 
         SET quantity_delivered = quantity_delivered + $1
         WHERE pending_delivery_id = $2 AND product_id = $3 AND source_location_id = $4`,
        [item.quantityDelivered, delivery.id, res.product_id, res.source_location_id]
      );
    }

    // Verificar si toda la orden se entregó
    const pendingItems = await c.query<{ count: string }>(
      `SELECT COUNT(*) FROM pending_delivery_items 
       WHERE pending_delivery_id = $1 AND quantity_delivered < quantity_reserved`,
      [delivery.id]
    );

    const newStatus = Number(pendingItems.rows[0].count) === 0 ? 'ENTREGADO' : 'ENTREGADO'; // O 'PARCIAL'
    
    await c.query(
      `UPDATE pending_deliveries 
       SET status = $1, delivered_by = $2, delivered_at = now(), updated_at = now()
       WHERE id = $3`,
      [newStatus, user.id, delivery.id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'PENDING_DELIVERY_PICKUP', entity: 'pending_delivery', entityId: delivery.id,
      details: { barcode: input.barcode, items: input.items }, ip,
    });

    return { ok: true, status: newStatus, pendingDeliveryId: delivery.id };
  });
}

/**
 * Cancela una orden pendiente y libera sus reservas
 */
export async function cancelPendingDelivery(
  user: AuthUser,
  ip: string | undefined,
  id: number,
  reason: string,
  // Cliente de una transaccion exterior (p. ej. anulacion de la entrega que
  // origino la orden). Evita abrir una segunda transaccion mientras la
  // exterior retiene locks.
  client?: PoolClient
) {
  const run = async (c: PoolClient) => {
    const pd = await c.query<{ id: number; status: string; number: string }>(
      'SELECT id, status, number FROM pending_deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!pd.rows[0]) throw ApiError.notFound('Orden no encontrada');
    const delivery = pd.rows[0];

    if (delivery.status === 'ENTREGADO' || delivery.status === 'CANCELADO') {
      throw ApiError.conflict(`No se puede cancelar orden en estado ${delivery.status}`);
    }

    // Liberar reservas
    await releaseAllReservationsForReference(c, 'PENDING_DELIVERY', id, user.id, reason);

    await c.query(
      `UPDATE pending_deliveries 
       SET status = 'CANCELADO', cancelled_by = $1, cancelled_at = now(), cancel_reason = $2, updated_at = now()
       WHERE id = $3`,
      [user.id, reason, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'PENDING_DELIVERY_CANCEL', entity: 'pending_delivery', entityId: id,
      details: { reason, wasStatus: delivery.status }, ip,
    });

    return { ok: true };
  };

  return client ? run(client) : withTx(run);
}

/**
 * Lista órdenes pendientes con filtros
 */
export async function listPendingDeliveries(opts: {
  status?: string;
  saleLocationId?: number;
  pickupLocationId?: number;
  q?: string;
  page: number;
  pageSize: number;
  offset: number;
}) {
  const params: unknown[] = [];
  const where: string[] = [];

  if (opts.status) { params.push(opts.status); where.push(`pd.status = $${params.length}`); }
  if (opts.saleLocationId) { params.push(opts.saleLocationId); where.push(`pd.sale_location_id = $${params.length}`); }
  if (opts.pickupLocationId) { params.push(opts.pickupLocationId); where.push(`pd.pickup_location_id = $${params.length}`); }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    const n = params.length;
    where.push(`(pd.number ILIKE $${n} OR pd.barcode ILIKE $${n} OR pd.customer_name ILIKE $${n} OR pd.customer_phone ILIKE $${n})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM pending_deliveries pd ${whereSql}`, params);
  
  const rows = await query(
    `SELECT pd.id, pd.number, pd.barcode, pd.status, pd.sale_location_id, pd.pickup_location_id,
            sl.name AS sale_location_name, sl.code AS sale_location_code,
            pl.name AS pickup_location_name, pl.code AS pickup_location_code,
            pd.customer_name, pd.customer_phone, pd.customer_document,
            pd.created_at, pd.delivered_at,
            cu.full_name AS created_by_name,
            (SELECT COUNT(*) FROM pending_delivery_items WHERE pending_delivery_id = pd.id) AS items_count,
            (SELECT SUM(quantity_reserved) FROM pending_delivery_items WHERE pending_delivery_id = pd.id) AS total_qty_reserved,
            (SELECT SUM(quantity_delivered) FROM pending_delivery_items WHERE pending_delivery_id = pd.id) AS total_qty_delivered
     FROM pending_deliveries pd
     JOIN locations sl ON sl.id = pd.sale_location_id
     JOIN locations pl ON pl.id = pd.pickup_location_id
     JOIN users cu ON cu.id = pd.created_by
     ${whereSql}
     ORDER BY pd.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );

  return { pendingDeliveries: rows.rows, total: Number(count.rows[0].total) };
}

/**
 * Obtiene detalle completo de una orden pendiente
 */
export async function getPendingDelivery(id: number) {
  return withTx(async (c) => {
    const head = await c.query(
      `SELECT pd.*, sl.name AS sale_location_name, sl.code AS sale_location_code,
              pl.name AS pickup_location_name, pl.code AS pickup_location_code,
              cu.full_name AS created_by_name
       FROM pending_deliveries pd
       JOIN locations sl ON sl.id = pd.sale_location_id
       JOIN locations pl ON pl.id = pd.pickup_location_id
       JOIN users cu ON cu.id = pd.created_by
       WHERE pd.id = $1`,
      [id]
    );
    if (!head.rows[0]) return null;

    const items = await c.query(
      `SELECT pdi.*, p.code AS product_code, p.name AS product_name, p.unit,
              sl.code AS source_location_code, sl.name AS source_location_name
       FROM pending_delivery_items pdi
       JOIN products p ON p.id = pdi.product_id
       JOIN locations sl ON sl.id = pdi.source_location_id
       WHERE pdi.pending_delivery_id = $1 ORDER BY pdi.id`,
      [id]
    );

    const reservations = await getActiveReservationsForReference(c, 'PENDING_DELIVERY', id);

    return { ...head.rows[0], items: items.rows, reservations };
  });
}