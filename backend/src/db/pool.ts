import { Pool, PoolClient, ClientBase, QueryResult, QueryResultRow } from 'pg';
import { rootCertificates } from 'tls';
import { config } from '../config/env';
import { logger } from '../lib/logger';

const isSupabase = config.databaseUrl.includes('supabase');

function getDatabaseConnectionOptions() {
  if (!isSupabase) return { connectionString: config.databaseUrl };

  const caCertificate = process.env.SUPABASE_CA_CERT?.replace(/\\n/g, '\n').trim();
  if (!caCertificate) {
    throw new Error('Falta SUPABASE_CA_CERT: configura el certificado CA de Supabase en las variables de entorno.');
  }
  if (!caCertificate.includes('-----BEGIN CERTIFICATE-----') ||
      !caCertificate.includes('-----END CERTIFICATE-----')) {
    throw new Error('SUPABASE_CA_CERT no contiene un certificado PEM válido.');
  }

  // pg-connection-string puede sobrescribir ssl.ca al interpretar sslmode.
  // Quitamos esos parámetros y conservamos las CA públicas de Node además
  // del certificado raíz específico descargado desde Supabase.
  const connectionUrl = new URL(config.databaseUrl);
  connectionUrl.searchParams.delete('sslmode');
  connectionUrl.searchParams.delete('uselibpqcompat');

  return {
    connectionString: connectionUrl.toString(),
    ssl: {
      ca: [...rootCertificates, caCertificate],
      rejectUnauthorized: true,
    },
  };
}

// Zona horaria fija de la empresa en TODAS las sesiones del pool.
// onConnect hace que pg-pool espere el SET TIME ZONE antes de despachar queries.
export const pool = new Pool({
  ...getDatabaseConnectionOptions(),
  max: 10,
  idleTimeoutMillis: 30000,
  onConnect: (client: ClientBase) => client.query("SET TIME ZONE 'America/Argentina/Buenos_Aires'") as unknown as Promise<void>,
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
