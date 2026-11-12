"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const env_1 = require("./config/env");
const logger_1 = require("./lib/logger");
const pool_1 = require("./db/pool");
const scheduler_1 = require("./jobs/scheduler");
async function main() {
    // Verifica la conexion a la base antes de arrancar
    try {
        await pool_1.pool.query('SELECT 1');
        logger_1.logger.info('Conexion a PostgreSQL OK');
        logger_1.logger.info('DATABASE_URL usada: ' + env_1.config.databaseUrl.replace(/:[^:@]*@/, ':***@'));
    }
    catch (err) {
        logger_1.logger.error('No se pudo conectar a PostgreSQL:', err.message);
        logger_1.logger.error('Revisa DATABASE_URL en backend/.env');
        process.exit(1);
    }
    const app = (0, app_1.createApp)();
    app.listen(env_1.config.port, () => {
        logger_1.logger.info(`API Robles Stock escuchando en http://localhost:${env_1.config.port} [${env_1.config.env}]`);
    });
    // Jobs programados: limpieza de reservas vencidas, auto-cancelacion de
    // retiros vencidos y alertas (ver src/jobs/scheduler.ts)
    (0, scheduler_1.startScheduler)();
}
main().catch((err) => {
    logger_1.logger.error('Error fatal al iniciar:', err);
    process.exit(1);
});
