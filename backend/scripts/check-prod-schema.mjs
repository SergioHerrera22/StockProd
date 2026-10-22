/** Inspecciona el estado real del esquema en Supabase (producción). */
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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  // 1. Migraciones registradas
  const mig = await pool.query(`SELECT name FROM schema_migrations ORDER BY name`).catch(() => ({ rows: [] }));
  console.log('=== schema_migrations ===');
  for (const r of mig.rows) console.log(' -', r.name);

  // 2. Tablas clave
  const tables = ['pending_deliveries', 'pending_delivery_items', 'stock_reservations', 'stock_snapshots',
    'alerts', 'approval_rules', 'user_location_permissions', 'business_rules', 'document_versions', 'reconciliation_logs'];
  console.log('=== tablas clave ===');
  for (const t of tables) {
    const r = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${t}`]);
    console.log(` - ${t}: ${r.rows[0].exists ? 'EXISTE' : 'no existe'}`);
  }

  // 3. Columnas de stock_reservations (para ver qué esquema tiene)
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'stock_reservations' ORDER BY ordinal_position`).catch(() => ({ rows: [] }));
  console.log('=== stock_reservations.columnas ===');
  console.log(' ', cols.rows.map((r) => r.column_name).join(', '));

  // 4. Valores de enums clave
  for (const enumName of ['doc_status', 'reference_type', 'movement_type']) {
    const r = await pool.query(`
      SELECT string_agg(enumlabel, ', ' ORDER BY enumsortorder) AS vals
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1`, [enumName]);
    console.log(`=== enum ${enumName} ===`);
    console.log(' ', r.rows[0]?.vals ?? '(no existe)');
  }

  // 5. Funciones clave
  const funcs = ['reserve_stock', 'consume_reservation', 'check_multi_location_availability',
    'generate_ean13_barcode', 'scan_pending_delivery_barcode', 'create_alert', 'create_stock_snapshot'];
  console.log('=== funciones clave ===');
  for (const f of funcs) {
    const r = await pool.query(`SELECT to_regprocedure($1) IS NOT NULL AS exists`, [`public.${f}`]);
    console.log(` - ${f}: ${r.rows[0].exists ? 'EXISTE' : 'no existe'}`);
  }

  await pool.end();
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
