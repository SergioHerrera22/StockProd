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
    
    // Test insert into pending_deliveries
    const pdResult = await client.query(`
      INSERT INTO pending_deliveries (
        number, barcode, sale_location_id, pickup_location_id,
        customer_name, customer_phone, customer_document, notes, created_by
      ) VALUES (
        'PD-000001', '7798001234567', 1, 2,
        'Cliente Test', '123456789', '12345678', 'Test', 1
      ) RETURNING id
    `);
    console.log('pending_deliveries insert OK:', pdResult.rows[0]);
    
    // Test insert into pending_delivery_items
    await client.query(`
      INSERT INTO pending_delivery_items (
        pending_delivery_id, product_id, quantity_requested, quantity_reserved, source_location_id
      ) VALUES ($1, 1, 5, 5, 1)
    `, [pdResult.rows[0].id]);
    console.log('pending_delivery_items insert OK');
    
    // Test insert into stock_reservations
    await client.query(`
      INSERT INTO stock_reservations (
        number, reference_type, reference_id, product_id, source_location_id,
        quantity_reserved, reserved_by, expires_at, status
      ) VALUES (
        'RES-000001', 'PENDING_DELIVERY', $1, 1, 1, 5, 1, 
        now() + interval '48 hours', 'ACTIVA'
      )
    `, [pdResult.rows[0].id]);
    console.log('stock_reservations insert OK');
    
    await client.query('ROLLBACK');
    console.log('All tests passed (rolled back)');
    
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