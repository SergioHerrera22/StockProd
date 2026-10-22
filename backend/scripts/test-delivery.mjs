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

const stamp = Date.now();

async function main() {
  // Login
  const login = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
  console.log('Login:', login.status);
  const T = login.json.token;

  // Get locations
  const locs = await api('GET', '/locations', { token: T });
  const dep = locs.json.locations.find((l) => l.code === 'DEP');
  console.log('Location DEP:', dep.id);

  // Create product
  const prod = await api('POST', '/products', { token: T, body: {
    code: `DELIVTEST-${stamp}`, name: `Delivery Test ${stamp}`, unit: 'UNIDAD', minStock: 0, cost: 1000
  }});
  console.log('Create product:', prod.status, prod.json.id);
  const pid = prod.json.id;

  // Add stock via direct DB
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`INSERT INTO stock_balances (product_id, location_id, quantity) VALUES ($1, $2, 100) ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = 100`, [pid, dep.id]);
  await pool.end();

  // Create delivery (no confirm)
  const draft = await api('POST', '/deliveries', {
    token: T,
    body: { locationId: dep.id, invoiceNumber: '0001-00012345', items: [{ productId: pid, quantity: 3, requestedQuantity: 8 }] }
  });
  console.log('Create delivery:', draft.status, JSON.stringify(draft.json));
}

main().catch(e => { console.error(e); process.exit(1); });
