#!/usr/bin/env node
import { pool, withTx, query } from '../dist/db/pool.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  const stamp = Date.now();

  // Prueba 1: pool.query directo (sin tx)
  console.log('=== Prueba 1: pool.query directo ===');
  const r1 = await pool.query(
    `INSERT INTO products (code, barcode, name, unit, min_stock, cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code`,
    [`P1-${stamp}`, '7712345678904', 'Pool Query Direct', 'UNIDAD', 5, 1000, 1]
  );
  console.log('Insertado:', r1.rows[0]);
  const id1 = r1.rows[0].id;
  const v1 = await pool.query('SELECT id, code FROM products WHERE id = $1', [id1]);
  console.log('Verificado:', v1.rows.length > 0 ? v1.rows[0] : 'NO ENCONTRADO');

  // Prueba 2: withTx
  console.log('\n=== Prueba 2: withTx ===');
  const result = await withTx(async (c) => {
    const r2 = await c.query(
      `INSERT INTO products (code, barcode, name, unit, min_stock, cost, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code`,
      [`P2-${stamp}`, '7712345678905', 'WithTx Test', 'UNIDAD', 5, 1000, 1]
    );
    console.log('Insertado dentro de withTx:', r2.rows[0]);
    // Verificar dentro de la tx
    const vInside = await c.query('SELECT id, code FROM products WHERE id = $1', [r2.rows[0].id]);
    console.log('Verificado DENTRO de withTx:', vInside.rows.length > 0 ? vInside.rows[0] : 'NO ENCONTRADO');
    return r2.rows[0];
  });
  console.log('Resultado de withTx:', result);

  // Verificar fuera de withTx
  const id2 = result.id;
  const v2 = await pool.query('SELECT id, code FROM products WHERE id = $1', [id2]);
  console.log('Verificado FUERA de withTx:', v2.rows.length > 0 ? v2.rows[0] : 'NO ENCONTRADO');

  // Prueba 3: Total productos
  const count = await pool.query('SELECT count(*) FROM products');
  console.log('\nTotal productos:', count.rows[0].count);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
