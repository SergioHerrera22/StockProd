import { createApp } from './app';
import { config } from './config/env';
import { logger } from './lib/logger';
import { pool } from './db/pool';

async function main() {
  // Verifica la conexion a la base antes de arrancar
  try {
    await pool.query('SELECT 1');
    logger.info('Conexion a PostgreSQL OK');
    logger.info('DATABASE_URL usada: ' + config.databaseUrl.replace(/:[^:@]*@/, ':***@'));
  } catch (err) {
    logger.error('No se pudo conectar a PostgreSQL:', (err as Error).message);
    logger.error('Revisa DATABASE_URL en backend/.env');
    process.exit(1);
  }

  const app = createApp();
  app.listen(config.port, () => {
    logger.info(`API Robles Stock escuchando en http://localhost:${config.port} [${config.env}]`);
  });
}

main().catch((err) => {
  logger.error('Error fatal al iniciar:', err);
  process.exit(1);
});
