#!/usr/bin/env node
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Test what column names reserve_stock returns
  const r = await pool.query(`SELECT * FROM reserve_stock($1, $2, $3, $4, $5, $6, $7)`, 
    ['DELIVERY', 1, 65, 4, 3, 1, new Date(Date.now() + 2*60*60*1000).toISOString()]);
  console.log('Keys:', Object.keys(r.rows[0]));
  console.log('Row:', JSON.stringify(r.rows[0]));
  console.log('reservationId (camelCase):', r.rows[0].reservationId);
  console.log('reservation_id (snake_case):', r.rows[0].reservation_id);
  
  await pool.end();
}

main().catch(e => console.error(e));
