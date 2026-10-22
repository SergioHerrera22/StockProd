/** Verifica detalles finos del esquema en Supabase. */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // reserved_quantity en stock_balances
  const col = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='stock_balances' AND column_name='reserved_quantity'`);
  console.log('stock_balances.reserved_quantity:', col.rows.length ? 'EXISTE' : 'NO EXISTE');

  // Constraint check en stock_balances
  const con = await pool.query(`
    SELECT conname FROM pg_constraint WHERE conrelid = 'stock_balances'::regclass AND contype='c'`);
  console.log('checks stock_balances:', con.rows.map(r => r.conname).join(', ') || '(ninguno)');

  // Enums pending_delivery_status
  const en = await pool.query(`
    SELECT string_agg(enumlabel, ', ' ORDER BY enumsortorder) AS vals
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname='pending_delivery_status'`);
  console.log('enum pending_delivery_status:', en.rows[0]?.vals ?? '(no existe)');

  // Secuencias
  const seq = await pool.query(`
    SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`);
  console.log('secuencias:', seq.rows.map(r => r.sequencename).join(', '));

  // Funciones existentes en public (todas)
  const fns = await pool.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' ORDER BY p.proname`);
  console.log('funciones en public:', fns.rows.map(r => r.proname).join(', '));

  // Triggers en stock_reservations
  const trg = await pool.query(`
    SELECT trigger_name FROM information_schema.triggers WHERE event_object_table='stock_reservations'`);
  console.log('triggers stock_reservations:', trg.rows.map(r => r.trigger_name).join(', ') || '(ninguno)');

  // Usuarios (para seeds de 007)
  const us = await pool.query(`SELECT id, username FROM users ORDER BY id LIMIT 3`);
  console.log('usuarios:', us.rows.map(r => `${r.id}:${r.username}`).join(', ') || '(sin usuarios)');

  await pool.end();
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
