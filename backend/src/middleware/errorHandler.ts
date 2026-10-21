import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';
import { config } from '../config/env';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    return res.status(400).json({ error: 'Datos invalidos', details });
  }

  const anyErr = err as { code?: string; detail?: string; constraint?: string; message?: string };

  // Violaciones de unicidad / FK de PostgreSQL
  if (anyErr?.code === '23505' || anyErr?.code === '23505') {
    return res.status(409).json({ error: 'Registro duplicado', details: anyErr.detail });
  }
  if (anyErr?.code === '23503') {
    return res.status(409).json({ error: 'Referencia invalida: el registro relacionado no existe' });
  }
  if (anyErr?.code === '23514') {
    return res.status(400).json({ error: 'Los datos violan una restriccion de integridad' });
  }
  if (anyErr?.code === '23P01') {
    return res.status(409).json({ error: 'Operacion excluyente: el registro ya fue procesado' });
  }
  if (anyErr?.code === '23505') {
    return res.status(409).json({ error: 'Registro duplicado' });
  }
  if (anyErr?.code === '23502') {
    return res.status(400).json({ error: 'Falta un dato obligatorio' });
  }

  logger.error(`Error no manejado en ${req.method} ${req.originalUrl}:`, anyErr?.message ?? err);
  return res.status(500).json({
    error: 'Error interno del servidor',
    ...(config.isProd ? {} : { detail: anyErr?.message }),
  });
}

/** Envuelve handlers async para que los errores lleguen al errorHandler. */
export function asyncH(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
