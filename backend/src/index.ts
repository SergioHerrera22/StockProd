import { createApp } from './app';
import { config } from './config/env';
import { logger } from './lib/logger';
import { pool } from './db/pool';
import { startScheduler } from './jobs/scheduler';

const app = createApp();

// Hostinger exige que el proceso llame listen() inmediatamente.
// No esperar PostgreSQL antes de abrir el puerto: la inicialización de
// servicios se ejecuta después de que el servidor ya está escuchando.
const server = app.listen(config.port, () => {
  logger.info(`API Robles Stock escuchando en http://localhost:${config.port} [${config.env}]`);
  void initializeServices();
});

async function initializeServices() {
  try {
    await pool.query('SELECT 1');
    logger.info('Conexion a PostgreSQL OK');
    logger.info('DATABASE_URL usada: ' + config.databaseUrl.replace(/:[^:@]*@/, ':***@'));
    startScheduler();
  } catch (err) {
    logger.error('No se pudo inicializar la conexion a PostgreSQL:', (err as Error).message);
    logger.error('Revisa DATABASE_URL en backend/.env');
    // No dejar un proceso aparentemente sano pero sin base de datos.
    server.close(() => process.exit(1));
  }
}
