import { PoolClient } from 'pg';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { applyStockChange } from '../../services/stockEngine';
import { nextDocNumber } from '../../services/numbering';
import { writeAudit } from '../../services/audit.service';
import { assertLocationAccess } from '../../lib/locationGuard';
import { AuthUser } from '../../middleware/auth';
import { 
  reserveStockBatch, 
  consumeReservation, 
  releaseAllReservationsForReference,
  checkMultiLocationAvailability
} from '../../services/reservation.service';
import { createPendingDelivery, cancelPendingDelivery } from '../pending-deliveries/pending-deliveries.service';
import { evaluateBusinessRules } from '../../services/businessRules.service';
import { createApprovalRequest } from '../../services/approval.service';
import { createAlert } from '../../services/alerts.service';
import { getConfirmationSetting } from '../../services/confirmationSettings.service';

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
  // Nuevos campos para reparto a domicilio
  deliveryType?: 'LOCAL' | 'DOMICILIO';
  customerName?: string | null;
  customerPhone?: string | null;
  deliveryAddress?: string | null;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  driverUserId?: number | null;
  driverId?: number | null; // alias
  dueAt?: string | null;
  deliveryObservations?: string | null;
  pendingDelivery?: boolean;
}

export interface DeliveryConfirmResult {
  success: boolean;
  deliveryId: number;
  deliveryNumber: string;
  fullyDelivered: { productId: number; quantity: number }[];
  shortfalls: DeliveryShortfall[];
  pendingDeliveries: DeliveryPendingOrderRef[];
  /** Compat: la primera orden creada (para consumo existente en frontend) */
  pendingDelivery?: DeliveryPendingOrderRef;
  /** Faltantes que quedaron sin destinar a ninguna sucursal (sin stock en ninguna parte) */
  unresolvedShortfalls?: { productId: number; productName: string; quantity: number }[];
}

export interface DeliveryPendingOrderRef {
  id: number;
  number: string;
  barcode: string;
  pickupLocationId: number;
  pickupLocationName: string;
}

export interface DeliveryShortfall {
  productId: number;
  productCode: string;
  productName: string;
  requestedQuantity: number;
  availableAtMainLocation: number;
  shortfallQuantity: number;
  alternativeLocations: {
    locationId: number;
    locationCode: string;
    locationName: string;
    availableQuantity: number;
  }[];
}

interface PendingItemInput {
  productId: number;
  quantityRequested: number;
  sourceLocationId: number;
  quantityReserved: number;
}

/**
 * Crea las órdenes de retiro pendientes para un conjunto de faltantes,
 * agrupando los ítems por sucursal de retiro: una orden (con su propio
 * código de barras) por sucursal. Antes se creaba UNA sola orden con
 * pickup = la sucursal del primer ítem, aunque hubiera ítems derivados
 * desde sucursales distintas (el cliente veía mal dónde retirar).
 */
async function createPendingOrdersForShortfalls(
  c: PoolClient,
  user: AuthUser,
  saleLocationId: number,
  deliveryId: number,
  notesPrefix: string,
  items: PendingItemInput[]
): Promise<DeliveryPendingOrderRef[]> {
  // Agrupar por sucursal de retiro
  const groups = new Map<number, PendingItemInput[]>();
  for (const it of items) {
    const list = groups.get(it.sourceLocationId) ?? [];
    list.push(it);
    groups.set(it.sourceLocationId, list);
  }

  const orders: DeliveryPendingOrderRef[] = [];
  for (const [pickupLocationId, groupItems] of groups) {
    const pd = await createPendingDelivery(user, undefined, {
      saleLocationId,
      pickupLocationId,
      customerName: undefined,
      customerPhone: undefined,
      customerDocument: undefined,
      notes: `${notesPrefix} - retiro en esta sucursal`,
      deliveryId,
      items: groupItems,
    }, c);

    const pickupName = await c.query<{ name: string }>(
      'SELECT name FROM locations WHERE id = $1',
      [pickupLocationId]
    );
    orders.push({
      id: pd.id,
      number: pd.number,
      barcode: pd.barcode,
      pickupLocationId,
      pickupLocationName: pickupName.rows[0]?.name ?? '',
    });
  }
  return orders;
}

/**
 * De cada faltante elige la sucursal alternativa con más stock disponible
 * (modo automático, sin intervención del usuario). Si en la mejor sucursal
 * no alcanza para todo el faltante, el sobrante queda reportado en
 * `unresolved` (deuda de mercadería sin destino posible).
 */
function autoAssignShortfalls(shortfalls: DeliveryShortfall[]): {
  pendingItems: PendingItemInput[];
  unresolved: { productId: number; productName: string; quantity: number }[];
} {
  const pendingItems: PendingItemInput[] = [];
  const unresolved: { productId: number; productName: string; quantity: number }[] = [];

  for (const sf of shortfalls) {
    if (sf.alternativeLocations.length === 0) continue; // se maneja como unresolved por el llamador

    const best = sf.alternativeLocations.reduce((bestLoc, cur) =>
      cur.availableQuantity > bestLoc.availableQuantity ? cur : bestLoc
    );
    const reservedQty = Math.min(sf.shortfallQuantity, best.availableQuantity);
    if (reservedQty <= 0) continue; // nada reservable: queda en unresolved

    pendingItems.push({
      productId: sf.productId,
      quantityRequested: sf.shortfallQuantity,
      sourceLocationId: best.locationId,
      quantityReserved: reservedQty,
    });
    if (reservedQty < sf.shortfallQuantity) {
      unresolved.push({
        productId: sf.productId,
        productName: sf.productName,
        quantity: sf.shortfallQuantity - reservedQty,
      });
    }
  }

  return { pendingItems, unresolved };
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
  const seen = new Set<number>();
  for (const it of items) {
    if (seen.has(it.productId)) throw ApiError.badRequest('Hay productos duplicados en la lista');
    seen.add(it.productId);
  }
}

