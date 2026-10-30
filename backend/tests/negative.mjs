#!/usr/bin/env node
/**
 * ESCENARIOS NEGATIVOS — ¿cómo reacciona el sistema cuando algo sale mal?
 * Corre contra una base AISLADA (robles_stock_test) en el puerto 4001.
 * Uso: RS_BASE=http://localhost:4001/api node tests/negative.mjs
 */
const BASE = process.env.RS_BASE ?? 'http://localhost:4001/api';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); }
  else { failed++; console.error(`  ✘ ${label}`); }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* vacío */ }
  return { status: res.status, json };
}

async function stockOf(token, productId) {
  const r = await api('GET', `/products/${productId}`, { token });
  return Object.fromEntries(r.json.stock.map((s) => [s.location_id, Number(s.quantity)]));
}

async function main() {
  console.log(`\n== ESCENARIOS NEGATIVOS contra ${BASE} ==\n`);

  // ---------- Preparación ----------
  console.log('[0] Preparación');
  const admin = (await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } }));
  ok(admin.status === 200, 'Login admin');
  const T = admin.json.token;

  const locs = (await api('GET', '/locations', { token: T })).json.locations;
  const DEP = locs.find((l) => l.code === 'DEP');
  const SUC1 = locs.find((l) => l.code === 'SUC1');
  const SUC2 = locs.find((l) => l.code === 'SUC2');

  const stamp = Date.now();
  const prod = await api('POST', '/products', {
    token: T,
    body: { code: `NEG-${stamp}`, name: `Producto Escenarios Negativos ${stamp}`, unit: 'UNIDAD', minStock: 2, cost: 500 },
  });
  const pid = prod.json.id;
  ok(!!pid, 'Producto de prueba creado');
  const supplierCreated = await api('POST', '/suppliers', { token: T, body: { name: `Proveedor Negativo ${stamp}` } });
  const supplierId = supplierCreated.json?.id;
  ok(supplierCreated.status === 201 && supplierId, 'Proveedor de prueba creado');

  // Usuarios restringidos a SUC1
  await api('POST', '/users', { token: T, body: { username: `neg_emp_${stamp}`, fullName: 'Empleado Restrictivo', role: 'EMPLEADO', password: 'clave123', defaultLocationId: SUC1.id, restrictToLocation: true } });
  const emp = await api('POST', '/auth/login', { body: { username: `neg_emp_${stamp}`, password: 'clave123' } });
  ok(emp.status === 200, 'Empleado restringido (SUC1) creado y logueado');
  const TE = emp.json.token;

  await api('POST', '/users', { token: T, body: { username: `neg_enc_${stamp}`, fullName: 'Encargado Restrictivo', role: 'ENCARGADO', password: 'clave123', defaultLocationId: SUC1.id, restrictToLocation: true } });
  const enc = await api('POST', '/auth/login', { body: { username: `neg_enc_${stamp}`, password: 'clave123' } });
  ok(enc.status === 200, 'Encargado restringido (SUC1) creado y logueado');
  const TC = enc.json.token;

  // Segundo usuario SIN restricciones de ubicación. La segregación de funciones
  // exige que quien confirma/aplica/anula un documento no sea quien lo creó.
  const enc2 = await api('POST', '/auth/login', { body: { username: 'encargado_smoke', password: 'encargado123' } });
  ok(enc2.status === 200, 'Encargado sin restricciones disponible para segregación');
  const TX = enc2.json.token;

  // Entrada de 100 al depósito. La confirma el encargado: la segregación de
  // funciones impide que quien crea la entrada sea quien la confirma.
  const entry = await api('POST', '/entries', {
    token: T,
    body: { locationId: DEP.id, type: 'COMPRA', supplierId, items: [{ productId: pid, quantity: 100, unitCost: 500 }] },
  });
  const entryConfirm = await api('POST', `/entries/${entry.json?.id}/confirm`, { token: TX });
  ok(entry.status === 201 && entryConfirm.status === 200,
    `Entrada ${entry.json?.number} confirmada (+100 en DEP) [crea=${entry.status}, confirma=${entryConfirm.status} ${entryConfirm.json?.error ?? ''}]`);

  // ---------- [A] Fallo a mitad de una entrega multi-línea ----------
  console.log('\n[A] Caída a mitad de una entrega: NO debe descontar nada');
  const multi = await api('POST', '/deliveries?confirm=true', {
    token: T,
    body: { locationId: DEP.id, items: [
      { productId: pid, quantity: 2 },      // primera línea OK
      { productId: pid, quantity: 99999 },  // duplicado se rechaza antes... usar producto distinto no hay; usar segunda línea inválida
    ] },
  });
  // items duplicados del mismo producto → rechazados por validación; para probar el fallo
  // parcial real usamos un segundo producto sin stock:
  const prod2 = await api('POST', '/products', {
    token: T,
    body: { code: `NEG2-${stamp}`, name: `Sin stock ${stamp}`, unit: 'UNIDAD' },
  });
  const multi2 = await api('POST', '/deliveries?confirm=true', {
    token: TX,
    body: { locationId: DEP.id, items: [
      { productId: pid, quantity: 2 },      // línea 1: hay stock
      { productId: prod2.json.id, quantity: 5 }, // línea 2: sin stock → falla
    ] },
  });
  ok(multi2.status === 409, `Entrega multi-línea con línea sin stock → 409 (${multi2.json?.error ?? ''})`);
  const st = await stockOf(T, pid);
  ok(st[DEP.id] === 100, `Rollback completo: la línea 1 NO quedó descontada (DEP=${st[DEP.id]}, esperado 100)`);

  // ---------- [B] Confirmación doble CONCURRENTE ----------
  console.log('\n[B] Dos confirmaciones al mismo tiempo');
  const draft = await api('POST', '/deliveries', {
    token: T,
    body: { locationId: DEP.id, items: [{ productId: pid, quantity: 1 }] },
  });
  const [c1, c2] = await Promise.allSettled([
    api('POST', `/deliveries/${draft.json.id}/confirm`, { token: TX }),
    api('POST', `/deliveries/${draft.json.id}/confirm`, { token: TX }),
  ]);
  const results = [c1, c2].map((r) => r.value);
  const success = results.filter((r) => r.status === 200).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  ok(success === 1 && conflicts === 1, `Resultado concurrente: ${success} éxito + ${conflicts} bloqueo (409)`);
  const stB = await stockOf(T, pid);
  ok(stB[DEP.id] === 99, `Stock descontado UNA sola vez (DEP=${stB[DEP.id]}, esperado 99)`);

  // ---------- [C] Anulación de entrega confirmada ----------
  console.log('\n[C] Anulación de entrega confirmada (movimientos compensatorios)');
  const voided = await api('POST', `/deliveries/${draft.json.id}/void`, { token: TX, body: { reason: 'Anulación de prueba controlada', voidApprovedBy: admin.json.user.id } });
  ok(voided.status === 200, `Anulación aceptada [${voided.status} ${voided.json?.error ?? ''}]`);
  const stC = await stockOf(T, pid);
  ok(stC[DEP.id] === 100, `Stock repuesto por la anulación (DEP=${stC[DEP.id]}, esperado 100)`);
  const voidAgain = await api('POST', `/deliveries/${draft.json.id}/void`, { token: TX, body: { reason: 'Segunda anulación', voidApprovedBy: admin.json.user.id } });
  ok(voidAgain.status === 409, 'Segunda anulación bloqueada (409)');

  // ---------- [D] Anulación de entrada confirmada ----------
  console.log('\n[D] Anulación de entrada confirmada');
  const entry2 = await api('POST', '/entries', {
    token: T,
    body: { locationId: DEP.id, type: 'COMPRA', supplierId, items: [{ productId: pid, quantity: 10 }] },
  });
  await api('POST', `/entries/${entry2.json.id}/confirm`, { token: TX });
  const voidEntry = await api('POST', `/entries/${entry2.json.id}/void`, { token: TX, body: { reason: 'Entrada cargada por error', voidApprovedBy: admin.json.user.id } });
  ok(voidEntry.status === 200, `Anulación de entrada aceptada [${voidEntry.status} ${voidEntry.json?.error ?? ''}]`);
  const stD = await stockOf(T, pid);
  ok(stD[DEP.id] === 100, `Stock revertido (DEP=${stD[DEP.id]}, esperado 100)`);
  const confirmVoidedEntry = await api('POST', `/entries/${entry2.json.id}/confirm`, { token: TX });
  ok(confirmVoidedEntry.status === 409, 'Re-confirmar entrada anulada → 409');

  // ---------- [E] Transferencia y su anulación ----------
  console.log('\n[E] Transferencia: tránsito, anulación y recepción tardía');
  const tr = await api('POST', '/transfers', {
    token: T,
    body: { originLocationId: DEP.id, destinationLocationId: SUC1.id, items: [{ productId: pid, quantity: 10 }] },
  });
  let stE = await stockOf(T, pid);
  ok(stE[DEP.id] === 90 && stE[SUC1.id] === 0, `Envío: origen 90, destino 0 (en tránsito) [DEP=${stE[DEP.id]}, SUC1=${stE[SUC1.id]}]`);
  const voidTr = await api('POST', `/transfers/${tr.json.id}/void`, { token: T, body: { reason: 'Se despachó por error' } });
  ok(voidTr.status === 200, 'Anulación de transferencia en tránsito aceptada');
  stE = await stockOf(T, pid);
  ok(stE[DEP.id] === 100, `Stock devuelto al origen (DEP=${stE[DEP.id]}, esperado 100)`);
  const lateReceive = await api('POST', `/transfers/${tr.json.id}/receive`, {
    token: T,
    body: { items: [{ itemId: 1, quantityReceived: 10 }] },
  });
  ok(lateReceive.status === 409 || lateReceive.status === 400, 'Recepción sobre transferencia anulada → rechazada');

  // ---------- [F] Inventario aplicado dos veces ----------
  console.log('\n[F] Inventario físico aplicado dos veces');
  // Primero dejar stock en SUC2: transferencia DEP → SUC2
  const tr2 = await api('POST', '/transfers', {
    token: T,
    body: { originLocationId: DEP.id, destinationLocationId: SUC2.id, items: [{ productId: pid, quantity: 5 }] },
  });
  const tr2d = (await api('GET', `/transfers/${tr2.json.id}`, { token: T })).json.transfer;
  await api('POST', `/transfers/${tr2.json.id}/receive`, {
    token: TX,
    body: { items: [{ itemId: tr2d.items[0].id, quantityReceived: 5 }] },
  });
  const cnt = await api('POST', '/counts', { token: T, body: { locationId: SUC2.id, notes: 'Recuento negativo' } });
  const cntD = (await api('GET', `/counts/${cnt.json.id}`, { token: T })).json.count;
  const cntItem = cntD.items.find((i) => i.product_id === pid);
  await api('PUT', `/counts/${cnt.json.id}/items`, { token: T, body: { items: [{ itemId: cntItem.id, countedQuantity: 3 }] } });
  const apply1 = await api('POST', `/counts/${cnt.json.id}/apply`, { token: TX, body: { reason: 'Ajuste de recuento' } });
  ok(apply1.status === 200 && apply1.json.adjustments === 1, `Primer ajuste aplicado (5 → 3) [${apply1.status} ${apply1.json?.error ?? ''}]`);
  const apply2 = await api('POST', `/counts/${cnt.json.id}/apply`, { token: TX, body: { reason: 'Intento doble' } });
  ok(apply2.status === 409, 'Segundo apply del mismo inventario → 409');
  const stF = await stockOf(T, pid);
  ok(stF[SUC2.id] === 3, `Stock SUC2 quedó en lo contado (3) y no se re-aplicó [${stF[SUC2.id]}]`);

  // ---------- [G] Intento de inyección SQL ----------
  console.log('\n[G] Intento de inyección SQL');
  const sqli = await api('GET', `/products?q=${encodeURIComponent("'; DROP TABLE products;--")}`, { token: T });
  ok(sqli.status === 200, 'Búsqueda maliciosa → 200 sin romper nada');
  const still = await api('GET', '/products?pageSize=1', { token: T });
  ok(still.status === 200 && still.json.total > 0, `Tabla products intacta (total=${still.json.total})`);

  // ---------- [H] Restricción por ubicación ----------
  console.log('\n[H] Usuario restringido a SUC1 intentando operar en otras ubicaciones');
  const r1 = await api('POST', '/deliveries', { token: TE, body: { locationId: DEP.id, items: [{ productId: pid, quantity: 1 }] } });
  ok(r1.status === 403, 'Empleado restringido: entrega desde el Depósito → 403');
  const r2 = await api('POST', '/deliveries', { token: TE, body: { locationId: SUC1.id, items: [{ productId: pid, quantity: 1 }] } });
  ok(r2.status === 201, 'Empleado restringido: entrega desde SU ubicación → OK');
  const r3 = await api('POST', '/entries?confirm=true', { token: TC, body: { locationId: DEP.id, type: 'COMPRA', supplierId, items: [{ productId: pid, quantity: 1 }] } });
  ok(r3.status === 403, 'Encargado restringido: entrada al Depósito → 403');
  const r4 = await api('POST', '/entries', { token: TC, body: { locationId: SUC1.id, type: 'DEVOLUCION', items: [{ productId: pid, quantity: 2 }] } });
  ok(r4.status === 201, 'Encargado restringido: entrada en SU ubicación → OK');
  const r5 = await api('POST', '/transfers', { token: TC, body: { originLocationId: SUC2.id, destinationLocationId: DEP.id, items: [{ productId: pid, quantity: 1 }] } });
  ok(r5.status === 403, 'Encargado restringido: transferencia que no involucra su ubicación → 403');
  // SUC1 necesita stock para poder despachar (la creación de la transferencia valida disponibilidad)
  const suc1Entry = await api('POST', '/entries', { token: T, body: { locationId: SUC1.id, type: 'OTRO', items: [{ productId: pid, quantity: 5 }] } });
  await api('POST', `/entries/${suc1Entry.json.id}/confirm`, { token: TX });
  const r6 = await api('POST', '/transfers', { token: TC, body: { originLocationId: SUC1.id, destinationLocationId: DEP.id, items: [{ productId: pid, quantity: 1 }] } });
  ok(r6.status === 201, 'Encargado restringido: transferencia desde SU ubicación → OK');
  const r7 = await api('POST', '/counts', { token: TC, body: { locationId: SUC2.id } });
  ok(r7.status === 403, 'Encargado restringido: recuento en otra ubicación → 403');
  // Confirmar un borrador ajeno
  const foreignDraft = await api('POST', '/deliveries', { token: T, body: { locationId: SUC2.id, items: [{ productId: pid, quantity: 1 }] } });
  const r8 = await api('POST', `/deliveries/${foreignDraft.json.id}/confirm`, { token: TE });
  ok(r8.status === 403, 'Empleado restringido: confirmar borrador de otra ubicación → 403');

  // ---------- [I] Sesiones: visibilidad y desconexión ----------
  console.log('\n[I] Control de sesiones');
  const sess = await api('GET', '/sessions', { token: T });
  ok(sess.status === 200 && sess.json.sessions.length >= 3, `Admin ve las sesiones activas (${sess.json?.sessions?.length})`);
  const empSessions = sess.json.sessions.filter((s) => s.username === `neg_emp_${stamp}`);
  ok(empSessions.length >= 1, 'Se ve la sesión del empleado con su usuario');
  const revoke = await api('POST', `/sessions/${empSessions[0].id}/revoke`, { token: T });
  ok(revoke.status === 200, 'Admin desconecta la sesión del empleado');
  const empAfter = await api('GET', '/stock', { token: TE });
  ok(empAfter.status === 401, 'Empleado expulsado: siguiente pedido → 401');
  ok((empAfter.json?.error ?? '').includes('administrador') || (empAfter.json?.error ?? '').includes('Sesión'), `Mensaje claro: "${empAfter.json?.error}"`);
  const empRevokeOwn = await api('POST', `/sessions/${empSessions[0].id}/revoke`, { token: TE });
  ok(empRevokeOwn.status === 401, 'Empleado ya no puede hacer nada con su token muerto');

  // ---------- [J] Logout real ----------
  console.log('\n[J] Logout real (server-side)');
  const fresh = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
  const TF = fresh.json.token;
  const before = await api('GET', '/auth/me', { token: TF });
  ok(before.status === 200, 'Token fresco funciona');
  await api('POST', '/auth/logout', { token: TF });
  const after = await api('GET', '/auth/me', { token: TF });
  ok(after.status === 401, 'Tras logout el token queda muerto en el servidor (401)');

  // ---------- [K] Cierre por inactividad ----------
  console.log('\n[K] Cierre por inactividad (SESSION_IDLE_MINUTES=0.03 ≈ 1.8s)');
  const idleLogin = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
  const TI = idleLogin.json.token;
  const alive = await api('GET', '/auth/me', { token: TI });
  ok(alive.status === 200, 'Sesión activa inmediatamente después del login');
  await new Promise((r) => setTimeout(r, 2600)); // > 1.8s de inactividad
  const idle = await api('GET', '/auth/me', { token: TI });
  ok(idle.status === 401 && /inactividad/i.test(idle.json?.error ?? ''), `Sesión cerrada por inactividad: "${idle.json?.error}"`);

  // ---------- [L] Login fallido auditado ----------
  console.log('\n[L] Intentos de acceso fallidos quedan registrados');
  await api('POST', '/auth/login', { body: { username: 'admin', password: 'contraseña-equivocada' } });
  const admin2 = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
  const audit = await api('GET', '/audit?action=LOGIN_FAILED&pageSize=5', { token: admin2.json.token });
  ok(audit.status === 200 && audit.json.total >= 1, `Auditoría registra LOGIN_FAILED (total=${audit.json?.total})`);

  console.log(`\n== RESULTADO: ${passed} OK, ${failed} FALLIDOS ==\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
