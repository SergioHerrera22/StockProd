import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../db/pool';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Claves de idempotencia (punto 9 del audit de integridad).
 *
 * Problema: una confirmacion puede haber ocurrido en el servidor aunque el
 * navegador no reciba la respuesta (red caida). Si el usuario reintenta el
 * POST, el resultado depende de los guards de estado: 409 confuso, o datos
 * duplicados. Con la clave header `Idempotency-Key`, el reintento devuelve la
 * RESPUESTA GUARDADA sin re-ejecutar la operacion.
 *
 * Semantica:
 *  - Sin header: la ruta corre normal (compatibilidad total).
 *  - Header presente + primer intento: corre y guarda status + body.
 *  - Header presente + reintento con mismo body y usuario: replay 1:1.
 *  - Header presente reutilizado con OTRO body/usuario: 409 explicito.
 *  - Respuesta 5xx: NO se guarda y se borra la clave (reintento permitido).
 *  - Las respuestas de error de negocio (400/403/409) SI se guardan: volver a
 *    lanzar la misma operacion no cambiaria el resultado.
 *  - Limpieza: filas de mas de 24h se borran con probabilidad 1/32 por request.
 */

const KEY_RE = /^[A-Za-z0-9_-]{6,64}$/;
const PENDING_BODY = '{"_pending":true}';

function bodyHash(req: Request): string {
  return crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

interface IdempRow {
  request_hash: string;
  status_code: number;
  response_body: unknown;
  user_id: number;
}

export function idempotent(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = String(req.header('Idempotency-Key') ?? '').trim();
      if (!key) return await handler(req, res, next);
      if (!KEY_RE.test(key)) {
        return next(ApiError.badRequest('Formato invalido de Idempotency-Key'));
      }
      if (!req.user) return next(ApiError.unauthorized()); // todas las rutas cubiertas son autenticadas

      const requestHash = bodyHash(req);
      const select = 'SELECT request_hash, status_code, response_body, user_id FROM idempotency_keys WHERE key = $1';

      const first = await query<IdempRow>(select, [key]);
      if (first.rows[0]) {
        return replayOrConflict(res, next, requestHash, req.user.id, first.rows[0]);
      }

      // Reservar la clave atomicamente; si pierde la carrera, otro request esta
      // ejecutando la misma operacion: NO re-ejecutar.
      const ins = await query<{ key: string }>(
        `INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4, $5, 0, '${PENDING_BODY}'::jsonb)
         ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key, req.user.id, req.method, req.path, requestHash]
      );
      if (!ins.rows[0]) {
        const again = await query<IdempRow>(select, [key]);
        if (!again.rows[0]) {
          return next(ApiError.conflict('No se pudo reservar la clave de idempotencia'));
        }
        return replayOrConflict(res, next, requestHash, req.user.id, again.rows[0]);
      }

      const origJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        if (status >= 500) {
          // Error inesperado de servidor: permitir reintento limpio de la operacion.
          void query('DELETE FROM idempotency_keys WHERE key = $1 AND status_code = 0', [key]).catch((e) => {
            logger.error('idempotency: no se pudo borrar la clave en error 5xx', e instanceof Error ? e.message : String(e));
          });
        } else {
          void query(
            `UPDATE idempotency_keys SET status_code = $2, response_body = $3::jsonb
             WHERE key = $1 AND status_code = 0`,
            [key, status, JSON.stringify(body ?? null)]
          ).catch((e) => {
            logger.error('idempotency: no se pudo guardar la respuesta', e instanceof Error ? e.message : String(e));
          });
        }
        return origJson(body);
      }) as typeof res.json;

      // Limpieza probabilistica de claves viejas (sin cron dedicado)
      if (Math.random() < 0.03125) {
        void query('DELETE FROM idempotency_keys WHERE created_at < now() - interval \'24 hours\'').catch(() => {});
      }

      await handler(req, res, next);
    } catch (e) {
      next(e);
    }
  };
}

function replayOrConflict(
  res: Response,
  next: NextFunction,
  requestHash: string,
  userId: number,
  row: IdempRow,
) {
  if (row.status_code === 0) {
    // Otro request con la misma clave esta en curso: no re-ejecutar ni replay.
    return next(ApiError.conflict('Operacion en curso con esa clave; no la repetas, esperá la respuesta.'));
  }
  if (row.request_hash !== requestHash) {
    return next(ApiError.conflict('La clave de idempotencia ya se uso con otro contenido'));
  }
  if (row.user_id !== userId) {
    return next(ApiError.conflict('La clave de idempotencia pertenece a otro usuario'));
  }
  res.status(row.status_code).json(row.response_body);
}