async function loadDelivery(client: PoolClient, id: number) {
  const head = await client.query(
    `SELECT d.*, l.name AS location_name, l.code AS location_code,
            cu.full_name AS created_by_name, vu.full_name AS confirmed_by_name,
            pu.full_name AS packed_by_name, vau.full_name AS void_approved_by_name,
            du.full_name AS driver_name
     FROM deliveries d
     JOIN locations l ON l.id = d.location_id
     JOIN users cu ON cu.id = d.created_by
     LEFT JOIN users vu ON vu.id = d.confirmed_by
     LEFT JOIN users pu ON pu.id = d.packed_by
     LEFT JOIN users vau ON vau.id = d.void_approved_by
     LEFT JOIN users du ON du.id = d.driver_user_id
     WHERE d.id = $1`,
    [id]
  );
  if (!head.rows[0]) return null;
  const items = await client.query(
    `SELECT di.id, di.product_id, di.quantity, di.quantity_delivered, di.requested_quantity,
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
  if (!input.invoiceNumber?.trim()) throw ApiError.badRequest('El número de factura es obligatorio');
  return withTx(async (c) => {
    await validateItems(c, input.items);
    const loc = await c.query('SELECT id FROM locations WHERE id = $1 AND is_active', [input.locationId]);
    if (!loc.rows[0]) throw ApiError.badRequest('Ubicacion de salida invalida');

    const qtySum = input.items.reduce((s, it) => s + it.quantity, 0);
    const context = { qty_sum: qtySum, location_id: input.locationId, user_role: user.role };

    // Evaluar reglas ANTES de crear
    const rules = await evaluateBusinessRules('DELIVERY', 'BEFORE_CREATE', context);
    const requiresApproval = rules.some(r => r.action.require_approval);
    let status: 'BORRADOR' | 'CONFIRMADO' | 'PARCIAL' = 'BORRADOR';

    const number = await nextDocNumber(c, 'delivery');
    const barcode = (await c.query('SELECT generate_ean13_barcode() AS barcode')).rows[0].barcode;
    const driverUserId = input.driverUserId ?? input.driverId ?? null;
    const deliveryType = input.deliveryType || (driverUserId || input.deliveryAddress ? 'DOMICILIO' : 'LOCAL');
    const r = await c.query<{ id: number }>(
      `INSERT INTO deliveries (number, location_id, invoice_number, notes, barcode, created_by, status,
                               delivery_type, customer_name, customer_phone, delivery_address, delivery_lat, delivery_lng,
                               driver_user_id, driver_assigned_at, due_at, delivery_observations, is_pending_delivery)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [
        number,
        input.locationId,
        input.invoiceNumber?.trim() || null,
        input.notes?.trim() || null,
        barcode,
        user.id,
        status,
        deliveryType,
        input.customerName?.trim() || null,
        input.customerPhone?.trim() || null,
        input.deliveryAddress?.trim() || null,
        input.deliveryLat ?? null,
        input.deliveryLng ?? null,
        driverUserId,
        driverUserId ? new Date() : null,
        input.dueAt ? new Date(input.dueAt) : null,
        input.deliveryObservations?.trim() || null,
        Boolean(input.pendingDelivery),
      ]
    );
    const deliveryId = r.rows[0].id;

    // Insercion de items en UNA sola query (unnest) en vez de N round-trips
    await c.query(
      `INSERT INTO delivery_items (delivery_id, product_id, quantity, requested_quantity)
       SELECT $1, p, q, rq FROM unnest($2::int[], $3::numeric[], $4::numeric[]) AS t(p, q, rq)`,
      [
        deliveryId,
        input.items.map((it) => it.productId),
        input.items.map((it) => it.quantity),
        input.items.map((it) => it.requestedQuantity ?? null),
      ]
    );

    // Reserva disponibilidad sin descontar stock físico hasta la entrega efectiva.
    if (input.pendingDelivery) {
      await reserveStockBatch(c, input.items.map((it) => ({
        referenceType: 'DELIVERY' as const, referenceId: deliveryId, productId: it.productId,
        sourceLocationId: input.locationId, quantity: Math.max(it.quantity, it.requestedQuantity ?? 0),
        reservedBy: user.id, expiresAt: null,
      })));
    }

    if (requiresApproval) {
      const rule = rules.find(r => r.action.require_approval)!;
      await createApprovalRequest({
        ruleId: rule.ruleId,
        entityType: 'DELIVERY',
        entityId: deliveryId,
        entityNumber: number,
        requestedBy: user.id,
        context: { ...context, items: input.items },
      }, c);
      await writeAudit(c, { userId: user.id, action: 'DELIVERY_CREATE_PENDING_APPROVAL', entity: 'delivery', entityId: deliveryId, details: { number, requiresApproval: true, pendingDelivery: Boolean(input.pendingDelivery) }, ip });
      return { id: deliveryId, number, status: 'BORRADOR', requiresApproval: true };
    }

    if (confirm && !input.pendingDelivery) {
      await confirmDeliveryTx(c, deliveryId, user);
    } else {
      await writeAudit(c, { userId: user.id, action: 'DELIVERY_CREATE_DRAFT', entity: 'delivery', entityId: deliveryId, details: { number, pendingDelivery: Boolean(input.pendingDelivery) }, ip });
    }

    return { id: deliveryId, number, status: input.pendingDelivery ? 'PENDIENTE_ENTREGA' : (confirm ? 'CONFIRMADO' : 'BORRADOR'), pendingDelivery: Boolean(input.pendingDelivery), requiresApproval: false };
  });
}

