import { Router } from 'express';
import { z } from 'zod';
import { query, withTx } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { writeAudit } from '../../services/audit.service';

const router = Router();
router.use(authRequired);

router.get(
  '/',
  asyncH(async (_req, res) => {
    const r = await query(
      `SELECT id, code, name, type, address, is_active, created_at
       FROM locations ORDER BY type DESC, code`
    );
    res.json({ locations: r.rows });
  })
);

const locationSchema = z.object({
  code: z.string().min(1).max(10),
  name: z.string().min(2).max(120),
  type: z.enum(['SUCURSAL', 'DEPOSITO']),
  address: z.string().max(200).optional().nullable(),
  isActive: z.boolean().optional(),
});

router.post(
  '/',
  requirePerm('locations.manage'),
  asyncH(async (req, res) => {
    const data = locationSchema.parse(req.body);
    const created = await withTx(async (c) => {
      const r = await c.query<{ id: number }>(
        `INSERT INTO locations (code, name, type, address) VALUES ($1,$2,$3,$4) RETURNING id`,
        [data.code.toUpperCase(), data.name, data.type, data.address ?? null]
      );
      await writeAudit(c, {
        userId: req.user!.id, action: 'LOCATION_CREATE', entity: 'location',
        entityId: r.rows[0].id, details: data, ip: req.ip,
      });
      return r.rows[0].id;
    });
    res.status(201).json({ id: created });
  })
);

router.put(
  '/:id',
  requirePerm('locations.manage'),
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = locationSchema.partial().parse(req.body);
    const r = await query('SELECT id FROM locations WHERE id = $1', [id]);
    if (!r.rows[0]) throw ApiError.notFound('Ubicacion no encontrada');

    await withTx(async (c) => {
      await c.query(
        `UPDATE locations SET
           code = COALESCE($1, code),
           name = COALESCE($2, name),
           type = COALESCE($3, type),
           address = COALESCE($4, address),
           is_active = COALESCE($5, is_active)
         WHERE id = $6`,
        [
          data.code ? data.code.toUpperCase() : null,
          data.name ?? null,
          data.type ?? null,
          data.address ?? null,
          data.isActive ?? null,
          id,
        ]
      );
      await writeAudit(c, {
        userId: req.user!.id, action: 'LOCATION_UPDATE', entity: 'location',
        entityId: id, details: data, ip: req.ip,
      });
    });
    res.json({ ok: true });
  })
);

export default router;
