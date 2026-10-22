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
    code: `DELIVTEST2-${stamp}`, name: `Delivery Test 2 ${stamp}`, unit: 'UNIDAD', minStock: 0, cost: 1000
  }});
  console.log('Create product:', prod.status, prod.json.id);
  const pid = prod.json.id;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`INSERT INTO stock_balances (product_id, location_id, quantity) VALUES ($1, $2, 100) ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = 100`, [pid, dep.id]);
  await pool.end();

  const draft = await api('POST', '/deliveries', {
    token: T,
    body: { locationId: dep.id, invoiceNumber: '0001-00012346', items: [{ productId: pid, quantity: 3, requestedQuantity: 8 }] }
  });
  console.log('Create delivery:', draft.status, JSON.stringify(draft.json));
  const did = draft.json?.id;

  const confirm = await api('POST', `/deliveries/${did}/confirm`, { token: TE });
  console.log('Confirm delivery with encargado:', confirm.status, JSON.stringify(confirm.json));
}

main().catch(e => { console.error(e); process.exit(1); });
