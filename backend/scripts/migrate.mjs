#!/usr/bin/env node
/** Aplica las migraciones SQL pendientes de migrations/ en orden. Idempotente. */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

// Carga .env manualmente
const envFile = path.join(backendDir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Define DATABASE_URL (backend/.env). Podés usar: npm run db:setup');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name varchar(200) PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function main() {
  await ensureTable();
  const dir = path.join(backendDir, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (applied.rows.length) {
      console.log(`- ${file} (ya aplicada)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`Aplicando ${file}...`);
    try {
      await pool.query('BEGIN');
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log(`  OK`);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(`  ERROR en ${file}:`, err.message);
      process.exit(1);
    }
  }
  await pool.end();
  console.log('Migraciones al día.');
}

main().catch((e) => { console.error(e); process.exit(1); });
