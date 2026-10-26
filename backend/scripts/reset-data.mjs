#!/usr/bin/env node
/**
 * REINICIO DE DATOS (destructivo e irreversible):
 *
 *   node scripts/reset-data.mjs --yes   (plano completo: borrar TODO)
 *   node scripts/reset-data.mjs --yes --keep-products
 *   node scripts/reset-data.mjs --yes --wipe-users
 *
 * Hace un backup JSON de TODO antes de tocar nada (en /backups).
 * Mantiene siempre: schema_migrations.
 * Con --wipe-users borra TODO (incluidos los 21 usuarios) y re-crea los datos base
 * con seed.mjs (roles, 4 ubicaciones, categorías y usuario admin/robles2026)
 * y restaura las approval_rules/control_thresholds por defecto apuntando al nuevo admin.
 * Con --keep-products conserva además productos y categorías.
 *
 * IMPORTANTE: sólo afecta la base de backend/.env (DATABASE_URL).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const keepProducts = args.includes('--keep-products');
const wipeUsers = args.includes('--wipe-users');
if (!args.includes('--yes')) {
  console.error('Seguridad: este script borra datos. Confirmá con --yes.');
  process.exit(1);
}

const envFile = path.join(backendDir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('Define DATABASE_URL en backend/.env'); process.exit(1); }

const dbTag = DATABASE_URL.includes('supabase') ? 'SUPABASE' : 'local PostgreSQL';
console.log(`Base de datos objetivo: ${dbTag}`);
console.log(`  ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}\n`);

const KEEP_UNTRUNCATED = new Set(['schema_migrations']);
// Son configuración del sistema (si la migración 007 no los seedea, quedan vacíos,
// se restauran después del seed) -> se borran solo en wipe-users y se regeneran.
const CONFIG_TABLES = new Set(['approval_rules', 'control_thresholds']);

const pool = new pg.Pool({ connectionString: DATABASE_URL });

/* ---------- 1) Backup JSON completo ---------- */
async function dumpAll() {
  const { rows: names } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
  );
  const backup = {
    createdAt: new Date().toISOString(),
    database: dbTag,
    hostMasked: DATABASE_URL.replace(/:[^:@/]+@/, ':***@'),
    tables: {},
  };
  for (const { table_name } of names) {
    const { rows } = await pool.query(`SELECT * FROM "${table_name}"`);
    if (rows.length) backup.tables[table_name] = rows;
  }
  const backupDir = path.join(backendDir, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(backupDir, `backup-antes-de-borrar-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 1));
  const tablesCount = Object.keys(backup.tables).length;
  console.log(`✓ Backup completo en: ${file} (${tablesCount} tablas con datos)`);
  if (tablesCount === 0) console.warn('⚠ Atención: no había datos que respaldar');
  return file;
}

/* ---------- 2) Borrado ---------- */
async function wipe() {
  const { rows: names } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'`
  );
  let targets = names
    .map((r) => r.tablename)
    .filter((t) => !KEEP_UNTRUNCATED.has(t));

  if (keepProducts) {
    // categorías FK de products: el CASCADE las arrastraría junto con los productos
  }

  if (wipeUsers) {
    // borra también usuarios y config (approval_rules/thresholds); el seed re-crea
    // admin, ubicaciones y categorías, y restoreConfigDefaults() restaura la config.
  } else {
    const keep = new Set(['users', 'roles', ...CONFIG_TABLES]);
    targets = targets.filter((t) => !keep.has(t));
  }
  if (keepProducts) {
    const keep = new Set(['products', 'categories']);
    targets = targets.filter((t) => !keep.has(t));
  }
  if (!targets.length) { console.log('Nada que borrar con estas opciones.'); return; }

  await pool.query(`TRUNCATE TABLE ${targets.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  console.log(`✓ Borradas ${targets.length} tablas: ${targets.join(', ')}`);
}

/* ---------- 3) Restaurar config por defecto tras wipe-users ---------- */
async function restoreConfigDefaults() {
  const { rows: admins } = await pool.query(
    `SELECT id FROM users WHERE role_code='ADMIN' AND is_active=true LIMIT 1`
  );
  if (!admins.length) { console.warn('⚠ Sin ADMIN activo: no se restauran approval_rules'); return; }
  const adminId = admins[0].id;

  await pool.query(
    `INSERT INTO approval_rules (name, entity_type, operation, condition, action, priority, created_by) VALUES
     ('transfer_qty_approval', 'TRANSFER', 'CREATE', '{"qty_gt": 50}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('transfer_value_approval', 'TRANSFER', 'CREATE', '{"value_gt": 50000}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('transfer_emp_requires_approval', 'TRANSFER', 'CREATE', '{"user_role": "EMPLEADO"}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 5, $1),
     ('delivery_qty_approval', 'DELIVERY', 'CONFIRM', '{"qty_gt": 100}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('delivery_value_approval', 'DELIVERY', 'CONFIRM', '{"value_gt": 100000}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('delivery_emp_requires_approval', 'DELIVERY', 'CONFIRM', '{"user_role": "EMPLEADO"}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 5, $1),
     ('entry_qty_approval', 'ENTRY', 'CONFIRM', '{"qty_gt": 200}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('entry_value_approval', 'ENTRY', 'CONFIRM', '{"value_gt": 200000}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('count_large_approval', 'COUNT', 'APPLY', '{"lines_gt": 50}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('count_adjustment_approval', 'COUNT', 'APPLY', '{"adjustments_gt": 10}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('void_always_dual', 'VOID', 'VOID', '{}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1, "dual_auth": true}', 1, $1),
     ('adjust_large_approval', 'STOCK_ADJUST', 'ADJUST', '{"qty_gt": 20}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, $1),
     ('adjust_emp_requires_approval', 'STOCK_ADJUST', 'ADJUST', '{"user_role": "EMPLEADO"}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 5, $1)
     ON CONFLICT (name) DO NOTHING`,
    [adminId]
  );
  console.log(`✓ 13 approval_rules restauradas (created_by=${adminId})`);

  await pool.query(
    `INSERT INTO control_thresholds (location_id, entity_type, metric, threshold_value, threshold_operator, action, created_by) VALUES
     (NULL, 'TRANSFER', 'qty_sum', 50, 'GT', '{"require_approval": true, "min_role": "ENCARGADO", "alert": true}', $1),
     (NULL, 'TRANSFER', 'days_in_transit', 1, 'GT', '{"alert": true, "alert_roles": ["ADMIN","ENCARGADO"], "alert_code": "TRANSFER_OVERDUE"}', $1),
     (NULL, 'DELIVERY', 'value_sum', 100000, 'GT', '{"require_approval": true, "min_role": "ENCARGADO", "alert": true}', $1),
     (NULL, 'DELIVERY', 'pending_hours', 40, 'GT', '{"alert": true, "alert_roles": ["ADMIN","ENCARGADO"], "alert_code": "PENDING_DELIVERY_EXPIRING"}', $1),
     (NULL, 'PRODUCT', 'stock_below_min', 0, 'GT', '{"alert": true, "alert_roles": ["ADMIN","ENCARGADO"], "alert_code": "STOCK_BELOW_MIN"}', $1),
     (NULL, 'VOID', 'void_count_per_user_day', 3, 'GT', '{"alert": true, "alert_roles": ["ADMIN"], "alert_code": "VOID_ANOMALY"}', $1)
     ON CONFLICT (location_id, entity_type, metric) DO NOTHING`,
    [adminId]
  );
  console.log(`✓ 6 control_thresholds restaurados (created_by=${adminId})`);
}

/* ---------- main ---------- */
await dumpAll();
await wipe();

if (wipeUsers) {
  console.log('\nRe-creando datos base con seed.mjs (roles, ubicaciones, categorías, admin)…');
  const res = spawnSync(process.execPath, [path.join(__dirname, 'seed.mjs')], {
    cwd: backendDir, stdio: 'inherit', env: process.env,
  });
  if (res.status !== 0) {
    console.error('✗ falló el seed; revisá manualmente con: npm run db:seed');
    process.exit(1);
  }
  await restoreConfigDefaults();
}

/* Verificación final */
const { rows: names } = await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
);
const remaining = {};
let total = 0;
for (const { table_name } of names) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${table_name}"`);
  if (rows[0].n > 0) { remaining[table_name] = rows[0].n; total += rows[0].n; }
}
console.log(`\n=== Estado final de la base ===`);
if (total === 0) console.log('✓ Sin datos (salvo structure/ migrations)');
else for (const [t, n] of Object.entries(remaining)) console.log(`  ${t}: ${n}`);
await pool.end();
console.log('\nReinicio completado.');
