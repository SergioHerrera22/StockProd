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
    code: `DELIVDBG-${stamp}`, name: `Delivery Debug ${stamp}`, unit: 'UNIDAD', minStock: 0, cost: 1000
  }});
  const pid = prod.json.id;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`INSERT INTO stock_balances (product_id, location_id, quantity) VALUES ($1, $2, 100) ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = 100`, [pid, dep.id]);
  await pool.end();

  // Create delivery
  const draft = await api('POST', '/deliveries', {
    token: T,
    body: { locationId: dep.id, invoiceNumber: '0001-00012348', items: [{ productId: pid, quantity: 3, requestedQuantity: 8 }] }
  });
  console.log('Create delivery:', draft.status, JSON.stringify(draft.json));
  const did = draft.json?.id;

  // Confirm first time
  const confirm1 = await api('POST', `/deliveries/${did}/confirm`, { token: TE });
  console.log('Confirm 1:', confirm1.status, JSON.stringify(confirm1.json));

  // Confirm second time (double)
  const confirm2 = await api('POST', `/deliveries/${did}/confirm`, { token: TE });
  console.log('Confirm 2 (double):', confirm2.status, JSON.stringify(confirm2.json));

  // Over stock delivery
  const overStock = await api('POST', '/deliveries?confirm=true', {
    token: TE,
    body: { locationId: dep.id, items: [{ productId: pid, quantity: 99999 }] }
  });
  console.log('Over stock delivery:', overStock.status, JSON.stringify(overStock.json));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
