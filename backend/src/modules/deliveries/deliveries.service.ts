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

export interface DeliveryConfirmResult {
  success: boolean;
  deliveryId: number;
  deliveryNumber: string;
  fullyDelivered: { productId: number; quantity: number }[];
  shortfalls: DeliveryShortfall[];
  pendingDelivery?: {
    id: number;
    number: string;
    barcode: string;
    pickupLocationId: number;
    pickupLocationName: string;
  };
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
            pu.full_name AS packed_by_name, vau.full_name AS void_approved_by_name
     FROM deliveries d
     JOIN locations l ON l.id = d.location_id
     JOIN users cu ON cu.id = d.created_by
     LEFT JOIN users vu ON vu.id = d.confirmed_by
     LEFT JOIN users pu ON pu.id = d.packed_by
     LEFT JOIN users vau ON vau.id = d.void_approved_by
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

    const qtySum = input.items.reduce((s, it) => s + it.quantity, 0);
    const context = { qty_sum: qtySum, location_id: input.locationId, user_role: user.role };

    // Evaluar reglas ANTES de crear
    const rules = await evaluateBusinessRules('DELIVERY', 'BEFORE_CREATE', context);
    const requiresApproval = rules.some(r => r.action.require_approval);
    let status: 'BORRADOR' | 'CONFIRMADO' | 'PARCIAL' = 'BORRADOR';

