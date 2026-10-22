#!/usr/bin/env node
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const stamp = Date.now();
  const code = `TXTEST-${stamp}`;

  // Prueba 1: INSERT sin transacción (auto-commit)
  console.log('=== Prueba 1: INSERT sin transacción ===');
  const r1 = await pool.query(
    `INSERT INTO products (code, barcode, name, unit, min_stock, cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code`,
    [code, '7712345678901', 'Tx Test No Tx', 'UNIDAD', 5, 1000, 1]
  );
  console.log('Insertado (no tx):', r1.rows[0]);
  const id1 = r1.rows[0].id;

  const verify1 = await pool.query('SELECT id, code FROM products WHERE id = $1', [id1]);
  console.log('Verificado (no tx):', verify1.rows.length > 0 ? verify1.rows[0] : 'NO ENCONTRADO');

  // Prueba 2: INSERT con transacción explícita
  console.log('\n=== Prueba 2: INSERT con transacción explícita ===');
  const code2 = `TXTEST2-${stamp}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r2 = await client.query(
      `INSERT INTO products (code, barcode, name, unit, min_stock, cost, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code`,
      [code2, '7712345678902', 'Tx Test With Tx', 'UNIDAD', 5, 1000, 1]
    );
    console.log('Insertado (con tx):', r2.rows[0]);
    const id2 = r2.rows[0].id;

    // Verificar dentro de la transacción
    const verifyInside = await client.query('SELECT id, code FROM products WHERE id = $1', [id2]);
    console.log('Verificado DENTRO de tx:', verifyInside.rows.length > 0 ? verifyInside.rows[0] : 'NO ENCONTRADO');

    await client.query('COMMIT');
    console.log('COMMIT ejecutado');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Verificar fuera de la transacción
  const verify2 = await pool.query('SELECT id, code FROM products WHERE id = $1', [r2.rows[0].id]);
  console.log('Verificado FUERA de tx:', verify2.rows.length > 0 ? verify2.rows[0] : 'NO ENCONTRADO');

  // Prueba 3: Usar withTx del servidor
  console.log('\n=== Prueba 3: Contar productos totales ===');
  const count = await pool.query('SELECT count(*) FROM products');
  console.log('Total productos:', count.rows[0].count);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
