#!/usr/bin/env node
/**
 * Datos iniciales: roles, 4 ubicaciones, categorias base y usuario administrador.
 * Idempotente. La contraseña del admin viene de SEED_ADMIN_PASSWORD (default robles2026).
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

const envFile = path.join(backendDir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Define DATABASE_URL (backend/.env).');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  // Roles
  for (const [code, name] of [['ADMIN', 'Administrador'], ['ENCARGADO', 'Encargado'], ['EMPLEADO', 'Empleado'], ['TRANSPORTE', 'Transporte / Chofer']]) {
    await pool.query(
      'INSERT INTO roles (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name',
      [code, name]
    );
  }
  console.log('- Roles OK');

  // Ubicaciones iniciales (las 3 sucursales + deposito general)
  const locations = [
    ['SUC1', 'Sucursal 1', 'SUCURSAL'],
    ['SUC2', 'Sucursal 2', 'SUCURSAL'],
    ['SUC3', 'Sucursal 3', 'SUCURSAL'],
    ['DEP', 'Depósito General', 'DEPOSITO'],
  ];
  for (const [code, name, type] of locations) {
    await pool.query(
      `INSERT INTO locations (code, name, type) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, type]
    );
  }
  console.log('- Ubicaciones OK (Sucursal 1, 2, 3 y Depósito General)');

  // Categorias base
  const cats = ['Pinturas', 'Esmaltes', 'Barnices', 'Diluyentes', 'Impermeabilizantes', 'Rodillos y Pinceles', 'Lijas', 'Accesorios'];
  for (const name of cats) {
    await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  }
  console.log('- Categorías OK');

  // Usuario administrador inicial
  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD || 'robles2026';
  const exists = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (!exists.rows.length) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role_code)
       VALUES ($1,$2,$3,'ADMIN')`,
      [username, hash, 'Administrador']
    );
    console.log(`- Usuario administrador creado: ${username}`);
    console.log(`  CONTRASEÑA INICIAL: ${password}  (cambiala al iniciar sesión)`);
  } else {
    console.log('- Usuario administrador ya existe (no se modificó)');
  }

  await pool.end();
  console.log('Seed completo.');
}

main().catch((e) => { console.error(e); process.exit(1); });