    const number = await nextDocNumber(c, 'delivery');
    const r = await c.query<{ id: number }>(
      `INSERT INTO deliveries (number, location_id, invoice_number, notes, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [number, input.locationId, input.invoiceNumber?.trim() || null, input.notes?.trim() || null, user.id, status]
    );
    const deliveryId = r.rows[0].id;

    for (const it of input.items) {
      await c.query(
        `INSERT INTO delivery_items (delivery_id, product_id, quantity, requested_quantity)
         VALUES ($1,$2,$3,$4)`,
        [deliveryId, it.productId, it.quantity, it.requestedQuantity ?? null]
      );
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
      });
      await writeAudit(c, { userId: user.id, action: 'DELIVERY_CREATE_PENDING_APPROVAL', entity: 'delivery', entityId: deliveryId, details: { number, requiresApproval: true }, ip });
      return { id: deliveryId, number, status: 'BORRADOR', requiresApproval: true };
    }

    if (confirm) {
      await confirmDeliveryTx(c, deliveryId, user);
    } else {
      await writeAudit(c, { userId: user.id, action: 'DELIVERY_CREATE_DRAFT', entity: 'delivery', entityId: deliveryId, details: { number }, ip });
    }

    return { id: deliveryId, number, status: confirm ? 'CONFIRMADO' : 'BORRADOR', requiresApproval: false };
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
    await writeAudit(c, { userId: user.id, action: 'DELIVERY_UPDATE_DRAFT', entity: 'delivery', entityId: id, ip });
    return { id, number: d.rows[0].number };
  });
}

/** Confirmacion transaccional con manejo de faltantes multi-sucursal. */
async function confirmDeliveryTx(c: PoolClient, id: number, user: AuthUser): Promise<DeliveryConfirmResult> {
  const d = await c.query<{ id: number; number: string; status: string; location_id: number; created_by: number }>(
    'SELECT id, number, status, location_id, created_by FROM deliveries WHERE id = $1 FOR UPDATE',
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

  // Segregación de funciones: quien confirma NO debe ser quien creó el borrador.
  if (delivery.created_by === user.id) {
    throw ApiError.forbidden('No puedes confirmar una entrega que tú mismo creaste (segregación de funciones)');
  }

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

    // Lo que efectivamente sale de esta sucursal
    const deliverNow = Math.min(qty, availableAtMain);
    // Faltante total a derivar para completar lo facturado / lo pedido
    const shortfallQty = Math.max(0, target - availableAtMain);
    // Faltante duro: lo que el operador pidió entregar ahora y no hay stock
    const hardShortfall = Math.max(0, qty - availableAtMain);

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

      if (alternatives.length === 0) {
        // Sin dónde derivar. Si además no se pudo entregar lo que se pidió
        // ahora, la entrega no se puede cumplir -> 409. Si lo pedido se
        // entregó completo y solo falta lo facturado de más, se entrega igual
        // (no hay mercadería que derivar).
        if (hardShortfall > 0) {
          throw ApiError.conflict(
            `Stock insuficiente para "${it.name}" (${it.code}): ` +
            `disponible ${availableAtMain} en sucursal principal, ` +
            `requerido ${qty}, y no hay stock en otras sucursales`
          );
        }
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

  // Si hay faltantes, crear entrega pendiente
  let pendingDelivery: DeliveryConfirmResult['pendingDelivery'] = undefined;
  
  if (shortfalls.length > 0) {
    const pendingItems: Array<{
      productId: number;
      quantityRequested: number;
      sourceLocationId: number;
      quantityReserved: number;
    }> = shortfalls.map(sf => {
      const bestAlternative = sf.alternativeLocations.reduce((best, current) => 
        current.availableQuantity > best.availableQuantity ? current : best
      );
      return {
        productId: sf.productId,
        quantityRequested: sf.shortfallQuantity,
        sourceLocationId: bestAlternative.locationId,
        quantityReserved: Math.min(sf.shortfallQuantity, bestAlternative.availableQuantity),
      };
    });

    const pd = await createPendingDelivery(user, undefined, {
      saleLocationId: delivery.location_id,
      pickupLocationId: pendingItems[0].sourceLocationId,
      customerName: undefined,
      customerPhone: undefined,
      customerDocument: undefined,
      notes: `Faltante de entrega ${delivery.number}`,
      deliveryId: delivery.id,
      items: pendingItems,
    }, c);
    
    pendingDelivery = {
      id: pd.id,
      number: pd.number,
      barcode: pd.barcode,
      pickupLocationId: pendingItems[0].sourceLocationId,
      pickupLocationName: shortfalls[0].alternativeLocations.find(a => a.locationId === pendingItems[0].sourceLocationId)?.locationName || '',
    };
  }

  const finalStatus = shortfalls.length > 0 ? 'PARCIAL' : 'CONFIRMADO';
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
    pendingDelivery,
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
  return withTx(async (c) => {
    const delivery = await c.query<{ id: number; number: string; status: string; location_id: number; created_by: number }>(
      'SELECT id, number, status, location_id, created_by FROM deliveries WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!delivery.rows[0]) throw ApiError.notFound('Entrega no encontrada');
    const del = delivery.rows[0];
    if (del.status !== 'BORRADOR') throw ApiError.conflict('Solo se pueden confirmar entregas en borrador');
    if (del.created_by === user.id) throw ApiError.forbidden('No puedes confirmar una entrega que tú mismo creaste (segregación de funciones)');
    assertLocationAccess(user, del.location_id);

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
            throw ApiError.conflict(`Sin stock alternativo para ${it.name}`);
          }
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
      await consumeReservation(c, {
        reservationId: reservations[i].reservationId,
        quantity: fullyDelivered[i].quantity,
        consumedBy: user.id, movementType: 'SALIDA',
        reason: `Entrega de mercaderia ${del.number}`,
      });
    }

    let pendingDelivery: DeliveryConfirmResult['pendingDelivery'] = undefined;
    
    if (shortfalls.length > 0) {
      const choicesMap = new Map(choices.map(ch => [ch.productId, ch]));
      
      const pendingItems: Array<{
        productId: number;
        quantityRequested: number;
        sourceLocationId: number;
        quantityReserved: number;
      }> = [];

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

        // Bloquear la fila para que nadie tome el stock entre este chequeo y
        // la insercion de la reserva (misma transaccion que createPendingDelivery).
        const stock = await c.query<{ quantity: string }>(
          `SELECT quantity FROM stock_balances WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
          [sf.productId, choice.chosenLocationId]
        );
        const realStock = Number(stock.rows[0]?.quantity || 0);
        if (realStock < qtyToTake) {
          throw ApiError.conflict(`Stock insuficiente en ubicación elegida para ${sf.productName}`);
        }

