#!/usr/bin/env node
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BASE = 'http://localhost:4000/api';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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

  // Contar productos ANTES
  const before = await pool.query('SELECT count(*) FROM products');
  console.log('Productos ANTES:', before.rows[0].count);

  // Crear producto vía API
  const prodBody = {
    code: `FINAL-${stamp}`,
    barcode: `77${stamp}`.slice(0, 13),
    name: `Final Test ${stamp}`,
    brand: 'TestBrand',
    unit: 'UNIDAD',
    minStock: 5,
    cost: 1000,
  };
  const created = await api('POST', '/products', { token: T, body: prodBody });
  console.log('Create via API:', created.status, JSON.stringify(created.json));
  const pid = created.json?.id;

  // Contar productos DESPUÉS
  const after = await pool.query('SELECT count(*) FROM products');
  console.log('Productos DESPUÉS:', after.rows[0].count);

  // Buscar por code
  const find = await pool.query('SELECT id, code, name FROM products WHERE code = $1', [`FINAL-${stamp}`]);
  console.log('Buscar por code:', find.rows.length > 0 ? find.rows[0] : 'NO ENCONTRADO');

  // Buscar por id
  if (pid) {
    const findById = await pool.query('SELECT id, code, name FROM products WHERE id = $1', [pid]);
    console.log('Buscar por id:', findById.rows.length > 0 ? findById.rows[0] : 'NO ENCONTRADO');
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
