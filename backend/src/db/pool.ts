import { Pool, PoolClient, ClientBase, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/env';
import { logger } from '../lib/logger';

const isSupabase = config.databaseUrl.includes('supabase');

// Zona horaria fija de la empresa en TODAS las sesiones del pool: sin esto,
// "hoy" cierra a las 21:00 cuando el Postgres corre en UTC y confunde
// conteos por día, entregas del día y reportes.
// Se usa la OPCION onConnect (no el evento pool.on('connect')): pg-pool
// ESPERA esta promesa antes de despachar la primer query del cliente, así
// el SET TIME ZONE nunca pisa/compite con una consulta de usuario.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  onConnect: (client: ClientBase) => client.query("SET TIME ZONE 'America/Argentina/Buenos_Aires'") as unknown as Promise<void>,
  ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (err) => logger.error('Error inesperado en el pool de PG', err.message));

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as never);
}

/** Ejecuta fn dentro de una transaccion: COMMIT si todo sale bien, ROLLBACK si falla. */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* la conexion ya pudo cortarse */
    }
    throw err;
  } finally {
    client.release();
  }
}
