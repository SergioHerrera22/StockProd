#!/usr/bin/env node
const BASE = 'http://localhost:4000/api';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* vacio */ }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
}

const stamp = Date.now();

async function main() {
  // Login
  const login = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
  console.log('Login:', login.status, login.json.token ? 'token OK' : 'NO TOKEN');
  if (login.status !== 200) { console.log('Login response:', JSON.stringify(login.json)); return; }
  const T = login.json.token;

  // Get locations
  const locs = await api('GET', '/locations', { token: T });
  const dep = locs.json.locations.find((l) => l.code === 'DEP');
  console.log('Location DEP:', dep ? dep.id : 'NOT FOUND');

  // Create a product first
  const prod = await api('POST', '/products', { token: T, body: {
    code: `ENTRYTEST-${stamp}`, name: `Entry Test ${stamp}`, unit: 'UNIDAD', minStock: 0, cost: 1000
  }});
  console.log('Create product:', prod.status, JSON.stringify(prod.json));
  const pid = prod.json?.id;

  // Create entry with confirm=true
  const entry = await api('POST', '/entries?confirm=true', {
    token: T,
    body: { locationId: dep.id, type: 'COMPRA', supplier: 'Test', items: [{ productId: pid, quantity: 100, unitCost: 1000 }] }
  });
  console.log('Create entry:', entry.status, JSON.stringify(entry.json));
}

main().catch(e => { console.error(e); process.exit(1); });
