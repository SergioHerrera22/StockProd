import { Router } from 'express';
import { pool, query } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired } from '../../middleware/auth';
import { writeAudit } from '../../services/audit.service';
import { config } from '../../config/env';

const router = Router();
router.use(authRequired);

/**
 * Sesiones activas.
 * - Admin: ve todas las sesiones activas del sistema.
 * - Otros usuarios: solo las propias.
 */
router.get(
  '/',
  asyncH(async (req, res) => {
    const isAdmin = req.user!.role === 'ADMIN';
    const params: unknown[] = [];
    const where = `
      revoked_at IS NULL
      AND expires_at > now()
      ${config.sessionIdleMinutes > 0 ? `AND last_seen_at >= now() - ($1::numeric * interval '1 minute')` : ''}`;
    if (config.sessionIdleMinutes > 0) params.push(config.sessionIdleMinutes);
    if (!isAdmin) { params.push(req.user!.id); }

    const r = await query(
      `SELECT s.id, s.user_id, u.full_name AS user_name, u.username, l.name AS location_name,
              s.ip, s.user_agent, s.created_at, s.last_seen_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN locations l ON l.id = u.default_location_id
       WHERE ${where}
       ${!isAdmin ? `AND s.user_id = $${params.length}` : ''}
       ORDER BY s.last_seen_at DESC`,
      params
    );

    res.json({
      sessions: r.rows.map((row: Record<string, unknown>) => ({
        ...row,
        is_own: row.user_id === req.user!.id,
      })),
    });
  })
);

/** Desconectar una sesión. Admin: cualquiera. Usuario: solo la propia. */
router.post(
  '/:id/revoke',
  asyncH(async (req, res) => {
    const id = String(req.params.id);
    const isAdmin = req.user!.role === 'ADMIN';

    const target = await query<{ user_id: number }>('SELECT user_id FROM sessions WHERE id = $1', [id]);
    if (!target.rows[0]) throw ApiError.notFound('Sesión no encontrada');
    if (!isAdmin && target.rows[0].user_id !== req.user!.id) {
      throw ApiError.forbidden('Solo podés cerrar tus propias sesiones');
    }

    await query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'Cerrada por el administrador'
       WHERE id = $1 AND revoked_at IS NULL`,
      [id]
    );
    await writeAudit(pool, {
      userId: req.user!.id,
      action: 'SESSION_REVOKE',
      entity: 'session',
      entityId: null,
      details: { sessionId: id, targetUser: target.rows[0].user_id },
      ip: req.ip,
    });
    res.json({ ok: true });
  })
);

export default router;
