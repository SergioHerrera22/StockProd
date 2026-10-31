#!/usr/bin/env node
/** Aplica migraciones SQL pendientes en orden, con transacciones por conexión y lock global. */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
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

// SSL solo cuando el servidor lo pide (Supabase/produccion).
const wantsSSL = /sslmode=require/i.test(DATABASE_URL);
const pool = new pg.Pool({
  connectionString: DATABASE_URL.replace('?sslmode=require&rejectUnauthorized=false', '').replace('?sslmode=require', ''),
  ...(wantsSSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

const MIGRATION_LOCK_ID = '72419031'; // ID estable y exclusivo para el migrador de StockProd.

async function main() {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name varchar(200) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const dir = path.join(backendDir, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (applied.rows.length) {
        console.log(`- ${file} (ya aplicada)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`Aplicando ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('  OK');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log('Migraciones al día.');
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
      } catch (unlockError) {
        console.error('No se pudo liberar explícitamente el advisory lock:', unlockError);
      }
    }
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
