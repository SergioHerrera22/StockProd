import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { z } from 'zod';
import { pool, query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { config } from '../../config/env';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, AuthUser } from '../../middleware/auth';
import { writeAudit } from '../../services/audit.service';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1, 'Ingresá el usuario').max(60),
  password: z.string().min(1, 'Ingresá la contraseña').max(200),
});

/** Convierte '12h' | '30m' | '7d' | '3600s' a milisegundos. */
function parseExpiresMs(value: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
  if (!m) return 12 * 60 * 60 * 1000;
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(m[1], 10) * mult[m[2].toLowerCase()];
}

router.post(
  '/login',
  asyncH(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);

    const r = await query<{
      id: number; username: string; password_hash: string; full_name: string;
      role_code: AuthUser['role']; default_location_id: number | null;
      restrict_to_location: boolean; is_active: boolean;
    }>(
      `SELECT id, username, password_hash, full_name, role_code, default_location_id, restrict_to_location, is_active
       FROM users WHERE lower(username) = lower($1)`,
      [username.trim()]
    );

    const user = r.rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok || !user?.is_active) {
      // Registro de intentos fallidos (anti fuerza bruta / trazabilidad)
      await writeAudit(pool, {
        userId: user?.id ?? null,
        action: 'LOGIN_FAILED',
        entity: 'user',
        entityId: user?.id ?? null,
        details: { username: username.trim(), motivo: !user ? 'usuario inexistente' : 'contraseña incorrecta' },
        ip: req.ip,
      });
      throw ApiError.unauthorized('Usuario o contraseña incorrectos');
    }

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    // ===== Sesión server-side =====
    const sessionId = crypto.randomUUID();
    const expiresMs = parseExpiresMs(config.jwtExpires);
    const expiresAt = new Date(Date.now() + expiresMs).toISOString();

    // Limpieza de sesiones muertas (vencidas hace más de 1 día)
    await query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`).catch(() => {});

    await query(
      `INSERT INTO sessions (id, user_id, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [sessionId, user.id, req.ip ?? null, (req.headers['user-agent'] ?? '').slice(0, 250), expiresAt]
    );

    const token = jwt.sign({ sub: user.id, sid: sessionId }, config.jwtSecret, {
      expiresIn: config.jwtExpires,
    } as jwt.SignOptions);

    const authUser = {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role_code,
      locationId: user.default_location_id,
    };

    await writeAudit(pool, {
      userId: user.id,
      action: 'LOGIN',
      entity: 'user',
      entityId: user.id,
      details: { username: user.username },
      ip: req.ip,
    });

    res.json({ token, user: authUser });
  })
);

router.get(
  '/me',
  authRequired,
  asyncH(async (req, res) => {
    res.json({ user: req.user });
  })
);

/** Configuración de sesión para el frontend (temporizador de inactividad). */
router.get(
  '/config',
  authRequired,
  asyncH(async (_req, res) => {
    res.json({ idleMinutes: config.sessionIdleMinutes });
  })
);

/** Logout real: revoca la sesión en el servidor. */
router.post(
  '/logout',
  authRequired,
  asyncH(async (req, res) => {
    await query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'Logout' WHERE id = $1 AND revoked_at IS NULL`,
      [req.user!.sessionId]
    );
    res.json({ ok: true });
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres').max(100),
});

router.post(
  '/change-password',
  authRequired,
  asyncH(async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const r = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user!.id]
    );
    const ok = await bcrypt.compare(currentPassword, r.rows[0]?.password_hash ?? '');
    if (!ok) throw ApiError.badRequest('La contraseña actual es incorrecta');

    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user!.id]);
    await withTx((c) =>
      writeAudit(c, {
        userId: req.user!.id,
        action: 'CHANGE_PASSWORD',
        entity: 'user',
        entityId: req.user!.id,
        ip: req.ip,
      })
    );
    res.json({ ok: true });
  })
);

export default router;
