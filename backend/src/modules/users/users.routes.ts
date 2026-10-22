import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { writeAudit } from '../../services/audit.service';
import { pathId } from '../../lib/pagination';

const router = Router();
router.use(authRequired);

const userSchema = z.object({
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'Solo letras, numeros, punto, guion y guion bajo'),
  fullName: z.string().min(3).max(120),
  role: z.enum(['ADMIN', 'ENCARGADO', 'EMPLEADO']),
  defaultLocationId: z.number().int().positive().nullable().optional(),
  password: z.string().min(6).max(100).optional(),
  isActive: z.boolean().optional(),
  restrictToLocation: z.boolean().optional(),
});

function validateRestriction(data: { restrictToLocation?: boolean; defaultLocationId?: number | null }) {
  if (data.restrictToLocation && !data.defaultLocationId) {
    throw ApiError.badRequest('Para restringir por ubicación primero asigná la ubicación habitual');
  }
}

router.get(
  '/',
  requirePerm('users.manage'),
  asyncH(async (_req, res) => {
    const r = await query(
      `SELECT u.id, u.username, u.full_name, u.role_code, u.default_location_id,
              l.name AS location_name, u.is_active, u.restrict_to_location, u.last_login_at, u.created_at
       FROM users u
       LEFT JOIN locations l ON l.id = u.default_location_id
       ORDER BY u.username`
    );
    res.json({ users: r.rows });
  })
);

router.post(
  '/',
  requirePerm('users.manage'),
  asyncH(async (req, res) => {
    const data = userSchema.parse(req.body);
    if (!data.password) throw ApiError.badRequest('La contraseña inicial es obligatoria');
    const hash = await bcrypt.hash(data.password, 10);

    const created = await withTx(async (c) => {
      validateRestriction(data);
      const r = await c.query<{ id: number }>(
        `INSERT INTO users (username, password_hash, full_name, role_code, default_location_id, restrict_to_location)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [data.username, hash, data.fullName, data.role, data.defaultLocationId ?? null, data.restrictToLocation ?? false]
      );
      await writeAudit(c, {
        userId: req.user!.id, action: 'USER_CREATE', entity: 'user',
        entityId: r.rows[0].id, details: { username: data.username, role: data.role }, ip: req.ip,
      });
      return r.rows[0].id;
    });

    res.status(201).json({ id: created });
  })
);

router.put(
  '/:id',
  requirePerm('users.manage'),
  asyncH(async (req, res) => {
    const id = pathId(req.params.id);
    const data = userSchema.partial().parse(req.body);
    if (data.password) throw ApiError.badRequest('Usa la opcion de restablecer contraseña');

    const current = await query('SELECT id FROM users WHERE id = $1', [id]);
    if (!current.rows[0]) throw ApiError.notFound('Usuario no encontrado');

    const locParam = data.defaultLocationId === undefined ? null : data.defaultLocationId;
    validateRestriction(data);

    await withTx(async (c) => {
      await c.query(
        `UPDATE users SET
           username = COALESCE($1, username),
           full_name = COALESCE($2, full_name),
           role_code = COALESCE($3, role_code),
           default_location_id = $4,
           is_active = COALESCE($5, is_active),
           restrict_to_location = COALESCE($6, restrict_to_location)
         WHERE id = $7`,
        [
          data.username ?? null,
          data.fullName ?? null,
          data.role ?? null,
          locParam,
          data.isActive ?? null,
          data.restrictToLocation ?? null,
          id,
        ]
      );
      await writeAudit(c, {
        userId: req.user!.id, action: 'USER_UPDATE', entity: 'user', entityId: id,
        details: data, ip: req.ip,
      });
    });

    res.json({ ok: true });
  })
);

router.post(
  '/:id/reset-password',
  requirePerm('users.manage'),
  asyncH(async (req, res) => {
    const id = pathId(req.params.id);
    const { password } = z.object({ password: z.string().min(6).max(100) }).parse(req.body);
    const hash = await bcrypt.hash(password, 10);
    const r = await query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [hash, id]);
    if (!r.rows[0]) throw ApiError.notFound('Usuario no encontrado');
    await withTx((c) =>
      writeAudit(c, {
        userId: req.user!.id, action: 'USER_RESET_PASSWORD', entity: 'user', entityId: id, ip: req.ip,
      })
    );
    res.json({ ok: true });
  })
);

export default router;