export async function updateDelivery(user: AuthUser, ip: string | undefined, id: number, input: DeliveryDraftInput) {
  assertLocationAccess(user, input.locationId);
  return withTx(async (c) => {
    const d = await c.query<{ status: string; number: string; is_pending_delivery: boolean }>(
      'SELECT status, number, is_pending_delivery FROM deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!d.rows[0]) throw ApiError.notFound('Entrega no encontrada');
    if (d.rows[0].status !== 'BORRADOR') {
      throw ApiError.conflict('Solo se pueden modificar entregas en borrador');
    }
    if (d.rows[0].is_pending_delivery) throw ApiError.conflict('La entrega ya tiene stock reservado. Anulala y creá una nueva para cambiar sus productos.');
    if (!input.invoiceNumber?.trim()) throw ApiError.badRequest('El número de factura es obligatorio');
    await validateItems(c, input.items);

    const driverUserId = input.driverUserId ?? input.driverId ?? null;
    const deliveryType = input.deliveryType || (driverUserId || input.deliveryAddress ? 'DOMICILIO' : undefined);
    await c.query(
      `UPDATE deliveries SET location_id = $1, invoice_number = $2, notes = $3,
                              delivery_type = COALESCE($5, delivery_type),
                              customer_name = COALESCE($6, customer_name),
                              customer_phone = COALESCE($7, customer_phone),
                              delivery_address = COALESCE($8, delivery_address),
                              delivery_lat = COALESCE($9, delivery_lat),
                              delivery_lng = COALESCE($10, delivery_lng),
                              driver_user_id = COALESCE($11, driver_user_id),
                              driver_assigned_at = CASE WHEN $11 IS NOT NULL AND driver_assigned_at IS NULL THEN now() ELSE driver_assigned_at END,
                              due_at = COALESCE($12, due_at),
                              delivery_observations = COALESCE($13, delivery_observations)
       WHERE id = $4`,
      [
        input.locationId,
        input.invoiceNumber?.trim() || null,
        input.notes?.trim() || null,
        id,
        deliveryType || null,
        input.customerName?.trim() || null,
        input.customerPhone?.trim() || null,
        input.deliveryAddress?.trim() || null,
        input.deliveryLat ?? null,
        input.deliveryLng ?? null,
        driverUserId,
        input.dueAt ? new Date(input.dueAt) : null,
        input.deliveryObservations?.trim() || null,
      ]
    );
    await c.query('DELETE FROM delivery_items WHERE delivery_id = $1', [id]);
    // Reinsercion de items en UNA sola query (unnest)
    await c.query(
      `INSERT INTO delivery_items (delivery_id, product_id, quantity, requested_quantity)
       SELECT $1, p, q, rq FROM unnest($2::int[], $3::numeric[], $4::numeric[]) AS t(p, q, rq)`,
      [
        id,
        input.items.map((it) => it.productId),
        input.items.map((it) => it.quantity),
        input.items.map((it) => it.requestedQuantity ?? null),
      ]
    );
    await writeAudit(c, { userId: user.id, action: 'DELIVERY_UPDATE_DRAFT', entity: 'delivery', entityId: id, ip });
    return { id, number: d.rows[0].number };
  });
}

/** Confirmacion transaccional con manejo de faltantes multi-sucursal. */
async function confirmDeliveryTx(c: PoolClient, id: number, user: AuthUser, pickMap?: Map<number, number>): Promise<DeliveryConfirmResult> {
  const d = await c.query<{ id: number; number: string; status: string; location_id: number; created_by: number; location_name: string; location_code: string; is_pending_delivery: boolean }>(
    `SELECT d.id, d.number, d.status, d.location_id, d.created_by, d.is_pending_delivery, l.name AS location_name, l.code AS location_code
     FROM deliveries d JOIN locations l ON l.id = d.location_id
     WHERE d.id = $1 FOR UPDATE`,
    [id]
  );
  const delivery = d.rows[0];
  if (!delivery) throw ApiError.notFound('Entrega no encontrada');
  assertLocationAccess(user, delivery.location_id);

  // Idempotencia: se consulta antes que la segregación para que un doble
  // clic o un reintento devuelva 409 ("ya fue confirmada") y no un 403
  // confuso sobre quién creó la entrega. PARCIAL también cuenta como ya
  // confirmada: quedan unidades derivadas, re-confirmar duplicaría el descuento.
  if (delivery.status === 'CONFIRMADO' || delivery.status === 'PARCIAL') {
    throw ApiError.conflict(`La entrega ${delivery.number} ya fue confirmada`);
  }
  if (delivery.status === 'ANULADO') throw ApiError.conflict(`La entrega ${delivery.number} esta anulada`);

  const items = await c.query<{ product_id: number; quantity: string; requested_quantity: string | null; name: string; code: string }>(
    `SELECT di.product_id, di.quantity, di.requested_quantity, p.name, p.code
     FROM delivery_items di JOIN products p ON p.id = di.product_id
     WHERE di.delivery_id = $1`,
    [id]
  );
  if (!items.rows.length) throw ApiError.badRequest('La entrega no tiene productos');

  const pendingQtySum = items.rows.reduce((sum, it) => sum + Number(it.quantity), 0);
  const pendingRules = await evaluateBusinessRules('DELIVERY', 'BEFORE_CONFIRM', {
    qty_sum: pendingQtySum, location_id: delivery.location_id, user_role: user.role,
  });
  if (pendingRules.some(r => r.action.require_approval) && user.role === 'EMPLEADO') {
    throw ApiError.forbidden('Esta entrega requiere aprobador con rol ENCARGADO o superior');
  }

  if (delivery.is_pending_delivery) {
    const active = await c.query<{
      reservation_id: number; product_id: number; quantity_reserved: string; quantity_consumed: string;
    }>(
      `SELECT id AS reservation_id, product_id, quantity_reserved, quantity_consumed
       FROM stock_reservations
       WHERE reference_type = 'DELIVERY' AND reference_id = $1
         AND status IN ('ACTIVA', 'PARCIAL')
       ORDER BY product_id, source_location_id, id FOR UPDATE`,
      [id]
    );
    const reservedByProduct = new Map<number, number>();
    for (const r of active.rows) {
      const remaining = Number(r.quantity_reserved) - Number(r.quantity_consumed);
      reservedByProduct.set(r.product_id, (reservedByProduct.get(r.product_id) ?? 0) + remaining);
    }
    for (const it of items.rows) {
      const target = Math.max(Number(it.quantity), Number(it.requested_quantity ?? 0));
      const reserved = reservedByProduct.get(it.product_id) ?? 0;
      if (Math.abs(reserved - target) > 0.000001) {
        throw ApiError.conflict(`La reserva de ${it.name} no coincide con la cantidad prevista (${reserved} reservadas, ${target} requeridas).`);
      }
    }
    const fullyDelivered: { productId: number; quantity: number }[] = [];
    for (const r of active.rows) {
      const remaining = Number(r.quantity_reserved) - Number(r.quantity_consumed);
      if (remaining <= 0) continue;
      const consumed = await consumeReservation(c, {
        reservationId: r.reservation_id, quantity: remaining, consumedBy: user.id,
        movementType: 'SALIDA', reason: `Entrega pendiente efectivizada ${delivery.number}`,
      });
      if (!consumed.success) throw ApiError.conflict(`No se pudo consumir la reserva: ${consumed.message}`);
      const existing = fullyDelivered.find(x => x.productId === r.product_id);
      if (existing) existing.quantity += remaining;
      else fullyDelivered.push({ productId: r.product_id, quantity: remaining });
    }
    await c.query(
      `UPDATE delivery_items SET quantity_delivered = GREATEST(quantity, COALESCE(requested_quantity, quantity))
       WHERE delivery_id = $1`, [id]
    );
    await c.query(
      `UPDATE deliveries SET status = 'CONFIRMADO', confirmed_by = $1, confirmed_at = now(),
                              packed_by = $1, packed_at = now() WHERE id = $2`,
      [user.id, id]
    );
    return { success: true, deliveryId: delivery.id, deliveryNumber: delivery.number,
      fullyDelivered, shortfalls: [], pendingDeliveries: [] };
  }

  // Disponibilidad global: si un producto no tiene stock en ninguna ubicación
  // no hay nada que derivar ni reservar, así que se responde 409 con el motivo
  // real antes de cualquier otra validación.
  const zeroStock = await c.query<{ product_id: number; name: string; code: string }>(
    `SELECT p.id AS product_id, p.name, p.code
     FROM unnest($1::integer[]) AS pid
     JOIN products p ON p.id = pid
     WHERE COALESCE((SELECT SUM(sb.quantity - sb.reserved_quantity)
                     FROM stock_balances sb WHERE sb.product_id = pid), 0) <= 0`,
    [items.rows.map((it) => it.product_id)]
  );
  if (zeroStock.rows.length) {
    const p = zeroStock.rows[0];
    throw ApiError.conflict(`Sin stock disponible para "${p.name}" (${p.code}) en ninguna ubicación`);
  }

  // Regla de negocio: cualquier vendedor de la sucursal puede confirmar la
  // entrega, incluido el que cargo el borrador (todos los vendedores que
  // entreguen pueden aceptar la entrega).

  // Evaluar reglas al confirmar
  const qtySum = items.rows.reduce((s, it) => s + Number(it.quantity), 0);
  const context = { qty_sum: qtySum, location_id: delivery.location_id, user_role: user.role };
  const rules = await evaluateBusinessRules('DELIVERY', 'BEFORE_CONFIRM', context);
  const stillRequiresApproval = rules.some(r => r.action.require_approval);
  if (stillRequiresApproval && user.role === 'EMPLEADO') {
    throw ApiError.forbidden('Esta entrega requiere aprobador con rol ENCARGADO o superior');
  }

  const productIds = items.rows.map(it => it.product_id);
  const quantities = items.rows.map(it => Number(it.quantity));
  const availability = await checkMultiLocationAvailability(c, productIds, delivery.location_id, quantities);
  
  const shortfalls: DeliveryShortfall[] = [];
  const fullyDelivered: { productId: number; quantity: number }[] = [];
  // Lo que queda debiéndose sin destino posible (sin stock en ninguna parte
  // para derivar). Se registra como alerta tras el commit para seguimiento.
  const unresolved: { productId: number; productName: string; quantity: number }[] = [];
  // Lo efectivamente entregado por ítem (para quantity_delivered)
  const deliverNowMap = new Map<number, number>();
  const reservationInputs: Array<{
    referenceType: 'DELIVERY';
    referenceId: number;
    productId: number;
    sourceLocationId: number;
    quantity: number;
    reservedBy: number;
    expiresAt: Date;
  }> = [];

  for (let i = 0; i < items.rows.length; i++) {
    const it = items.rows[i];
    const qty = Number(it.quantity);
    // Lo facturado/vendido. Si se facturaron 105 y la sucursal tiene 98, el
    // faltante a derivar es 7 aunque `quantity` también valga 98 (se entrega
    // todo el stock local). Si no hay factura cargada, manda `quantity`.
    const billed = it.requested_quantity === null ? null : Number(it.requested_quantity);
    const target = Math.max(qty, billed ?? 0);
    const avail = availability.find(a => a.productId === it.product_id);
    const availableAtMain = Number(avail?.saleLocationQty || 0);
    // Checklist de picking: lo que el operador realmente recibió de este producto.
    // undefined = sin checklist -> comportamiento histórico.
    const pickedQty = pickMap?.get(it.product_id);

    // Lo que efectivamente sale de esta sucursal
    const deliverNow = Math.min(qty, availableAtMain, pickedQty !== undefined ? Math.max(0, pickedQty) : Infinity);
    // Faltante total a derivar para completar lo facturado / lo pedido.
    // Con checklist el resto del objetivo queda debiéndose aunque haya stock
    // local sin agarrar (queda como derivación posible, ver abajo).
    const shortfallQty = pickedQty !== undefined
      ? Math.max(0, target - deliverNow)
      : Math.max(0, target - availableAtMain);
    // HardShortfall solo es bloqueante en modo histórico: si el picker decidió
    // recibir menos, eso NO puede romper la confirmación.
    const hardShortfall = pickedQty !== undefined ? 0 : Math.max(0, qty - availableAtMain);
    deliverNowMap.set(it.product_id, deliverNow);

    if (deliverNow > 0) {
      fullyDelivered.push({ productId: it.product_id, quantity: deliverNow });
      reservationInputs.push({
        referenceType: 'DELIVERY',
        referenceId: delivery.id,
        productId: it.product_id,
        sourceLocationId: delivery.location_id,
        quantity: deliverNow,
        reservedBy: user.id,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });
    }

    if (shortfallQty > 0) {
      const alternatives = (avail?.otherLocations || [])
        .filter((loc: any) => Number(loc.availableQty) > 0)
        .map((loc: any) => ({
          locationId: loc.locationId,
          locationCode: loc.locationCode,
          locationName: loc.locationName,
          availableQuantity: Number(loc.availableQty),
        }));

      // En modo picking el stock SOBRANTE de la propia sucursal también puede
      // cubrir lo que no se agarró (queda en la misma tienda y va como
      // derivación a retiro posterior). Se lista primero.
      if (pickedQty !== undefined) {
        const mainLeft = availableAtMain - deliverNow;
        if (mainLeft > 0) {
          alternatives.unshift({
            locationId: delivery.location_id,
            locationCode: delivery.location_code,
            locationName: delivery.location_name,
            availableQuantity: mainLeft,
          });
        }
      }

      if (alternatives.length === 0) {
        // Sin dónde derivar. Si además no se pudo entregar lo que se pidió
        // ahora, la entrega no se puede cumplir -> 409 (el borrador es editable:
        // el operador quita o reduce el ítem). Si lo pedido se entregó completo
        // y solo falta lo facturado de más, se entrega igual y queda la deuda
        // documentada (alerta + comprobante) sin ninguna orden de retiro.
        if (hardShortfall > 0) {
          throw ApiError.conflict(
            `Stock insuficiente para "${it.name}" (${it.code}): ` +
            `disponible ${availableAtMain} en sucursal principal, ` +
            `requerido ${qty}, y no hay stock en otras sucursales. ` +
            `Modificá el borrador para ajustar la cantidad a entregar.`
          );
        }
        unresolved.push({ productId: it.product_id, productName: it.name, quantity: shortfallQty });
        continue;
      }

      shortfalls.push({
        productId: it.product_id,
        productCode: it.code,
        productName: it.name,
        requestedQuantity: target,
        availableAtMainLocation: availableAtMain,
        shortfallQuantity: shortfallQty,
        alternativeLocations: alternatives,
      });
    }
  }

  // Reservar y consumir lo disponible en sucursal principal
  let reservations: Array<{ reservationId: number; reservationNumber: string }> = [];
  if (reservationInputs.length > 0) {
    reservations = await reserveStockBatch(c, reservationInputs);
  }
  for (let i = 0; i < fullyDelivered.length; i++) {
    const fd = fullyDelivered[i];
    const consumeResult = await consumeReservation(c, {
      reservationId: reservations[i].reservationId,
      quantity: fd.quantity,
      consumedBy: user.id,
      movementType: 'SALIDA',
      reason: `Entrega de mercaderia ${delivery.number}`,
    });
    if (!consumeResult.success) {
      throw ApiError.conflict(`Error al consumir reserva: ${consumeResult.message}`);
    }
  }

  // Si hay faltantes, crear las órdenes de retiro (UNA POR SUCURSAL de retiro)
  let pendingOrders: DeliveryPendingOrderRef[] = [];

  if (shortfalls.length > 0) {
    const { pendingItems, unresolved: partialUnresolved } = autoAssignShortfalls(shortfalls);
    if (pendingItems.length > 0) {
      pendingOrders = await createPendingOrdersForShortfalls(
        c, user, delivery.location_id, delivery.id,
        `Faltante de entrega ${delivery.number}`, pendingItems
      );
    }
    // El sobrante que no se pudo reservar en ninguna sucursal: deuda documentada
    unresolved.push(...partialUnresolved);
  }

  // Registrar lo EFECTIVAMENTE entregado en cada item. El comprobante imprime
  // este campo como "Entregado" y la reposicion por anulacion devuelta se
  // calcula con el (si quedara la cantidad cargada original, anular una entrega
  // parcial devolveria al stock unidades que nunca salieron).
  // UPDATE multi-row con unnest: 1 query para todos los items.
  const allAffected = items.rows.map(it => it.product_id);
  await c.query(
    `UPDATE delivery_items di SET quantity_delivered = v.qty
     FROM unnest($2::int[], $3::numeric[]) AS v(pid, qty)
     WHERE di.delivery_id = $1 AND di.product_id = v.pid`,
    [id, allAffected, items.rows.map(it => deliverNowMap.get(it.product_id) ?? 0)]
  );

  const finalStatus = shortfalls.length > 0 || unresolved.length > 0 ? 'PARCIAL' : 'CONFIRMADO';
  await c.query(
    `UPDATE deliveries SET status = $1, confirmed_by = $2, confirmed_at = now(), packed_by = $3, packed_at = now() WHERE id = $4`,
    [finalStatus, user.id, user.id, id]
  );

  return {
    success: true,
    deliveryId: delivery.id,
    deliveryNumber: delivery.number,
    fullyDelivered,
    shortfalls,
    pendingDeliveries: pendingOrders,
    pendingDelivery: pendingOrders[0],
    unresolvedShortfalls: unresolved.length > 0 ? unresolved : undefined,
  };
}

export interface UserAlternativeChoice {
  productId: number;
  chosenLocationId: number;
  quantity: number;
}

export async function confirmDeliveryWithAlternatives(
  user: AuthUser, 
  ip: string | undefined, 
  id: number, 
  choices: UserAlternativeChoice[]
) {
  const result = await withTx(async (c) => {
    const delivery = await c.query<{ id: number; number: string; status: string; location_id: number; created_by: number; is_pending_delivery: boolean }>(
      'SELECT id, number, status, location_id, created_by, is_pending_delivery FROM deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!delivery.rows[0]) throw ApiError.notFound('Entrega no encontrada');
    const del = delivery.rows[0];
    if (del.status !== 'BORRADOR') throw ApiError.conflict('Solo se pueden confirmar entregas en borrador');
    if (del.is_pending_delivery) throw ApiError.conflict('Esta entrega ya reservó stock; usá la confirmación directa.');
    assertLocationAccess(user, del.location_id);
    const cfgConfAlt = await getConfirmationSetting(c, 'DELIVERY', 'CONFIRM');
    if (cfgConfAlt?.enabled && cfgConfAlt.require_different_user && !cfgConfAlt.allow_same_user) {
      if (del.created_by === user.id) {
        throw ApiError.forbidden('No podés confirmar una entrega que cargaste vos: la tiene que confirmar otra persona');
      }
    }

    const items = await c.query<{ product_id: number; quantity: string; requested_quantity: string | null; name: string; code: string }>(
      `SELECT di.product_id, di.quantity, di.requested_quantity, p.name, p.code
       FROM delivery_items di JOIN products p ON p.id = di.product_id
       WHERE di.delivery_id = $1`,
      [id]
    );

    const productIds = items.rows.map(it => it.product_id);
    const quantities = items.rows.map(it => Number(it.quantity));
    const availability = await checkMultiLocationAvailability(c, productIds, del.location_id, quantities);

    const shortfalls: DeliveryShortfall[] = [];
    const fullyDelivered: { productId: number; quantity: number }[] = [];
    const unresolved: { productId: number; productName: string; quantity: number }[] = [];
    const deliverNowMap = new Map<number, number>();
    const reservationInputs: Array<{
      referenceType: 'DELIVERY';
      referenceId: number;
      productId: number;
      sourceLocationId: number;
      quantity: number;
      reservedBy: number;
      expiresAt: Date;
    }> = [];

    for (const it of items.rows) {
      const qty = Number(it.quantity);
      // Mismo criterio que confirmDeliveryTx: el objetivo a entregar es lo
      // máximo entre lo cargado y lo facturado.
      const billed = it.requested_quantity === null ? null : Number(it.requested_quantity);
      const target = Math.max(qty, billed ?? 0);
      const avail = availability.find(a => a.productId === it.product_id);
      const availableAtMain = Number(avail?.saleLocationQty || 0);

      const deliverNow = Math.min(qty, availableAtMain);
      const shortfallQty = Math.max(0, target - availableAtMain);
      const hardShortfall = Math.max(0, qty - availableAtMain);
      deliverNowMap.set(it.product_id, deliverNow);

      if (deliverNow > 0) {
        fullyDelivered.push({ productId: it.product_id, quantity: deliverNow });
        reservationInputs.push({
          referenceType: 'DELIVERY', referenceId: del.id, productId: it.product_id,
          sourceLocationId: del.location_id, quantity: deliverNow, reservedBy: user.id,
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        });
      }

      if (shortfallQty > 0) {
        const alternatives = (avail?.otherLocations || [])
          .filter((loc: any) => Number(loc.availableQty) > 0)
          .map((loc: any) => ({
            locationId: loc.locationId, locationCode: loc.locationCode,
            locationName: loc.locationName, availableQuantity: Number(loc.availableQty),
          }));

        if (alternatives.length === 0) {
          if (hardShortfall > 0) {
            throw ApiError.conflict(
              `Stock insuficiente para "${it.name}" (${it.code}): disponible ` +
              `${availableAtMain} en sucursal de salida y no hay stock en otras ` +
              `sucursales. Modificá el borrador para ajustar la cantidad.`
            );
          }
          unresolved.push({ productId: it.product_id, productName: it.name, quantity: shortfallQty });
          continue;
        }

        shortfalls.push({
          productId: it.product_id, productCode: it.code, productName: it.name,
          requestedQuantity: target, availableAtMainLocation: availableAtMain,
          shortfallQuantity: shortfallQty, alternativeLocations: alternatives,
        });
      }
    }

    let reservations: Array<{ reservationId: number; reservationNumber: string }> = [];
    if (reservationInputs.length > 0) {
      reservations = await reserveStockBatch(c, reservationInputs);
    }
    for (let i = 0; i < fullyDelivered.length; i++) {
      const consumeResult = await consumeReservation(c, {
        reservationId: reservations[i].reservationId,
        quantity: fullyDelivered[i].quantity,
        consumedBy: user.id, movementType: 'SALIDA',
        reason: `Entrega de mercaderia ${del.number}`,
      });
      // consume_reservation devuelve success=false en vez de lanzar (stock
      // real quizas cambio por otro.Documento). Si no se valida, la entrega
      // se confirmaba SIN descontar stock y con la reserva viva bloqueando.
      if (!consumeResult.success) {
        throw ApiError.conflict(`Error al descontar stock: ${consumeResult.message}`);
      }
    }

    let pendingOrders: DeliveryPendingOrderRef[] = [];

    if (shortfalls.length > 0) {
      const choicesMap = new Map(choices.map(ch => [ch.productId, ch]));

      const pendingItems: PendingItemInput[] = [];

      for (const sf of shortfalls) {
        const choice = choicesMap.get(sf.productId);
        if (!choice) {
          throw ApiError.badRequest(`Falta elección de ubicación alternativa para ${sf.productName}`);
        }

        const alt = sf.alternativeLocations.find(a => a.locationId === choice.chosenLocationId);
        if (!alt) {
          throw ApiError.badRequest(`Ubicación elegida no válida para ${sf.productName}`);
        }

        const qtyToTake = Math.min(choice.quantity, alt.availableQuantity, sf.shortfallQuantity);
        if (qtyToTake <= 0) {
          throw ApiError.badRequest(`Cantidad inválida para ${sf.productName}`);
        }

        pendingItems.push({
          productId: sf.productId,
          quantityRequested: sf.shortfallQuantity,
          sourceLocationId: choice.chosenLocationId,
          quantityReserved: qtyToTake,
        });
        if (qtyToTake < sf.shortfallQuantity) {
          // La unidad elegida no alcanzó para todo el faltante
          unresolved.push({
            productId: sf.productId, productName: sf.productName,
            quantity: sf.shortfallQuantity - qtyToTake,
          });
        }
      }
      // createPendingDelivery valida y bloquea el stock REAL disponible
      // (quantity - reserved_quantity) de cada sucursal elegida dentro de esta
      // misma transaccion.
      pendingOrders = await createPendingOrdersForShortfalls(
        c, user, del.location_id, del.id,
        `Faltante de entrega ${del.number} - elegido por usuario`, pendingItems
      );
    }

    // Registrar lo EFECTIVAMENTE entregado (comprobante + reposición por anulación):
    // un solo UPDATE multi-row con unnest en vez de N queries
    const affected = items.rows.filter(it => deliverNowMap.has(it.product_id));
    await c.query(
      `UPDATE delivery_items di SET quantity_delivered = v.qty
       FROM unnest($2::int[], $3::numeric[]) AS v(pid, qty)
       WHERE di.delivery_id = $1 AND di.product_id = v.pid`,
      [id, affected.map(it => it.product_id), affected.map(it => deliverNowMap.get(it.product_id) ?? 0)]
    );

    const finalStatus = shortfalls.length > 0 || unresolved.length > 0 ? 'PARCIAL' : 'CONFIRMADO';
    await c.query(
      `UPDATE deliveries SET status = $1, confirmed_by = $2, confirmed_at = now(), packed_by = $3, packed_at = now() WHERE id = $4`,
      [finalStatus, user.id, user.id, del.id]
    );

    const result: DeliveryConfirmResult = {
      success: true,
      deliveryId: del.id,
      deliveryNumber: del.number,
      fullyDelivered,
      shortfalls: shortfalls.map(sf => ({
        ...sf,
        userChosenLocation: choices.find(c => c.productId === sf.productId)?.chosenLocationId,
      })),
      pendingDeliveries: pendingOrders,
      pendingDelivery: pendingOrders[0],
      unresolvedShortfalls: unresolved.length > 0 ? unresolved : undefined,
    };

    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_CONFIRM_WITH_ALTS', entity: 'delivery', entityId: id,
      details: { choices, pendingDeliveries: result.pendingDeliveries.map(o => o.number), unresolved },
      ip,
    });

    // Resolver aprobación si existía
    await c.query(
      `UPDATE approval_requests SET status = 'APROBADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'DELIVERY' AND entity_id = $2 AND status = 'PENDIENTE'`,
      [user.id, id]
    );

    return result;
  });
  await notifyUnresolvedShortfalls(user, ip, result);
  return result;
}

