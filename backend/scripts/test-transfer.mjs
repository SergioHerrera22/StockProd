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
  const suc1 = locs.json.locations.find((l) => l.code === 'SUC1');

  const stamp = Date.now();
  const prod = await api('POST', '/products', { token: T, body: {
    code: `TRANSTEST-${stamp}`, name: `Transfer Test ${stamp}`, unit: 'UNIDAD', minStock: 0, cost: 1000
  }});
  console.log('Create product:', prod.status, prod.json.id);
  const pid = prod.json.id;

  // Agregar stock en dep directamente
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`INSERT INTO stock_balances (product_id, location_id, quantity) VALUES ($1, $2, 100) ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = 100`, [pid, dep.id]);
  await pool.end();

  console.log('DEP id:', dep?.id, 'SUC1 id:', suc1?.id, 'PID:', pid);
  const transfer = await api('POST', '/transfers', {
    token: T,
    body: { originLocationId: dep.id, destinationLocationId: suc1.id, items: [{ productId: pid, quantity: 20 }] }
  });
  console.log('Create transfer:', transfer.status, JSON.stringify(transfer.json));
}

main().catch(e => { console.error(e); process.exit(1); });
