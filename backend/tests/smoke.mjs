#!/usr/bin/env node
/**
 * Prueba de humo end-to-end del Sistema Robles Stock.
 * Requiere el backend corriendo en http://localhost:4000 (por defecto).
 * Uso: node tests/smoke.mjs   (o RS_BASE=http://localhost:XXXX/api node tests/smoke.mjs)
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

async function main() {
  console.log(`\n== Prueba de humo contra ${BASE} ==\n`);

  // ---------- Salud ----------
  console.log('[1] Salud y login');
  const health = await api('GET', '/health');
  ok(health.status === 200 && health.json.db === 'ok', 'Health check con base de datos');

  const badLogin = await api('POST', '/auth/login', { body: { username: 'admin', password: 'incorrecta' } });
  ok(badLogin.status === 401, 'Rechaza credenciales invalidas (401)');

  const login = await api('POST', '/auth/login', { body: { username: 'admin', password: process.env.SMOKE_ADMIN_PASSWORD ?? 'robles2026' } });
  ok(login.status === 200 && login.json.token, 'Login admin OK');
  const T = login.json.token;

  // Crear usuario encargado para operaciones que requieren segregación de funciones (confirmar entradas creadas por admin)
  try {
    await api('POST', '/users', {
      token: T,
      body: { username: 'encargado_smoke', fullName: 'Encargado Smoke', role: 'ENCARGADO', password: 'encargado123' },
    });
  } catch { /* ya existe */ }
  const encargLogin = await api('POST', '/auth/login', { body: { username: 'encargado_smoke', password: 'encargado123' } });
  const TE = encargLogin.status === 200 ? encargLogin.json.token : T;
  ok(TE !== T, 'Encargado disponible para segregación de funciones');

  const me = await api('GET', '/auth/me', { token: T });
  ok(me.json?.user?.role === 'ADMIN', 'GET /auth/me devuelve rol');

  const noAuth = await api('GET', '/products');
  ok(noAuth.status === 401, 'Bloquea acceso sin token (401)');

  // ---------- Ubicaciones ----------
  console.log('[2] Ubicaciones');
  const locs = (await api('GET', '/locations', { token: T })).json.locations;
  ok(locs.length >= 4, 'Existen al menos 4 ubicaciones');
  const dep = locs.find((l) => l.code === 'DEP');
  // Ubicaciones resilientes: no exigir codigos exactos (los nombres/codigos
  // reales cambian con el uso del sistema). Cualquier ubicacion que NO sea el
  // deposito sirve de sucursal destino.
  const suc1 = locs.find((l) => l.id !== dep?.id) ?? locs.find((l) => l.code === 'SUC1');
  const suc2 = locs.find((l) => l.id !== dep?.id && l.id !== suc1?.id) ?? locs.find((l) => l.code === 'SUC2');
  ok(dep && suc1 && suc2, 'Depósito y sucursales presentes');

  // ---------- Productos ----------
  console.log('[3] Productos');
  const stamp = Date.now();
  const prodBody = {
    code: `SMK-${stamp}`,
    barcode: `77${stamp}`.slice(0, 13),
    name: `Pintura Smoke Test ${stamp}`,
    brand: 'TestBrand',
    unit: 'UNIDAD',
    minStock: 5,
    cost: 1000,
  };
  const created = await api('POST', '/products', { token: T, body: prodBody });
  ok(created.status === 201 && created.json.id, 'Producto creado');
  const pid = created.json.id;
  const supplierCreated = await api('POST', '/suppliers', { token: T, body: { name: `Proveedor Smoke ${stamp}` } });
  const supplierId = supplierCreated.json?.id;
  ok(supplierCreated.status === 201 && supplierId, 'Proveedor maestro creado');

  const dup = await api('POST', '/products', { token: T, body: prodBody });
  ok(dup.status === 409, 'Rechaza código duplicado (409)');

  const prodDetail = await api('GET', `/products/${pid}`, { token: T });
  ok(prodDetail.json.stock.length >= 4, 'Detalle de producto muestra stock por ubicación');
  ok(prodDetail.json.stock.every((s) => Number(s.quantity) === 0), 'Stock inicial en cero en todas las ubicaciones');

  // ---------- Importación tolerante al formato ----------
  console.log('[3b] Importación con espacios, filas vacías y duplicados');
  const impCode = `SMKIMP-${stamp}`;
  const imp = await api('POST', '/products/import', {
    token: T,
    body: {
      updateExisting: false,
      rows: [
        { code: `  ${impCode}  `, name: `  Pintura   Importada   Test  `, brand: ' Marca X ' },   // espacios de relleno
        { code: '   ', name: '  ' },                                                              // fila vacía → ignorada
        { code: impCode, name: 'Duplicado en archivo' },                                          // duplicado → omitido
        { code: '', name: 'Producto sin código' },                                                // error
        { code: `COD3-${stamp}`, name: '' },                                                      // sin nombre → usa el código
      ],
    },
  });
  ok(
    imp.status === 200 &&
      imp.json.created === 2 &&
      imp.json.skipped === 1 &&
      imp.json.duplicatesInFile === 1 &&
      imp.json.errors.length === 1,
    `Importación: creados=${imp.json.created}, ignoradas=${imp.json.skipped}, duplicados=${imp.json.duplicatesInFile}, errores=${imp.json.errors.length}`
  );
  const impCheck = (await api('GET', `/products?q=${impCode}`, { token: T })).json;
  const impProd = impCheck.products?.[0];
  ok(impProd && impProd.code === impCode, 'Código normalizado (sin espacios de relleno)');
  ok(impProd && impProd.name === 'Pintura Importada Test', 'Nombre normalizado (sin espacios dobles)');
  const imp2 = (await api('GET', `/products?q=COD3-${stamp}`, { token: T })).json;
  ok(imp2.products?.[0]?.name === `COD3-${stamp}`, 'Fila sin nombre usa el código como nombre');

  // ---------- Entrada ----------
  console.log('[4] Entrada de mercadería');
  const entry = await api('POST', '/entries', {
    token: T,
    body: { locationId: dep.id, type: 'COMPRA', supplierId, items: [{ productId: pid, quantity: 100, unitCost: 1000 }] },
  });
  ok(entry.status === 201 && entry.json.number.startsWith('I-'), `Entrada borrador ${entry.json?.number} creada`);
  // Confirmar con el encargado (segregación de funciones: admin no puede confirmar su propia entrada)
  const entryConfirm = await api('POST', `/entries/${entry.json.id}/confirm`, { token: TE });
  ok(entryConfirm.status === 200, `Entrada confirmada por encargado`);

  const afterEntry = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  const depQty = Number(afterEntry.find((s) => s.location_id === dep.id)?.quantity ?? -1);
  ok(depQty === 100, 'Stock del depósito = 100 luego de la entrada');

  // ---------- Entrega: borrador NO descuenta ----------
  console.log('[5] Entrega de mercadería');
  const draft = await api('POST', '/deliveries', {
    token: T,
    body: { locationId: dep.id, invoiceNumber: '0001-00012345', items: [{ productId: pid, quantity: 3, requestedQuantity: 8 }] },
  });
  ok(draft.status === 201 && draft.json.number.startsWith('E-'), `Borrador ${draft.json?.number} creado`);

  let stockNow = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(Number(stockNow.find((s) => s.location_id === dep.id)?.quantity) === 100, 'El borrador NO descuenta stock');

  const confirm = await api('POST', `/deliveries/${draft.json.id}/confirm`, { token: TE });
  ok(confirm.status === 200, 'Entrega confirmada por encargado');

  stockNow = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(Number(stockNow.find((s) => s.location_id === dep.id)?.quantity) === 97, 'Confirmación descontó 3 (de 8 facturadas, entregar 3)');

  const doubleConfirm = await api('POST', `/deliveries/${draft.json.id}/confirm`, { token: TE });
  ok(doubleConfirm.status === 409, 'Doble confirmación bloqueada (409)');

  stockNow = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(Number(stockNow.find((s) => s.location_id === dep.id)?.quantity) === 97, 'Doble confirmación NO volvió a descontar');

  // ---------- Entrega sin stock suficiente ----------
  const tooMuch = await api('POST', '/deliveries?confirm=true', {
    token: TE,
    body: { locationId: dep.id, items: [{ productId: pid, quantity: 99999 }] },
  });
  // Hoy el confirm sin stock en NINGUNA ubicacion devuelve 409 de negocio
  // ("Sin stock disponible ... en ninguna ubicacion"); el 403 quedo obsoleto.
  ok(tooMuch.status === 409, 'Entrega sin stock devuelta como conflicto (409)');

  // ---------- Transferencia ----------
  console.log('[6] Transferencia entre ubicaciones');
  const transfer = await api('POST', '/transfers', {
    token: T,
    body: { originLocationId: dep.id, destinationLocationId: suc1.id, items: [{ productId: pid, quantity: 20 }] },
  });
  ok(transfer.status === 201 && transfer.json.number.startsWith('T-'), `Transferencia ${transfer.json?.number} enviada`);

  stockNow = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(Number(stockNow.find((s) => s.location_id === dep.id)?.quantity) === 77, 'Origen descontó 20');
  ok(Number(stockNow.find((s) => s.location_id === suc1.id)?.quantity) === 0, 'Destino NO tiene stock aún (en tránsito)');

  const tDetail = (await api('GET', `/transfers/${transfer.json.id}`, { token: T })).json.transfer;
  ok(tDetail.status === 'EN_TRANSITO', 'Estado EN_TRANSITO');

  const receive = await api('POST', `/transfers/${transfer.json.id}/receive`, {
    token: TE,
    body: { items: [{ itemId: tDetail.items[0].id, quantityReceived: 15 }] },
  });
  ok(receive.status === 200 && receive.json.status === 'RECIBIDO_CON_DIF', 'Recepción parcial registrada con diferencia');

  stockNow = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(Number(stockNow.find((s) => s.location_id === suc1.id)?.quantity) === 15, 'Sucursal 1 recibió 15');
  ok(Number(stockNow.find((s) => s.location_id === suc2.id)?.quantity) === 0, 'Sucursal 2 sigue en cero (stocks independientes)');

  const doubleReceive = await api('POST', `/transfers/${transfer.json.id}/receive`, {
    token: TE,
    body: { items: [{ itemId: tDetail.items[0].id, quantityReceived: 5 }] },
  });
  ok(doubleReceive.status === 409, 'Doble recepción bloqueada (409)');

  // ---------- Inventario físico ----------
  console.log('[7] Inventario físico');
  const count = await api('POST', '/counts', { token: T, body: { locationId: suc1.id, notes: 'Recuento smoke' } });
  ok(count.status === 201 && count.json.number.startsWith('INV-'), `Inventario ${count.json?.number} creado`);
  const cDetail = (await api('GET', `/counts/${count.json.id}`, { token: T })).json.count;
  const cItem = cDetail.items.find((i) => i.product_id === pid);
  ok(Number(cItem.system_quantity) === 15, 'Snapshot del sistema correcto (15)');

  await api('POST', `/counts/${count.json.id}/items`, { token: T, body: { items: [{ itemId: cItem.id, countedQuantity: 14 }] } });
  const applied = await api('POST', `/counts/${count.json.id}/apply`, { token: TE, body: { reason: 'Diferencia de recuento físico' } });
  ok(applied.status === 200 && applied.json.adjustments === 1, 'Ajuste aplicado (1 producto)');

  stockNow = (await api('GET', `/products/${pid}`, { token: T })).json.stock;
  ok(Number(stockNow.find((s) => s.location_id === suc1.id)?.quantity) === 14, 'Stock ajustado a lo contado (14)');

  // ---------- Movimientos ----------
  console.log('[8] Historial de movimientos');
  const movs = (await api('GET', `/movements?productId=${pid}&pageSize=100`, { token: T })).json;
  ok(movs.total === 5, `Historial completo y consistente (${movs.total} movimientos)`);
  const last = movs.movements[0];
  ok(last.type === 'AJUSTE_NEG' && last.balance_after === 14, 'Último movimiento: ajuste con saldo anterior y posterior');

  // ---------- Validación de permisos ----------
  console.log('[9] Permisos');
  // Crear (o reactivar) usuario empleado para la prueba
  try {
    await api('POST', '/users', {
      token: T,
      body: { username: 'empleado_smoke', fullName: 'Empleado Smoke', role: 'EMPLEADO', password: 'empleado123' },
    });
  } catch { /* ya existe */ }
  const usersList = await api('GET', '/users', { token: T });
  const emp = usersList.json.users.find((u) => u.username === 'empleado_smoke');
  if (emp && !emp.is_active) {
    await api('PUT', `/users/${emp.id}`, { token: T, body: { isActive: true } });
  }
  const empLogin = await api('POST', '/auth/login', {
    body: { username: 'empleado_smoke', password: 'empleado123' },
  });
  if (empLogin.status === 200) {
    const empCreateUser = await api('POST', '/users', {
      token: empLogin.json.token,
      body: { username: 'x_test', fullName: 'X', role: 'ADMIN', password: '123456' },
    });
    ok(empCreateUser.status === 403, 'Empleado NO puede crear usuarios (403)');
    const empEntry = await api('POST', '/entries?confirm=true', {
      token: empLogin.json.token,
      body: { locationId: dep.id, type: 'COMPRA', items: [{ productId: pid, quantity: 1 }] },
    });
    ok(empEntry.status === 403, 'Empleado NO puede registrar entradas (403)');
    const empDelivery = await api('POST', '/deliveries', {
      token: empLogin.json.token,
      body: { locationId: dep.id, items: [{ productId: pid, quantity: 1 }] },
    });
    ok(empDelivery.status === 201, 'Empleado SÍ puede registrar entregas');
  } else {
    console.log('  (usuario empleado_smoke no existe: crealo desde la app para probar permisos)');
  }

  // ---------- Dashboard y reportes ----------
  console.log('[10] Dashboard y reportes');
  const dash = (await api('GET', '/dashboard/summary', { token: T })).json;
  ok(dash.activeProducts >= 1 && typeof dash.inventoryValue === 'number', 'Dashboard con datos reales');
  ok(Array.isArray(dash.series) && dash.series.length >= 14, 'Serie temporal de entradas/salidas');
  const rep = (await api('GET', '/reports/stock-by-location', { token: T })).json;
  ok(Array.isArray(rep.rows) && rep.rows.length > 0, 'Reporte stock por ubicación');
  const val = (await api('GET', '/reports/inventory-value', { token: T })).json;
  ok(typeof val.totalValue === 'number', 'Reporte valorización');

  console.log(`\n== RESULTADO: ${passed} OK, ${failed} FALLIDOS ==\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
