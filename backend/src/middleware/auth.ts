import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { ApiError } from '../lib/errors';
import { hasPermission, Permission, Role } from '../lib/permissions';
import { query } from '../db/pool';
import { logger } from '../lib/logger';

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  /** Ubicación habitual (puede ser null). */
  locationId: number | null;
  /** Si está restringido, solo puede operar en su ubicación habitual. */
  restrictToLocation: boolean;
  /** Id de sesión activa (tabla sessions). */
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface SessionRow {
  id: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  expires_at: string;
  last_seen_at: string;
}

export function authRequired(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(ApiError.unauthorized('Sesión no iniciada'));
  }
  const token = header.slice(7);
  let payload: { sub: number; sid: string };
  try {
    payload = jwt.verify(token, config.jwtSecret) as unknown as { sub: number; sid: string };
  } catch {
    return next(ApiError.unauthorized('Sesión inválida o vencida'));
  }
  if (!payload?.sid) {
    return next(ApiError.unauthorized('Sesión inválida. Volvé a ingresar.'));
  }

  // Se recarga el usuario en cada pedido: si lo desactivan o cambian su rol, aplica al instante.
  query<{
    id: number; username: string; full_name: string; role_code: Role;
    default_location_id: number | null; restrict_to_location: boolean; is_active: boolean;
  }>(
    `SELECT id, username, full_name, role_code, default_location_id, restrict_to_location, is_active
     FROM users WHERE id = $1`,
    [payload.sub]
  )
    .then(async (r) => {
      const u = r.rows[0];
      if (!u || !u.is_active) {
        return next(ApiError.unauthorized('Usuario inactivo o inexistente'));
      }

      // ===== Validación de sesión server-side =====
      const s = await query<SessionRow>(
        `SELECT id, revoked_at, revoked_reason, expires_at, last_seen_at FROM sessions WHERE id = $1`,
        [payload.sid]
      );
      const session = s.rows[0];
      if (!session) return next(ApiError.unauthorized('Sesión inválida. Volvé a ingresar.'));
      if (session.revoked_at) {
        const reason = session.revoked_reason === 'Inactividad'
          ? 'Sesión cerrada por inactividad'
          : 'Sesión cerrada por el administrador';
        return next(ApiError.unauthorized(reason));
      }
      if (new Date(session.expires_at) < new Date()) {
        return next(ApiError.unauthorized('Sesión vencida. Volvé a ingresar.'));
      }

      // Cierre automático por inactividad
      if (config.sessionIdleMinutes > 0) {
        const idle = await query<{ vencida: boolean }>(
          `SELECT last_seen_at < now() - ($2::numeric * interval '1 minute') AS vencida
           FROM sessions WHERE id = $1`,
          [payload.sid, config.sessionIdleMinutes]
        );
        if (idle.rows[0]?.vencida) {
          await query(
            `UPDATE sessions SET revoked_at = now(), revoked_reason = 'Inactividad' WHERE id = $1 AND revoked_at IS NULL`,
            [payload.sid]
          );
          return next(ApiError.unauthorized('Sesión cerrada por inactividad'));
        }
        // Actualiza "última actividad" (como máximo una vez por minuto para no escribir en cada pedido)
        await query(
          `UPDATE sessions SET last_seen_at = now()
           WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'`,
          [payload.sid]
        );
      }

      req.user = {
        id: u.id,
        username: u.username,
        fullName: u.full_name,
        role: u.role_code,
        locationId: u.default_location_id,
        restrictToLocation: u.restrict_to_location,
        sessionId: payload.sid,
      };
      next();
    })
    .catch((err) => {
      logger.error('Error validando sesión:', (err as Error).message);
      next(err);
    });
}

export function requirePerm(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!hasPermission(req.user.role, permission)) {
      return next(ApiError.forbidden());
    }
    next();
  };
}