/**
 * Re-derivar faltantes de una entrega ya confirmada (PARCIAL o CONFIRMADO
 * con deuda facturada). Calcula cuánto queda debiendo por producto
 * (objetivo − entregado − ya prometido en órdenes de retiro vivas) y, si hay
 * stock en otras sucursales, crea las órdenes de retiro agrupadas por sucursal.
 * Así se cierra el loop después de cancelar una orden de retiro o de que
 * llegue mercadería nueva para faltantes que quedaron sin derivar.
 */
export async function rederiveShortfalls(user: AuthUser, ip: string | undefined, id: number) {
  const result = await withTx(async (c) => {
    const d = await c.query<{ id: number; number: string; status: string; location_id: number }>(
      'SELECT id, number, status, location_id FROM deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!d.rows[0]) throw ApiError.notFound('Entrega no encontrada');
    const del = d.rows[0];
    if (del.status !== 'PARCIAL' && del.status !== 'CONFIRMADO') {
      throw ApiError.conflict('Solo se pueden re-derivar faltantes de entregas confirmadas (PARCIAL o CONFIRMADO)');
    }
    assertLocationAccess(user, del.location_id);

    const items = await c.query<{ product_id: number; quantity: string; quantity_delivered: string; requested_quantity: string | null; name: string; code: string }>(
      `SELECT di.product_id, di.quantity, di.quantity_delivered, di.requested_quantity, p.name, p.code
       FROM delivery_items di JOIN products p ON p.id = di.product_id
       WHERE di.delivery_id = $1`,
      [id]
    );

    // Ya prometido por órdenes de retiro vivas de esta entrega (lo pedido
    // menos lo ya retirado de esas órdenes)
    const promised = await c.query<{ product_id: number; promised: string }>(
      `SELECT pdi.product_id, SUM(pdi.quantity_requested - pdi.quantity_delivered) AS promised
       FROM pending_delivery_items pdi
       JOIN pending_deliveries pd ON pd.id = pdi.pending_delivery_id
       WHERE pd.delivery_id = $1 AND pd.status NOT IN ('CANCELADO')
       GROUP BY pdi.product_id`,
      [id]
    );
    const promisedMap = new Map(promised.rows.map(r => [r.product_id, Number(r.promised)]));

    // Disponibilidad actual en todas las sucursales (respetando reservas)
    const productIds = items.rows.map(it => it.product_id);
    const requested = items.rows.map(it => 0); // solo se consulta disponibilidad
    const availability = await checkMultiLocationAvailability(c, productIds, del.location_id, requested);

    // Construir faltantes reales
    const newShortfalls: DeliveryShortfall[] = [];
    for (const it of items.rows) {
      const delivered = Number(it.quantity_delivered ?? it.quantity);
      const billed = it.requested_quantity === null ? null : Number(it.requested_quantity);
      // Objetivo: lo máximo entre la cantidad cargada y lo facturado.
      // (di.quantity conserva la intención original; quantity_delivered lo real)
      const target = Math.max(Number(it.quantity), billed ?? 0);
      const stillPromised = promisedMap.get(it.product_id) ?? 0;
      const owed = Math.max(0, target - delivered - stillPromised);
      if (owed <= 0) continue;

      const avail = availability.find(a => a.productId === it.product_id);
      const alternatives = (avail?.otherLocations || [])
        .filter((loc: any) => Number(loc.availableQty) > 0)
        .map((loc: any) => ({
          locationId: loc.locationId,
          locationCode: loc.locationCode,
          locationName: loc.locationName,
          availableQuantity: Number(loc.availableQty),
        }));
      if (alternatives.length === 0) continue; // nada nuevo para derivar

      newShortfalls.push({
        productId: it.product_id,
        productCode: it.code,
        productName: it.name,
        requestedQuantity: target,
        availableAtMainLocation: Number(avail?.saleLocationQty || 0),
        shortfallQuantity: owed,
        alternativeLocations: alternatives,
      });
    }

    if (newShortfalls.length === 0) {
      return { ok: true, created: [] as DeliveryPendingOrderRef[], message: 'No hay stock existente en otras sucursales.' };
    }

    const { pendingItems } = autoAssignShortfalls(newShortfalls);
    if (pendingItems.length === 0) {
      return { ok: true, created: [] as DeliveryPendingOrderRef[], message: 'No hay stock existente en otras sucursales.' };
    }

    const pendingOrders = await createPendingOrdersForShortfalls(
      c, user, del.location_id, del.id,
      `Re-derivación de faltantes de entrega ${del.number}`, pendingItems
    );

    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_REDERIVE_SHORTFALLS', entity: 'delivery', entityId: id,
      details: { pendingDeliveries: pendingOrders.map(o => o.number), shortfalls: newShortfalls }, ip,
    });

    return { ok: true, created: pendingOrders };
  });
  return result;
}

