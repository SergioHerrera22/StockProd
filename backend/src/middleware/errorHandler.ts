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

  const anyErr = err as {
    code?: string; detail?: string; constraint?: string; column?: string; table?: string; message?: string;
  };

  // Violaciones de unicidad / FK / CHECK / NOT NULL de PostgreSQL.
  // Se incluye el detalle del motor (constraint, columna) para poder diagnosticar
  // el origen real del problema desde el mensaje que ve el usuario.
  if (anyErr?.code === '23505') {
    return res.status(409).json({
      error: anyErr.constraint ? `Registro duplicado (${anyErr.constraint})` : 'Registro duplicado',
      details: anyErr.detail,
    });
  }
  if (anyErr?.code === '23503') {
    return res.status(409).json({ error: 'Referencia invalida: el registro relacionado no existe', details: anyErr.detail });
  }
  if (anyErr?.code === '23514') {
    return res.status(400).json({
      error: anyErr.constraint
        ? `Los datos violan una restriccion de integridad (${anyErr.constraint})`
        : 'Los datos violan una restriccion de integridad',
      details: anyErr.detail,
    });
  }
  if (anyErr?.code === '23P01') {
    return res.status(409).json({ error: 'Operacion excluyente: el registro ya fue procesado' });
  }
  if (anyErr?.code === '23502') {
    const campo = anyErr.column ? ` de "${anyErr.column}"` : '';
    const tabla = anyErr.table ? ` en "${anyErr.table}"` : '';
    return res.status(400).json({
      error: `Falta un dato obligatorio${campo}${tabla}`,
      details: anyErr.detail,
      column: anyErr.column,
      table: anyErr.table,
    });
  }

  const dbg = [
    anyErr?.code ? `code=${anyErr.code}` : null,
    anyErr?.constraint ? `constraint=${anyErr.constraint}` : null,
    anyErr?.table ? `table=${anyErr.table}` : null,
    anyErr?.column ? `column=${anyErr.column}` : null,
    anyErr?.detail ? `detail=${anyErr.detail}` : null,
  ].filter(Boolean).join(' ');
  logger.error(
    `Error no manejado en ${req.method} ${req.originalUrl}: ${anyErr?.message ?? err}` +
      (dbg ? ` [${dbg}]` : ''),
    err instanceof Error ? err.stack : undefined
  );
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
