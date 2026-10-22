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
  try {
    // Check sequences
    const sequences = ['seq_pending_delivery_number', 'seq_reservation_number', 'seq_delivery_number'];
    for (const seq of sequences) {
      try {
        const r = await pool.query(`SELECT nextval('${seq}') AS val`);
        console.log(`${seq}: ${r.rows[0].val}`);
      } catch (e) {
        console.log(`${seq}: ERROR - ${e.message}`);
      }
    }
    
    // Check generate_ean13_barcode function
    try {
      const r = await pool.query("SELECT generate_ean13_barcode() AS barcode");
      console.log(`generate_ean13_barcode(): ${r.rows[0].barcode}`);
    } catch (e) {
      console.log(`generate_ean13_barcode(): ERROR - ${e.message}`);
    }
    
    await pool.end();
  } catch (e) {
    console.error('Error:', e);
  }
}

main();