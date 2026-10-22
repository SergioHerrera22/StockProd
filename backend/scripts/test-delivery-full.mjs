#!/usr/bin/env node
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = 'http://localhost:4000/api';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* vacio */ }
  return { status: res.status, json };
}

async function main() {
  const T = (await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } })).json.token;
  const TE = (await api('POST', '/auth/login', { body: { username: 'encargado_smoke', password: 'encargado123' } })).json.token;

  const locs = await api('GET', '/locations', { token: T });
  const dep = locs.json.locations.find((l) => l.code === 'DEP');

  const stamp = Date.now();
  const prod = await api('POST', '/products', { token: T, body: {
    code: `SMKDEBUG-${stamp}`, name: `Smoke Debug ${stamp}`, unit: 'UNIDAD', minStock: 0, cost: 1000
  }});
  console.log('Create product:', prod.status, prod.json.id);
  const pid = prod.json.id;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  // Add stock via entry (simulate smoke test)
  const entry = await api('POST', '/entries', {
    token: T,
    body: { locationId: dep.id, type: 'COMPRA', supplier: 'Test', items: [{ productId: pid, quantity: 100, unitCost: 1000 }] }
  });
  console.log('Create entry:', entry.status, entry.json?.number);
  const entryConfirm = await api('POST', `/entries/${entry.json.id}/confirm`, { token: TE });
  console.log('Confirm entry:', entryConfirm.status);

  // Check stock
  const prodDetail = await api('GET', `/products/${pid}`, { token: T });
  console.log('Stock after entry:', JSON.stringify(prodDetail.json.stock));

  // Create delivery
  const draft = await api('POST', '/deliveries', {
    token: T,
    body: { locationId: dep.id, invoiceNumber: '0001-00012347', items: [{ productId: pid, quantity: 3, requestedQuantity: 8 }] }
  });
  console.log('Create delivery:', draft.status, JSON.stringify(draft.json));
  const did = draft.json?.id;

  // Confirm delivery
  const confirm = await api('POST', `/deliveries/${did}/confirm`, { token: TE });
  console.log('Confirm delivery:', confirm.status, JSON.stringify(confirm.json));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
