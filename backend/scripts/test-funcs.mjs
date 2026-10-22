#!/usr/bin/env node
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  try {
    const r = await pool.query(`SELECT * FROM reserve_stock($1, $2, $3, $4, $5, $6, $7)`, 
      ['TRANSFER', 1, 50, 4, 20, 1, new Date(Date.now() + 24*60*60*1000).toISOString()]);
    console.log('reserve_stock result:', JSON.stringify(r.rows[0]));
  } catch (e) {
    console.error('reserve_stock error:', e.message);
    console.error('Detail:', e.detail);
    console.error('Code:', e.code);
  }
  
  try {
    const r2 = await pool.query(`SELECT * FROM consume_reservation($1, $2, $3, $4, $5)`,
      [12, 20, 1, 'TRANS_SALIDA', null]);
    console.log('consume_reservation result:', JSON.stringify(r2.rows[0]));
  } catch (e) {
    console.error('consume_reservation error:', e.message);
    console.error('Detail:', e.detail);
    console.error('Code:', e.code);
  }
  
  await pool.end();
}

main().catch(e => console.error(e));