/**
 * Deuda de mercadería sin destino posible: queda registrada como alerta
 * para que ADMIN/ENCARGADO la siga (se deduplica por entidad en alerts.service).
 * Se llama DESPUÉS del commit; un fallo de alerta no revierte la entrega.
 */
async function notifyUnresolvedShortfalls(
  user: AuthUser, ip: string | undefined, result: DeliveryConfirmResult
) {
  if (!result.unresolvedShortfalls?.length) return;
  try {
    await createAlert({
      code: 'DELIVERY_UNRESOLVED_SHORTFALL',
      severity: 'WARNING',
      entityType: 'DELIVERY',
      entityId: result.deliveryId,
      title: `Deuda de mercadería sin derivar: ${result.deliveryNumber}`,
      message: result.unresolvedShortfalls
        .map(u => `${u.productName}: ${u.quantity} u. pendiente sin stock en ninguna sucursal`)
        .join(' · '),
      data: { deliveryId: result.deliveryId, deliveryNumber: result.deliveryNumber, items: result.unresolvedShortfalls },
      targetRoles: ['ADMIN', 'ENCARGADO'],
      targetLocationId: undefined,
    });
  } catch {
    // la alerta no puede bloquear la confirmación
  }
}

export interface DeliveryPickItem {
  productId: number;
  /** Lo que el picker recibió / va a despachar AHORA (≤ cantidad del borrador). */
  quantity: number;
}