        pendingItems.push({
          productId: sf.productId,
          quantityRequested: sf.shortfallQuantity,
          sourceLocationId: choice.chosenLocationId,
          quantityReserved: qtyToTake,
        });
      }

      const pickupLocationId = pendingItems[0]?.sourceLocationId || del.location_id;
      
      // createPendingDelivery inserta la reserva con pending_delivery_id (lo que
      // busca confirmPickup). Se le pasa la transaccion exterior para que todo
      // quede atomico y no se produzca un deadlock entre conexiones.
      const pd = await createPendingDelivery(user, undefined, {
        saleLocationId: del.location_id,
        pickupLocationId,
        customerName: undefined,
        customerPhone: undefined,
        customerDocument: undefined,
        notes: `Faltante de entrega ${del.number} - elegido por usuario`,
        deliveryId: del.id,
        items: pendingItems,
      }, c);

      const chosenLocation = shortfalls
        .flatMap(sf => sf.alternativeLocations)
        .find(a => a.locationId === pickupLocationId);

      pendingDelivery = {
        id: pd.id, number: pd.number, barcode: pd.barcode,
        pickupLocationId,
        pickupLocationName: chosenLocation?.locationName || '',
      };
    }

    const finalStatus = shortfalls.length > 0 ? 'PARCIAL' : 'CONFIRMADO';
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
      pendingDelivery,
    };

    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_CONFIRM_WITH_ALTS', entity: 'delivery', entityId: id,
      details: { choices, pendingDelivery: pendingDelivery?.number }, ip,
    });

    // Resolver aprobación si existía
    await c.query(
      `UPDATE approval_requests SET status = 'APROBADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'DELIVERY' AND entity_id = $2 AND status = 'PENDIENTE'`,
      [user.id, id]
    );

    return result;
  });
}

export async function confirmDelivery(user: AuthUser, ip: string | undefined, id: number) {
  return withTx(async (c) => {
    const result = await confirmDeliveryTx(c, id, user);
    await writeAudit(c, {
      userId: user.id, action: 'DELIVERY_CONFIRM', entity: 'delivery', entityId: id, 
      details: { 
        fullyDelivered: result.fullyDelivered.length,
        shortfalls: result.shortfalls.length,
        pendingDelivery: result.pendingDelivery?.number,
        pendingDeliveryBarcode: result.pendingDelivery?.barcode,
        pendingDeliveryPickupLocation: result.pendingDelivery?.pickupLocationName
      }, 
      ip,
    });
    return result;
  });
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
    if (d.rows[0].created_by === user.id) throw ApiError.forbidden('No puedes aprobar tu propia entrega (segregación de funciones)');
    assertLocationAccess(user, d.rows[0].location_id);
    return confirmDeliveryTx(c, id, user);
  });
}

export async function getPendingDeliveryForDelivery(deliveryId: number) {
  return withTx(async (c) => {
    const pd = await c.query<{ id: number; number: string; barcode: string; status: string; pickup_location_id: number }>(
      `SELECT id, number, barcode, status, pickup_location_id 
       FROM pending_deliveries 
       WHERE notes LIKE $1 
       ORDER BY created_at DESC LIMIT 1`,
      [`%entrega ${(await c.query('SELECT number FROM deliveries WHERE id = $1', [deliveryId])).rows[0]?.number}%`]
    );
    if (!pd.rows[0]) return null;
    
    const pickupLoc = await c.query('SELECT name, code FROM locations WHERE id = $1', [pd.rows[0].pickup_location_id]);
    return {
      ...pd.rows[0],
      pickupLocationName: pickupLoc.rows[0]?.name,
      pickupLocationCode: pickupLoc.rows[0]?.code,
    };
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
    const derivedOrders = await c.query<{ id: number; number: string; status: string }>(
      `SELECT id, number, status FROM pending_deliveries
       WHERE delivery_id = $1 AND status NOT IN ('ENTREGADO', 'CANCELADO')`,
      [id]
    );
    for (const od of derivedOrders.rows) {
      await cancelPendingDelivery(
        user, ip, od.id,
        `Anulación de entrega ${delivery.number}: ${reason}`,
        c
      );
    }

    if (delivery.status === 'CONFIRMADO' || delivery.status === 'PARCIAL') {
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
  const count = await query<{ total: string }>(`SELECT COUNT(*) total FROM deliveries d ${whereSql}`, params);
  const rows = await query(
    `SELECT d.id, d.number, d.status, d.invoice_number, d.location_id, l.name AS location_name,
           d.created_at, d.confirmed_at, d.packed_at, cu.full_name AS created_by_name,
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