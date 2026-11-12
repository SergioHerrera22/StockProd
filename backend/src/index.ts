import { createApp } from './app';
import { config } from './config/env';
import { logger } from './lib/logger';
import { pool } from './db/pool';
import { startScheduler, stopScheduler } from './jobs/scheduler';

const app = createApp();
let schedulerStarted = false;
let databaseCheckInProgress = false;
let shuttingDown = false;

async function checkDatabase() {
  if (databaseCheckInProgress || schedulerStarted || shuttingDown) return;

  databaseCheckInProgress = true;
  try {
    await pool.query('SELECT 1');
    logger.info('Conexion a PostgreSQL OK');

    if (!schedulerStarted) {
      startScheduler();
      schedulerStarted = true;
      logger.info('Scheduler iniciado tras confirmar la conexión a PostgreSQL');
    }
  } catch (err) {
    logger.error(
      'PostgreSQL no disponible. Se reintentará en 10 segundos:',
      (err as Error).message
    );
  } finally {
    databaseCheckInProgress = false;
  }
}

// Hostinger debe detectar el listener sin esperar a que PostgreSQL esté disponible.
const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`API Robles Stock escuchando en puerto ${config.port} [${config.env}]`);
  void checkDatabase();
});

// Reintentos en segundo plano. No se termina el proceso por una caída de PostgreSQL.
const databaseRetry = setInterval(() => {
  void checkDatabase();
}, 10_000);
databaseRetry.unref();

server.on('error', (err) => {
  logger.error('Error del servidor HTTP:', err.message);
  process.exitCode = 1;
  clearInterval(databaseRetry);
  stopScheduler();
  void pool.end();
});

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Recibida señal ${signal}. Cerrando servidor...`);
  clearInterval(databaseRetry);
  stopScheduler();

  const forceExit = setTimeout(() => {
    logger.error('Tiempo agotado durante el cierre; finalizando proceso.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    void pool.end()
      .then(() => {
        clearTimeout(forceExit);
        logger.info('Servidor HTTP y pool de PostgreSQL cerrados correctamente');
        process.exit(0);
      })
      .catch((err) => {
        clearTimeout(forceExit);
        logger.error('Error cerrando el pool de PostgreSQL:', err);
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