export async function confirmDelivery(user: AuthUser, ip: string | undefined, id: number, pick?: DeliveryPickItem[]) {
  // Checklist de picking (mejora 10): el operador marca producto por producto
  // con lo que efectivamente recibió. pick = undefined  ->  comportamiento
  // histórico (entregar todo el stock disponible de la sucursal principal).
  const pickMap = new Map<number, number>();
  if (pick) {
    for (const p of pick) {
      if (Number(p.quantity) > 0 && pickMap.has(p.productId) === false) {
        pickMap.set(Number(p.productId), Number(p.quantity));
      }
    }
  }
  const result = await withTx(async (c) => {
    const result = await confirmDeliveryTx(c, id, user, pickMap);
    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_CONFIRM', entity: 'delivery', entityId: id,
      details: {
        pickedOnly: pick !== undefined,
        pick: pick ?? null,
        fullyDelivered: result.fullyDelivered.length,
        shortfalls: result.shortfalls.length,
        pendingDeliveries: result.pendingDeliveries.map(o => o.number),
        pendingDeliveryBarcode: result.pendingDelivery?.barcode,
        pendingDeliveryPickupLocation: result.pendingDelivery?.pickupLocationName,
        unresolvedShortfalls: result.unresolvedShortfalls,
      },
      ip,
    });
    return result;
  });
  await notifyUnresolvedShortfalls(user, ip, result);
  return result;
}

/**
 * Aprobar entrega en borrador (para flujo con aprobación)
 */
export async function approveDelivery(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    const d = await c.query<{ id: number; number: string; status: string; location_id: number; created_by: number }>(
      'SELECT id, number, status, location_id, created_by FROM deliveries WHERE id = $1 FOR UPDATE', [id]
    );
    if (!d.rows[0]) throw ApiError.notFound('Entrega no encontrada');
    if (d.rows[0].status !== 'BORRADOR') throw ApiError.conflict('Solo se pueden aprobar entregas en borrador');
    assertLocationAccess(user, d.rows[0].location_id);
    const cfgApprD = await getConfirmationSetting(c, 'DELIVERY', 'APPROVE');
    if (cfgApprD?.enabled && cfgApprD.require_different_user && !cfgApprD.allow_same_user) {
      if (d.rows[0].created_by === user.id) {
        throw ApiError.forbidden('No podés aprobar una entrega que cargaste vos: la tiene que aprobar otra persona');
      }
    }
    return confirmDeliveryTx(c, id, user);
  });
}

/**
 * Escanea el código de barras (EAN-13) de la ORDEN DE ENTREGA y devuelve la
 * entrega completa con toda la mercadería solicitada. El vendedor la usa para
 * el control: si está todo correcto acepta (confirm) directo desde el resultado;
 * si faltan unidades, el frontend sigue el flujo existente (borrador editable,
 * derivación a otra sucursal, o confirmar parcial y derivar faltantes).
 * Devuelve el contenido sin importar el estado; quien escanea muestra el
 * estado y define qué puede hacerse (BORRADOR confirmable, PARCIAL/CONFIRMADO solo consulta).
 */
export async function scanDeliveryBarcode(barcode: string) {
  return withTx(async (c) => {
    const d = await c.query<{
      id: number; number: string; status: string; location_id: number; barcode: string;
      invoice_number: string | null; notes: string | null; created_at: Date; confirmed_at: Date | null;
      location_name: string; location_code: string; created_by_name: string;
    }>(
      `SELECT d.id, d.number, d.status, d.location_id, d.barcode, d.invoice_number, d.notes,
              d.created_at, d.confirmed_at, l.name AS location_name, l.code AS location_code,
              cu.full_name AS created_by_name
       FROM deliveries d
       JOIN locations l ON l.id = d.location_id
       JOIN users cu ON cu.id = d.created_by
       WHERE d.barcode = $1`,
      [barcode]
    );
    if (!d.rows[0]) throw ApiError.notFound('No existe ninguna entrega de mercadería con ese código');
    const delivery = d.rows[0];

    const items = await c.query<{
      product_id: number; quantity: string; quantity_delivered: string | null; requested_quantity: string | null;
      code: string; name: string; unit: string; stock_avail: string | null;
    }>(
      `SELECT di.product_id, di.quantity, di.quantity_delivered, di.requested_quantity,
              p.code, p.name, p.unit,
              COALESCE(sb.quantity, 0) - COALESCE(sb.reserved_quantity, 0) AS stock_avail
       FROM delivery_items di
       JOIN products p ON p.id = di.product_id
       LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.location_id = $2
       WHERE di.delivery_id = $1
       ORDER BY di.id`,
      [delivery.id, delivery.location_id]
    );

    return {
      ...delivery,
      items: items.rows.map((it) => ({
        productId: it.product_id,
        code: it.code,
        name: it.name,
        unit: it.unit,
        quantity: Number(it.quantity),
        quantityDelivered: it.quantity_delivered === null ? null : Number(it.quantity_delivered),
        requestedQuantity: it.requested_quantity === null ? null : Number(it.requested_quantity),
        stockAvailable: Number(it.stock_avail ?? 0),
      })),
    };
  });
}

