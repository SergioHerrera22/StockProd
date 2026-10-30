#!/usr/bin/env node
/**
 * Escenario de negocio: faltante por factura y derivación a otra sucursal.
 *
 * Regla: el objetivo a entregar es lo máximo entre `quantity` (lo que se pide
 * entregar ahora) y `requestedQuantity` (lo facturado). Si la sucursal de
 * salida no cubre ese objetivo, la diferencia se deriva a otra sucursal que
 * tenga stock y se genera una orden de retiro (comprobante con código de barras).
 *
 * Caso: stock en DEP = 98, se entrega 98, se facturaron 105 -> derivar 7.
 *
 * Requiere el backend corriendo en http://localhost:4000 (o RS_BASE).
 * Uso: node tests/scenario-shortfall-derivation.mjs
 */
const BASE = process.env.RS_BASE ?? 'http://localhost:4000/api';

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); }
  else { failed++; console.error(`  ✘ ${label}`); }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* vacio */ }
  return { status: res.status, json };
}

function stockAt(stock, locationId) {
  return Number(stock.find((s) => s.location_id === locationId)?.quantity ?? NaN);
}

/** Crea un producto y deja `depQty` en DEP y `sucQty` en SUC1 (entradas confirmadas). */
let productSeq = 0;
async function createProductWithStock(T, TE, dep, suc1, stamp, depQty, sucQty, supplierId) {
  const seq = productSeq++;
  const prod = await api('POST', '/products', {
    token: T,
    body: {
      code: `FALT-${stamp}-${seq}`,
      // EAN-13 de 13 digitos: 79 + 10 digitos del sello + 1 de secuencia.
      // (concatenar stamp crudo y recortar producia colisiones entre productos
      // creados en el mismo milisegundo)
      barcode: `79${String(stamp % 1e10).padStart(10, '0')}${seq % 10}`,
      name: `Producto faltante ${stamp} ${seq}`,
      brand: 'TestBrand',
      unit: 'UNIDAD',
      minStock: 0,
      cost: 1000,
    },
  });
  if (prod.status !== 201 || !prod.json.id) throw new Error('No se pudo crear el producto: ' + JSON.stringify(prod.json));
  const pid = prod.json.id;

  for (const [loc, qty] of [[dep, depQty], [suc1, sucQty]]) {
    const entry = await api('POST', '/entries', {
      token: T,
      body: { locationId: loc.id, type: 'COMPRA', supplierId, items: [{ productId: pid, quantity: qty, unitCost: 1000 }] },
    });
    const confirmed = await api('POST', `/entries/${entry.json.id}/confirm`, { token: TE });
    if (entry.status !== 201 || confirmed.status !== 200) {
      throw new Error(`Entrada de ${qty} en loc ${loc.id} falló: ${entry.status}/${confirmed.status} ${JSON.stringify(confirmed.json)}`);
    }
  }
  return pid;
}

