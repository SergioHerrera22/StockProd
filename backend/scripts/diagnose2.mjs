#!/usr/bin/env node
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BASE = 'http://localhost:4000/api';
const directPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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
  const stamp = Date.now();
  
  // Login
  const login = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
  const T = login.json.token;
  console.log('Login:', login.status);

  // Crear producto via API
  const prodBody = {
    code: `API-${stamp}`,
    barcode: `77${stamp}`.slice(0, 13),
    name: `API Test ${stamp}`,
    brand: 'TestBrand',
    unit: 'UNIDAD',
    minStock: 5,
    cost: 1000,
  };
  const created = await api('POST', '/products', { token: T, body: prodBody });
  console.log('Create via API:', created.status, JSON.stringify(created.json));
  const pid = created.json?.id;

  // Consultar BD directamente con pg
  const check = await directPool.query('SELECT id, code, name FROM products WHERE code = $1', [`API-${stamp}`]);
  console.log('Producto en BD directa (por code):', check.rows.length, check.rows);

  // Consultar por id si tenemos
  if (pid) {
    const checkById = await directPool.query('SELECT id, code, name FROM products WHERE id = $1', [pid]);
    console.log('Producto en BD directa (por id):', checkById.rows.length, checkById.rows);
  }

  // Contar todos
  const count = await directPool.query('SELECT count(*) FROM products');
  console.log('Total productos en BD:', count.rows[0].count);

  await directPool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
