import { Pool, PoolClient, ClientBase, QueryResult, QueryResultRow } from 'pg';
import { rootCertificates } from 'tls';
import { config } from '../config/env';
import { logger } from '../lib/logger';

const isSupabase = config.databaseUrl.includes('supabase');

function getDatabaseConnectionOptions() {
  if (!isSupabase) {
    return { connectionString: config.databaseUrl };
  }

  // Parse and sanitize the URL without allowing sslmode=require to replace
  // the explicit certificate-validation settings supplied below.
  let connectionString = config.databaseUrl;
  try {
    const parsedUrl = new URL(config.databaseUrl);
    parsedUrl.searchParams.delete('sslmode');
    parsedUrl.searchParams.delete('uselibpqcompat');
    connectionString = parsedUrl.toString();
  } catch (err) {
    // Do not prevent Express from listening because DB configuration is bad.
    // The first connection attempt will report the actionable PostgreSQL error.
    logger.error('DATABASE_URL de Supabase no tiene un formato URL válido:', (err as Error).message);
    return {
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: true },
    };
  }

  const caCertificate = process.env.SUPABASE_CA_CERT?.replace(/\\n/g, '\n').trim();

  if (!caCertificate) {
    // Keep TLS verification enabled. Node's trusted roots are used as a
    // fallback; if Supabase requires its project CA, the connection will fail
    // safely and the startup retry loop will keep the HTTP server available.
    logger.warn('SUPABASE_CA_CERT no está configurado; se usarán las CA confiables de Node.js con validación TLS estricta.');
    return {
      connectionString,
      ssl: { rejectUnauthorized: true },
    };
  }

  if (
    !caCertificate.includes('-----BEGIN CERTIFICATE-----') ||
    !caCertificate.includes('-----END CERTIFICATE-----')
  ) {
    logger.error('SUPABASE_CA_CERT no contiene un certificado PEM válido; se mantiene la validación TLS estricta con las CA de Node.js.');
    return {
      connectionString,
      ssl: { rejectUnauthorized: true },
    };
  }

  // pg-connection-string can override ssl.ca when parsing sslmode.
  // Keep Node's public roots and add the Supabase project CA explicitly.
  return {
    connectionString,
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
  onConnect: (client: ClientBase) =>
    client.query("SET TIME ZONE 'America/Argentina/Buenos_Aires'") as unknown as Promise<void>,
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
