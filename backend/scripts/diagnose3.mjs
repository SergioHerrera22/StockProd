#!/usr/bin/env node
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BASE = 'http://localhost:4000/api';
const PSQL = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';

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

function psqlQuery(sql) {
  // Extraer password de DATABASE_URL: postgresql://user:pass@host:port/db
  const m = process.env.DATABASE_URL?.match(/postgresql:\/\/[^:]+:([^@]+)@/);
  const pgPassword = m ? m[1] : '';
  const out = execFileSync(PSQL, ['-h', 'localhost', '-U', 'robles_app', '-d', 'robles_stock', '-t', '-A', '-c', sql], {
    env: { ...process.env, PGPASSWORD: pgPassword },
    encoding: 'utf8',
  });
  return out.trim();
}

async function main() {
  const stamp = Date.now();

  // Login
  const login = await api('POST', '/auth/login', { body: { username: 'admin', password: 'robles2026' } });
  const T = login.json.token;
  console.log('Login:', login.status);

  // Crear producto via API
  const prodBody = {
    code: `API3-${stamp}`,
    barcode: `77${stamp}`.slice(0, 13),
    name: `API3 Test ${stamp}`,
    brand: 'TestBrand',
    unit: 'UNIDAD',
    minStock: 5,
    cost: 1000,
  };
  const created = await api('POST', '/products', { token: T, body: prodBody });
  console.log('Create via API:', created.status, JSON.stringify(created.json));
  const pid = created.json?.id;

  // Esperar un poco
  await new Promise(r => setTimeout(r, 2000));

  // Consultar con psql directamente
  const countPsql = psqlQuery("SELECT count(*) FROM products;");
  console.log('Productos en BD (psql):', countPsql);

  const findPsql = psqlQuery(`SELECT id, code, name FROM products WHERE code = 'API3-${stamp}';`);
  console.log('Producto buscado (psql):', findPsql || '(no encontrado)');

  const findByIdPsql = pid ? psqlQuery(`SELECT id, code, name FROM products WHERE id = ${pid};`) : 'N/A';
  console.log('Producto por ID (psql):', findByIdPsql || '(no encontrado)');
}

main().catch(e => { console.error(e); process.exit(1); });
