import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  return value;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', 'dev-secret-no-usar-en-produccion'),
  jwtExpires: process.env.JWT_EXPIRES ?? '12h',
  // Minutos de inactividad antes de cerrar la sesión automáticamente (0 = desactivado)
  sessionIdleMinutes: parseFloat(process.env.SESSION_IDLE_MINUTES ?? '30'),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  isProd: process.env.NODE_ENV === 'production',
};
