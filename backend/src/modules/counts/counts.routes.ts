import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam } from '../../lib/pagination';
import { createCount, saveCountItems, applyCount, voidCount, getCount, listCounts } from './counts.service';

const router = Router();
router.use(authRequired, requirePerm('counts.read'));

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listCounts({ locationId: intParam(req.query.locationId), page, pageSize, offset });
    res.json({ ...result, page, pageSize });
  })
);

router.get('/:id', asyncH(async (req, res) => {
  const count = await getCount(parseInt(req.params.id, 10));
  if (!count) return res.status(404).json({ error: 'Inventario no encontrado' });
  res.json({ count });
}));

router.post(
  '/',
  requirePerm('counts.write'),
  asyncH(async (req, res) => {
    const { locationId, notes, productIds } = z
      .object({
        locationId: z.number().int().positive(),
        notes: z.string().max(2000).nullable().optional(),
        productIds: z.array(z.number().int().positive()).optional(),
      })
      .parse(req.body);
    const result = await createCount(req.user!, req.ip, locationId, notes ?? null, productIds);
    res.status(201).json(result);
  })
);

router.put(
  '/:id/items',
  requirePerm('counts.write'),
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { items } = z
      .object({
        items: z.array(
          z.object({ itemId: z.number().int().positive(), countedQuantity: z.number().min(0) })
        ).min(1),
      })
      .parse(req.body);
    const result = await saveCountItems(req.user!, req.ip, id, items);
    res.json(result);
  })
);

router.post(
  '/:id/apply',
  requirePerm('counts.apply'),
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { reason } = z.object({ reason: z.string().min(5, 'El motivo es obligatorio').max(255) }).parse(req.body);
    const result = await applyCount(req.user!, req.ip, id, reason);
    res.json(result);
  })
);

router.post(
  '/:id/void',
  requirePerm('counts.write'),
  asyncH(async (req, res) => {
    await voidCount(req.user!, req.ip, parseInt(req.params.id, 10));
    res.json({ ok: true });
  })
);

export default router;
