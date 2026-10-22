#!/usr/bin/env node
import pg from 'pg';
import fs from 'fs';
import path from 'path';
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
  console.error('Define DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({ 
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check current state for product 1 at location 1
    const stock = await client.query(`
      SELECT quantity, reserved_quantity, (quantity - reserved_quantity) as available
      FROM stock_balances
      WHERE product_id = 1 AND location_id = 1
    `);
    console.log('Stock before:', stock.rows[0]);
    
    // Check reservations for this product/location
    const res = await client.query(`
      SELECT id, number, status, quantity_reserved, quantity_consumed, (quantity_reserved - quantity_consumed) as pending
      FROM stock_reservations
      WHERE product_id = 1 AND source_location_id = 1 AND status IN ('ACTIVA', 'PARCIAL')
    `);
    console.log('Active reservations:', res.rows);
    
    // Try to consume one reservation
    if (res.rows.length > 0) {
      const reservation = res.rows[0];
      console.log('\nTrying to consume reservation:', reservation.id, 'quantity:', reservation.pending);
      
      const result = await client.query(`SELECT * FROM consume_reservation($1, $2, 1, 'SALIDA', 'Test')`, [reservation.id, reservation.pending]);
      console.log('Consume result:', result.rows[0]);
      
      // Check stock after
      const stock2 = await client.query(`
        SELECT quantity, reserved_quantity, (quantity - reserved_quantity) as available
        FROM stock_balances
        WHERE product_id = 1 AND location_id = 1
      `);
      console.log('Stock after:', stock2.rows[0]);
    }
    
    await client.query('ROLLBACK');
    console.log('\nTest completed (rolled back)');
    
    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    console.error('Code:', e.code);
    console.error('Detail:', e.detail);
    console.error('Constraint:', e.constraint);
    await pool.end();
  }
}

main();