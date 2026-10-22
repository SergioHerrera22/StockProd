#!/usr/bin/env node
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
console.log('DATABASE_URL:', process.env.DATABASE_URL?.replace(/:[^:@]*@/, ':***@'));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Insertar producto directamente
  const stamp = Date.now();
  const r = await pool.query(
    `INSERT INTO products (code, barcode, name, brand, unit, min_stock, cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, code, name`,
    [`DIRECT-${stamp}`, `77${stamp}`.slice(0,13), `Direct Test ${stamp}`, 'TestBrand', 'UNIDAD', 5, 1000, 1]
  );
  console.log('Insertado:', r.rows[0]);
  const id = r.rows[0].id;

  // Verificar que aparece
  const r2 = await pool.query('SELECT id, code, name FROM products WHERE id = $1', [id]);
  console.log('Verificación:', r2.rows);

  // Listar todos
  const r3 = await pool.query('SELECT id, code, name FROM products ORDER BY id');
  console.log('Todos los productos:', r3.rows.length);
  r3.rows.forEach(row => console.log('  ', row.id, row.code, row.name));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
