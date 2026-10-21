import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';

const router = Router();
router.use(authRequired);

router.get(
  '/',
  asyncH(async (_req, res) => {
    const r = await query(
      `SELECT id, name, description, is_active FROM categories WHERE is_active ORDER BY name`
    );
    res.json({ categories: r.rows });
  })
);

router.post(
  '/',
  requirePerm('categories.write'),
  asyncH(async (req, res) => {
    const { name, description } = z
      .object({ name: z.string().min(2).max(120), description: z.string().max(255).optional() })
      .parse(req.body);
    const r = await query<{ id: number }>(
      `INSERT INTO categories (name, description) VALUES ($1,$2)
       ON CONFLICT (name) DO UPDATE SET is_active = true RETURNING id`,
      [name.trim(), description ?? null]
    );
    res.status(201).json({ id: r.rows[0].id });
  })
);

router.delete(
  '/:id',
  requirePerm('categories.write'),
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const used = await query('SELECT id FROM products WHERE category_id = $1 LIMIT 1', [id]);
    if (used.rows[0]) throw ApiError.conflict('Hay productos usando esta categoria');
    await query('UPDATE categories SET is_active = false WHERE id = $1', [id]);
    res.json({ ok: true });
  })
);

export default router;