export async function getPendingDeliveryForDelivery(deliveryId: number) {
  return withTx(async (c) => {
    const deliveryNum = (
      await c.query('SELECT number FROM deliveries WHERE id = $1', [deliveryId])
    ).rows[0]?.number as string | undefined;
    if (!deliveryNum) throw ApiError.notFound('Entrega no encontrada');

    // TODAS las órdenes de retiro vivas de la entrega (pueden ser varias si
    // los faltantes se derivaron a más de una sucursal). El vínculo explícito
    // delivery_id es el primario; el LIKE por notas queda de respaldo legacy.
    const orders = await c.query<{ id: number; number: string; barcode: string; status: string; pickup_location_id: number; notes: string | null }>(
      `SELECT id, number, barcode, status, pickup_location_id, notes
       FROM pending_deliveries
       WHERE (delivery_id = $1 OR notes LIKE $2) AND status NOT IN ('CANCELADO')
       ORDER BY created_at`,
      [deliveryId, `%entrega ${deliveryNum}%`]
    );
    if (orders.rows.length === 0) return [];

    const orderIds = orders.rows.map(o => o.id);
    const items = await c.query<{
      pending_delivery_id: number; product_id: number; product_code: string; product_name: string; unit: string | null;
      quantity_requested: string; quantity_reserved: string; quantity_delivered: string;
      source_location_id: number; source_location_name: string | null;
    }>(
      `SELECT pdi.pending_delivery_id, pdi.product_id, p.code AS product_code, p.name AS product_name, p.unit,
              pdi.quantity_requested, pdi.quantity_reserved, pdi.quantity_delivered,
              pdi.source_location_id, sl.name AS source_location_name
       FROM pending_delivery_items pdi
       JOIN products p ON p.id = pdi.product_id
       LEFT JOIN locations sl ON sl.id = pdi.source_location_id
       WHERE pdi.pending_delivery_id = ANY($1)
       ORDER BY p.name`,
      [orderIds]
    );

    const itemGroups = new Map<number, typeof items.rows>();
    for (const row of items.rows) {
      const list = itemGroups.get(row.pending_delivery_id) ?? [];
      list.push(row);
      itemGroups.set(row.pending_delivery_id, list);
    }

    const pickupLocs = await c.query<{ id: number; name: string; code: string }>(
      'SELECT id, name, code FROM locations WHERE id = ANY($1)',
      [orders.rows.map(o => o.pickup_location_id)]
    );
    const locName = new Map(pickupLocs.rows.map(l => [l.id, l]));

    return orders.rows.map((o) => ({
      ...o,
      pickupLocationName: locName.get(o.pickup_location_id)?.name,
      pickupLocationCode: locName.get(o.pickup_location_id)?.code,
      items: (itemGroups.get(o.id) ?? []).map((it) => ({
        product_id: it.product_id,
        product_code: it.product_code,
        product_name: it.product_name,
        unit: it.unit,
        quantity_requested: Number(it.quantity_requested),
        quantity_reserved: Number(it.quantity_reserved),
        quantity_delivered: Number(it.quantity_delivered),
        source_location_id: it.source_location_id,
        source_location_name: it.source_location_name,
      })),
    }));
  });
}

/**
 * Anulacion con DOBLE AUTORIZACION para entregas confirmadas
 */
