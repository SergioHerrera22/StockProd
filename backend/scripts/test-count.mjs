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

  const locs = await api('GET', '/locations', { token: T });
  const suc1 = locs.json.locations.find((l) => l.code === 'SUC1');

  const stamp = Date.now();
  const prod = await api('POST', '/products', { token: T, body: {
    code: `COUNTTEST-${stamp}`, name: `Count Test ${stamp}`, unit: 'UNIDAD', minStock: 0, cost: 1000
  }});
  console.log('Create product:', prod.status, prod.json.id);
  const pid = prod.json.id;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`INSERT INTO stock_balances (product_id, location_id, quantity) VALUES ($1, $2, 15) ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = 15`, [pid, suc1.id]);
  await pool.end();

  // Create count
  const count = await api('POST', '/counts', { token: T, body: { locationId: suc1.id, notes: 'Test count' } });
  console.log('Create count:', count.status, JSON.stringify(count.json));
}

main().catch(e => { console.error(e); process.exit(1); });
