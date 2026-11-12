"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.query = query;
exports.withTx = withTx;
const pg_1 = require("pg");
const env_1 = require("../config/env");
const logger_1 = require("../lib/logger");
const isSupabase = env_1.config.databaseUrl.includes('supabase');
// Zona horaria fija de la empresa en TODAS las sesiones del pool: sin esto,
// "hoy" cierra a las 21:00 cuando el Postgres corre en UTC y confunde
// conteos por día, entregas del día y reportes.
// Se usa la OPCION onConnect (no el evento pool.on('connect')): pg-pool
// ESPERA esta promesa antes de despachar la primer query del cliente, así
// el SET TIME ZONE nunca pisa/compite con una consulta de usuario.
exports.pool = new pg_1.Pool({
    connectionString: env_1.config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    onConnect: (client) => client.query("SET TIME ZONE 'America/Argentina/Buenos_Aires'"),
    ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
});
exports.pool.on('error', (err) => logger_1.logger.error('Error inesperado en el pool de PG', err.message));
async function query(text, params) {
    return exports.pool.query(text, params);
}
/** Ejecuta fn dentro de una transaccion: COMMIT si todo sale bien, ROLLBACK si falla. */
async function withTx(fn) {
    const client = await exports.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        try {
            await client.query('ROLLBACK');
        }
        catch {
            /* la conexion ya pudo cortarse */
        }
        throw err;
    }
    finally {
        client.release();
    }
}