export async function voidDelivery(user: AuthUser, ip: string | undefined, id: number, reason: string, voidApprovedBy?: number) {
  return withTx(async (c) => {
    const d = await c.query<{ status: string; number: string; location_id: number; void_approved_by: number | null }>(
      'SELECT status, number, location_id, void_approved_by FROM deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    const delivery = d.rows[0];
    if (!delivery) throw ApiError.notFound('Entrega no encontrada');
    assertLocationAccess(user, delivery.location_id);
    if (delivery.status === 'ANULADO') throw ApiError.conflict('La entrega ya esta anulada');

    const requiresDualAuth = ['CONFIRMADO', 'PARCIAL'].includes(delivery.status);
    if (requiresDualAuth) {
      if (!voidApprovedBy) throw ApiError.badRequest('Anulación de entrega confirmada requiere segundo autorizador (voidApprovedBy)');
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

    await releaseAllReservationsForReference(c, 'DELIVERY', id, user.id, `Anulación: ${reason}`);

    // Si la entrega quedó PARCIAL, existen órdenes de retiro derivadas a otra
    // sucursal. Se cancelan para que no se pueda retirar mercadería de una
    // entrega anulada (y se liberan sus reservas en la sucursal de retiro).
    // INCLUDING: vínculo por notas (órdenes previas a la columna delivery_id):
    // sin este caso, esas órdenes quedaban vivas y se podia escanear su
    // codigo y retirar stock de una entrega anulada.
    const deliveryNum = delivery.number;
    const derivedOrders = await c.query<{ id: number; number: string; status: string }>(
      `SELECT id, number, status FROM pending_deliveries
       WHERE (delivery_id = $1 OR notes LIKE $2) AND status NOT IN ('ENTREGADO', 'CANCELADO')`,
      [id, `%entrega ${deliveryNum}%`]
    );

    // Lo ya RETIRADO fisicamente de las ordenes derivadas salio por CONSUMO de
    // reserva en la sucursal derivada (movimiento SALIDA con su source).
    // Al anular la entrega hay que devolverlo a su ubicacion de origen, si no
    // esas unidades desaparecian del sistema sin rastro.
    const derivedOut = await c.query<{ product_id: number; source_location_id: number; withdrawn: string }>(
      `SELECT pdi.product_id, pdi.source_location_id, SUM(pdi.quantity_delivered) AS withdrawn
       FROM pending_delivery_items pdi
       JOIN pending_deliveries pd ON pd.id = pdi.pending_delivery_id
       WHERE (pd.delivery_id = $1 OR pd.notes LIKE $2)
         AND pdi.quantity_delivered > 0
         AND pd.status IN ('ENTREGADO', 'PARCIAL')
       GROUP BY pdi.product_id, pdi.source_location_id`,
      [id, `%entrega ${deliveryNum}%`]
    );

    for (const od of derivedOrders.rows) {
      await cancelPendingDelivery(
        user, ip, od.id,
        `Anulación de entrega ${delivery.number}: ${reason}`,
        c,
        // El acceso a la entrega padre ya fue validado; no exigir tambien
        // acceso a la ubicación de retiro de cada orden derivada.
        { skipLocationCheck: true }
      );
    }

    if (delivery.status === 'CONFIRMADO' || delivery.status === 'PARCIAL') {
      const items = await c.query<{ product_id: number; quantity: string; quantity_delivered: string }>(
        'SELECT product_id, quantity, quantity_delivered FROM delivery_items WHERE delivery_id = $1',
        [id]
      );
      for (const it of items.rows) {
        // Restituir SOLO lo que realmente salio (quantity_delivered registra
        // lo entregado al confirmar; la cantidad cargada puede ser mayor si
        // la entrega quedó PARCIAL). Entregas previas a la columna usan
        // quantity como referencia (backfill de la migracion 012).
        const restitute = Number(it.quantity_delivered ?? it.quantity);
        if (restitute <= 0) continue;
        await applyStockChange(c, {
          productId: it.product_id,
          locationId: delivery.location_id,
          delta: restitute,
          type: 'ENTRADA',
          referenceType: 'DELIVERY',
          referenceId: id,
          referenceNumber: delivery.number,
          userId: user.id,
          reason: `Anulacion de entrega ${delivery.number}: ${reason}`,
        });
      }

      // Reponer lo retirado fisicamente en las ordenes de retiro derivadas
      // (vuelven a la sucursal de donde salieron, no a la principal).
      for (const w of derivedOut.rows) {
        await applyStockChange(c, {
          productId: w.product_id,
          locationId: w.source_location_id,
          delta: Number(w.withdrawn),
          type: 'ENTRADA',
          referenceType: 'DELIVERY',
          referenceId: id,
          referenceNumber: delivery.number,
          userId: user.id,
          reason: `Anulacion de entrega ${delivery.number}: reposición por retiro derivado`,
        });
      }
    }

    await c.query(
      `UPDATE deliveries SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2, void_approved_by = $3 WHERE id = $4`,
      [user.id, reason, voidApprovedBy ?? null, id]
    );

    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_VOID', entity: 'delivery', entityId: id,
      details: { reason, voidApprovedBy, requiresDualAuth, wasConfirmed: requiresDualAuth }, ip,
    });

    if (requiresDualAuth) {
      await createAlert({
        code: 'DELIVERY_VOID_DUAL_AUTH',
        severity: 'WARNING',
        entityType: 'DELIVERY',
        entityId: id,
        title: `Entrega anulada con doble autorización: ${delivery.number}`,
        message: `Anulada por ${user.fullName}, autorizada por usuario ${voidApprovedBy}. Motivo: ${reason}`,
        data: { deliveryId: id, voidedBy: user.id, voidApprovedBy, reason },
        targetRoles: ['ADMIN'],
      });
    }

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
  // Un solo round-trip: el total viene en cada fila con COUNT(*) OVER()
  const rows = await query<{ id: number; total?: string }>(
    `SELECT d.id, d.number, d.status, d.is_pending_delivery, d.invoice_number, d.location_id, l.name AS location_name,
            d.created_at, d.confirmed_at, d.packed_at, cu.full_name AS created_by_name,
            d.delivery_type, d.customer_name, d.delivery_address, d.driver_user_id, d.driver_assigned_at,
            d.delivered_at, d.delivery_started_at, d.due_at,
            du.full_name AS driver_name,
            (SELECT COALESCE(SUM(quantity),0) FROM delivery_items WHERE delivery_id = d.id) AS total_items,
            (SELECT COUNT(*) FROM delivery_items WHERE delivery_id = d.id) AS line_count,
            COUNT(*) OVER() AS total
     FROM deliveries d
     JOIN locations l ON l.id = d.location_id
     JOIN users cu ON cu.id = d.created_by
     LEFT JOIN users du ON du.id = d.driver_user_id
     ${whereSql}
     ORDER BY d.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`,
    params
  );
  const total = rows.rows.length > 0 && rows.rows[0].total != null ? Number(rows.rows[0].total) : 0;

  // Faltantes por entrega (solo significativos en CONFIRMADO/PARCIAL): por
  // item, objetivo = max(cargado, facturado) y quedó por entregar = objetivo -
  // entregado - lo ya retirado via órdenes de retiro derivadas (mínimo 0).
  const ids = rows.rows.map(r => r.id);
  if (ids.length > 0) {
    const agg = await query<{ delivery_id: number; shortfall_lines: string; shortfall_units: string }>(
      `SELECT oi.delivery_id,
              COUNT(*) FILTER (WHERE owed > COALESCE(wd.withdrawn, 0)) AS shortfall_lines,
              COALESCE(SUM(GREATEST(owed - COALESCE(wd.withdrawn, 0), 0)), 0) AS shortfall_units
       FROM (
         SELECT di.delivery_id, di.product_id,
                GREATEST(di.quantity, COALESCE(di.requested_quantity, di.quantity))
                  - COALESCE(di.quantity_delivered, 0) AS owed
         FROM delivery_items di
         WHERE di.delivery_id = ANY($1)
       ) oi
       LEFT JOIN (
         SELECT pd.delivery_id, pdi.product_id, SUM(pdi.quantity_delivered) AS withdrawn
         FROM pending_deliveries pd
         JOIN pending_delivery_items pdi ON pdi.pending_delivery_id = pd.id
         WHERE pd.delivery_id = ANY($1) AND pdi.quantity_delivered > 0
           AND pd.status NOT IN ('CANCELADO')
         GROUP BY pd.delivery_id, pdi.product_id
       ) wd ON wd.delivery_id = oi.delivery_id AND wd.product_id = oi.product_id
       JOIN deliveries d2 ON d2.id = oi.delivery_id
       WHERE d2.status IN ('CONFIRMADO', 'PARCIAL')
       GROUP BY oi.delivery_id`,
      [ids]
    );
    const byDelivery = new Map(agg.rows.map(r => [r.delivery_id, r]));
    for (const r of rows.rows) {
      const a = byDelivery.get(r.id);
      (r as Record<string, unknown>).shortfall_lines = a ? Number(a.shortfall_lines) : 0;
      (r as Record<string, unknown>).shortfall_units = a ? Number(a.shortfall_units) : 0;
    }
  }
  return { deliveries: rows.rows, total };
}

/**
 * Verificar disponibilidad para una entrega en borrador
 * Usado en el frontend antes de confirmar para mostrar opciones de derivación
 */
export interface AvailabilityCheckResult {
  items: {
    productId: number;
    productCode: string;
    productName: string;
    requestedQuantity: number;
    availableAtMain: number;
    shortfall: number;
    alternativeLocations: {
      locationId: number;
      locationCode: string;
      locationName: string;
      availableQuantity: number;
    }[];
  }[];
  canFullyDeliverLocally: boolean;
  hasShortfalls: boolean;
}

export async function checkDeliveryAvailability(deliveryId: number): Promise<AvailabilityCheckResult> {
  return withTx(async (c) => {
    const delivery = await c.query<{ id: number; location_id: number }>(
      'SELECT id, location_id FROM deliveries WHERE id = $1',
      [deliveryId]
    );
    if (!delivery.rows[0]) throw new Error('Entrega no encontrada');
    
    const items = await c.query<{
      product_id: number; quantity: string; requested_quantity: string | null; name: string; code: string;
    }>(
      `SELECT di.product_id, di.quantity, di.requested_quantity, p.name, p.code
       FROM delivery_items di JOIN products p ON p.id = di.product_id
       WHERE di.delivery_id = $1`,
      [deliveryId]
    );

    const productIds = items.rows.map((it) => it.product_id);
    const quantities = items.rows.map((it) => Number(it.quantity));
    
    const availability = await checkMultiLocationAvailability(c, productIds, delivery.rows[0].location_id, quantities) as any[];

  const resultItems = items.rows.map(it => {
    const qty = Number(it.quantity);
    const billed = it.requested_quantity === null ? null : Number(it.requested_quantity);
    const avail = availability.find(a => a.productId === it.product_id);
    const availableAtMain = Number(avail?.saleLocationQty || 0);
    // Objetivo total: lo máximo entre lo que se intenta entregar y lo facturado.
    // Si se facturaron 105 y hay 98 en la sucursal, el faltante es 7 aunque
    // `quantity` también valga 98 (caso: se entrega todo el stock local).
    const target = Math.max(qty, billed ?? 0);
    const shortfall = Math.max(0, target - availableAtMain);
    
    return {
      productId: it.product_id,
      productCode: it.code,
      productName: it.name,
      requestedQuantity: target,
      availableAtMain,
      shortfall,
      alternativeLocations: (avail?.otherLocations || [])
        .filter((loc: any) => Number(loc.availableQty) > 0)
        .map((loc: any) => ({
          locationId: loc.locationId,
          locationCode: loc.locationCode,
          locationName: loc.locationName,
          availableQuantity: Number(loc.availableQty),
        }))
    };
  });

  return {
    items: resultItems,
    canFullyDeliverLocally: resultItems.every(i => i.shortfall === 0),
    hasShortfalls: resultItems.some(i => i.shortfall > 0)
  };
  });
}