async function main() {
  console.log(`\n== Escenario: faltante de factura + derivacion + orden de retiro ==\n`);
  console.log(`Contra ${BASE}\n`);

  // ---------- Preparacion ----------
  console.log('[1] Login y ubicaciones');
  const login = await api('POST', '/auth/login', { body: { username: 'admin', password: process.env.SMOKE_ADMIN_PASSWORD ?? 'robles2026' } });
  ok(login.status === 200 && login.json.token, 'Login admin OK');
  const T = login.json.token;

  const encargLogin = await api('POST', '/auth/login', { body: { username: 'encargado_smoke', password: 'encargado123' } });
  const TE = encargLogin.status === 200 ? encargLogin.json.token : T;
  ok(TE !== T, 'Encargado disponible para segregacion de funciones');

  const locs = (await api('GET', '/locations', { token: T })).json.locations;
  const dep = locs.find((l) => l.code === 'DEP');
  const suc1 = locs.find((l) => l.code === 'SUC1');
  ok(!!dep && !!suc1, 'Deposito y sucursal presentes');

  const stamp = Date.now();
  const supplierCreated = await api('POST', '/suppliers', { token: T, body: { name: `Proveedor Escenario ${stamp}` } });
  const supplierId = supplierCreated.json?.id;
  if (supplierCreated.status !== 201 || !supplierId) throw new Error('No se pudo crear el proveedor de prueba');

  // ---------- Producto y stock: 98 en DEP, 10 en SUC1 ----------
  console.log('[2] Producto con 98 en DEP y 10 en SUC1');
  const pid = await createProductWithStock(T, TE, dep, suc1, stamp, 98, 10, supplierId);
  ok(true, 'Producto creado con 98 en DEP y 10 en SUC1');

  let stock = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(stockAt(stock, dep.id) === 98, 'Stock DEP = 98');
  ok(stockAt(stock, suc1.id) === 10, 'Stock SUC1 = 10');

  // ---------- Borrador: entregar 98, facturado 105 ----------
  console.log('[3] Entrega: quantity=98 (todo el stock) y requestedQuantity=105 (facturado)');
  const draft = await api('POST', '/deliveries', {
    token: T,
    body: {
      locationId: dep.id,
      invoiceNumber: `0001-${stamp}`,
      items: [{ productId: pid, quantity: 98, requestedQuantity: 105 }],
    },
  });
  ok(draft.status === 201 && draft.json.number?.startsWith('E-'), `Borrador ${draft.json?.number} creado`);
  const deliveryId = draft.json.id;

  // El borrador no descuenta stock
  stock = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(stockAt(stock, dep.id) === 98, 'Borrador NO descuenta stock');

  // ---------- Verificacion de disponibilidad (la que abre el modal) ----------
  console.log('[4] GET /deliveries/:id/check-availability');
  const avail = await api('GET', `/deliveries/${deliveryId}/check-availability`, { token: T });
  ok(avail.status === 200, 'La ruta check-availability responde 200 (antes daba 404)');
  const item = avail.json?.items?.find((i) => i.productId === pid);
  ok(item?.requestedQuantity === 105, 'Objetivo = 105 (lo facturado)');
  ok(item?.availableAtMain === 98, 'Disponible en la sucursal de salida = 98');
  ok(item?.shortfall === 7, 'Faltante detectado = 7 (105 - 98)');
  ok(avail.json?.hasShortfalls === true, 'hasShortfalls = true');
  ok(avail.json?.canFullyDeliverLocally === false, 'canFullyDeliverLocally = false');
  ok(
    item?.alternativeLocations?.some((a) => a.locationId === suc1.id && a.availableQuantity === 10),
    'SUC1 figura como alternativa con 10 disponibles'
  );

  // ---------- Confirmacion con derivacion elegida ----------
  console.log('[5] POST /deliveries/:id/confirm-with-alternatives (derivar 7 a SUC1)');
  const confirm = await api('POST', `/deliveries/${deliveryId}/confirm-with-alternatives`, {
    token: TE,
    body: { choices: [{ productId: pid, chosenLocationId: suc1.id, quantity: 7 }] },
  });
  if (confirm.status !== 200) console.error('    -> respuesta:', JSON.stringify(confirm.json));
  ok(confirm.status === 200, 'Confirmacion con alternativas OK');
  ok(confirm.json?.deliveryNumber === draft.json.number, 'Responde el numero de entrega');
  ok(confirm.json?.shortfalls?.[0]?.shortfallQuantity === 7, 'Faltante derivado = 7');
  ok(confirm.json?.pendingDelivery?.number?.startsWith('PD-') || !!confirm.json?.pendingDelivery?.id, 'Se genero orden de retiro');
  ok(!!confirm.json?.pendingDelivery?.barcode, 'La orden de retiro tiene codigo de barras');
  ok(confirm.json?.pendingDelivery?.pickupLocationId === suc1.id, 'pickupLocationId = SUC1 (antes guardaba el id de la orden)');
  ok(confirm.json?.pendingDelivery?.pickupLocationName === suc1.name, `pickupLocationName = "${suc1.name}" (antes quedaba vacio)`);

  // ---------- Estados de stock ----------
  console.log('[6] Stock tras confirmar');
  const del = (await api('GET', `/deliveries/${deliveryId}`, { token: T })).json.delivery;
  ok(del.status === 'PARCIAL', 'Entrega en estado PARCIAL (recepcion parcial en curso)');

  stock = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(stockAt(stock, dep.id) === 0, 'DEP bajo a 0 (salieron los 98)');
  ok(stockAt(stock, suc1.id) === 10, 'SUC1 sigue en 10 (las 7 estan reservadas, no descontadas hasta el retiro)');

  const scan = await api('GET', `/pending-deliveries/scan/${confirm.json.pendingDelivery.barcode}`, { token: TE });
  ok(scan.status === 200, 'La orden se puede escanear por codigo de barras');
  const scanItems = scan.json?.items ?? scan.json?.order?.items ?? [];
  ok(
    scanItems.some((i) => Number(i.productId ?? i.product_id) === pid && Number(i.quantityReserved ?? i.quantity_reserved) === 7),
    'La orden reserva 7 unidades del producto en SUC1'
  );

  // ---------- Doble confirmacion bloqueada ----------
  console.log('[7] Idempotencia');
  const doubleConfirm = await api('POST', `/deliveries/${deliveryId}/confirm`, { token: TE });
  ok(doubleConfirm.status === 409, 'Doble confirmacion bloqueada (409) aunque estado sea PARCIAL');
  stock = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(stockAt(stock, dep.id) === 0, 'Doble confirm NO volvio a descontar');

  // ---------- Retiro en la sucursal ----------
  console.log('[8] POST /pending-deliveries/confirm-pickup (cliente retira en SUC1)');
  const pickup = await api('POST', '/pending-deliveries/confirm-pickup', {
    token: TE,
    body: {
      barcode: confirm.json.pendingDelivery.barcode,
      items: [{ productId: pid, quantityDelivered: 7 }],
    },
  });
  ok(pickup.status === 200, 'Retiro confirmado');

  stock = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(stockAt(stock, suc1.id) === 3, 'SUC1 bajo a 3 (10 - 7 retiradas)');
  ok(stockAt(stock, dep.id) === 0, 'DEP sigue en 0');

  // ---------- Balance final ----------
  console.log('[9] Balance final');
  const total = stock.reduce((s, r) => s + Number(r.quantity), 0);
  ok(total === 3, 'Total global = 3 (98 entregados en DEP + 7 retirados en SUC1 = 105 facturados)');
  ok(98 + 7 === 105, 'Cuadra: 98 (DEP) + 7 (SUC1) = 105 facturados');

  // ---------- Anulacion de la entrega PARCIAL ----------
  console.log('[10] Anular la entrega PARCIAL cancela la orden de retiro');
  // Producto aparte: el anterior ya tiene el stock de SUC1 consumido por el retiro.
  const pid2 = await createProductWithStock(T, TE, dep, suc1, stamp + 1, 98, 10);
  ok(true, 'Producto nuevo con 98 en DEP y 10 en SUC1');

  const draft2 = await api('POST', '/deliveries', {
    token: T,
    body: {
      locationId: dep.id,
      invoiceNumber: `0002-${stamp}`,
      items: [{ productId: pid2, quantity: 98, requestedQuantity: 105 }],
    },
  });
  ok(draft2.status === 201, `Segundo borrador ${draft2.json?.number} creado`);

  const confirm2 = await api('POST', `/deliveries/${draft2.json.id}/confirm-with-alternatives`, {
    token: TE,
    body: { choices: [{ productId: pid2, chosenLocationId: suc1.id, quantity: 7 }] },
  });
  ok(confirm2.status === 200, 'Segunda entrega confirmada con derivacion');
  ok(!!confirm2.json?.pendingDelivery?.id, 'Se genero una segunda orden de retiro');

  const voidRes = await api('POST', `/deliveries/${draft2.json.id}/void`, {
    token: TE,
    body: { reason: 'Anulacion del escenario de prueba', voidApprovedBy: 1 },
  });
  ok(voidRes.status === 200, 'Anulacion de la entrega PARCIAL aceptada (doble autorizacion)');

  const voided = (await api('GET', `/deliveries/${draft2.json.id}`, { token: T })).json.delivery;
  ok(voided.status === 'ANULADO', 'Entrega en estado ANULADO');

  const orderAfterVoid = await api('GET', `/pending-deliveries/scan/${confirm2.json.pendingDelivery.barcode}`, { token: T });
  const orderStatus = orderAfterVoid.json?.status ?? orderAfterVoid.json?.order?.status;
  ok(orderStatus === 'CANCELADO', `La orden de retiro derivada quedo CANCELADO (estado: ${orderStatus})`);

  stock = (await api('GET', `/products/${pid2}`, { token: T })).json.stock;
  ok(stockAt(stock, dep.id) === 98, 'DEP repuesto a 98 por la anulacion');
  ok(stockAt(stock, suc1.id) === 10, 'SUC1 repuesto a 10 (reservas de la orden liberadas)');

  const pickupAfterVoid = await api('POST', '/pending-deliveries/confirm-pickup', {
    token: TE,
    body: {
      barcode: confirm2.json.pendingDelivery.barcode,
      items: [{ productId: pid2, quantityDelivered: 7 }],
    },
  });
  ok(pickupAfterVoid.status !== 200, 'Retiro sobre orden cancelada rechazado');

  console.log(`\n== Resultado: ${passed} OK, ${failed} FALLIDOS ==\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\nError fatal:', e);
  process.exit(1);
});
