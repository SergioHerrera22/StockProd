#!/usr/bin/env node
/**
 * Crea el rol y la base de datos si no existen (conecta como postgres via
 * autenticacion local), y luego ejecuta migraciones + seed.
 * Uso: npm run db:setup
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');
const envPath = path.join(backendDir, '.env');

function findPsql() {
  const candidates = [
    process.env.PSQL_PATH,
    'psql',
    'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe' });
      return c;
    } catch { /* siguiente */ }
  }
  console.error('No se encontro psql. Instala PostgreSQL o define PSQL_PATH.');
  process.exit(1);
}

const psql = findPsql();
const APP_USER = 'robles_app';
const APP_DB = 'robles_stock';
const APP_PASSWORD = crypto.randomBytes(12).toString('base64url');

function runPsql(args, extraEnv = {}) {
  execFileSync(psql, ['-h', 'localhost', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

console.log('== Creando rol y base de datos (si no existen) ==');
runPsql(['-t', '-c', `SELECT 1 FROM pg_roles WHERE rolname='${APP_USER}'`]);
const roleExists = (() => {
  try {
    const out = execFileSync(psql, ['-h', 'localhost', '-U', 'postgres', '-t', '-A', '-c', `SELECT 1 FROM pg_roles WHERE rolname='${APP_USER}'`]).toString().trim();
    return out === '1';
  } catch { return false; }
})();

if (!roleExists) {
  runPsql(['-c', `CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}'`]);
  console.log(`Rol ${APP_USER} creado.`);
} else {
  console.log(`Rol ${APP_USER} ya existe.`);
}

const dbExists = (() => {
  try {
    const out = execFileSync(psql, ['-h', 'localhost', '-U', 'postgres', '-t', '-A', '-c', `SELECT 1 FROM pg_database WHERE datname='${APP_DB}'`]).toString().trim();
    return out === '1';
  } catch { return false; }
})();

if (!dbExists) {
  runPsql(['-c', `CREATE DATABASE ${APP_DB} OWNER ${APP_USER}`]);
  console.log(`Base ${APP_DB} creada.`);
} else {
  console.log(`Base ${APP_DB} ya existe.`);
}

// Escribe o actualiza .env con la password del rol
let envContent = '';
if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8');
const dbUrl = `postgresql://${APP_USER}:${encodeURIComponent(APP_PASSWORD)}@localhost:5432/${APP_DB}`;
if (envContent.includes('DATABASE_URL=')) {
  envContent = envContent.replace(/DATABASE_URL=.*/, `DATABASE_URL=${dbUrl}`);
} else {
  envContent = `DATABASE_URL=${dbUrl}\n` + envContent;
}
if (!envContent.includes('JWT_SECRET=') || envContent.includes('cambiar-por-un-secreto')) {
  const secret = crypto.randomBytes(48).toString('base64url');
  envContent = envContent.replace(/JWT_SECRET=.*/, `JWT_SECRET=${secret}`);
  if (!envContent.includes('JWT_SECRET=')) envContent += `\nJWT_SECRET=${secret}\n`;
}
fs.writeFileSync(envPath, envContent);
console.log('.env actualizado con las credenciales.');

console.log('== Ejecutando migraciones ==');
runPsql(['-d', APP_DB, '-f', path.join(backendDir, 'migrations', '001_init.sql')], {
  PGPASSWORD: APP_PASSWORD,
});

console.log('== Datos iniciales ==');
execFileSync(process.execPath, [path.join(backendDir, 'scripts', 'seed.mjs')], { stdio: 'inherit' });

console.log('\n✔ Base de datos lista. Usuario inicial: admin / robles2026 (cambiala al ingresar).');
