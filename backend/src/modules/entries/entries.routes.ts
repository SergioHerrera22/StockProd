import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam } from '../../lib/pagination';
import { createEntry, confirmEntry, voidEntry, getEntry, listEntries } from './entries.service';

const router = Router();
router.use(authRequired, requirePerm('entries.read'));

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative().nullable().optional(),
});

const draftSchema = z.object({
  locationId: z.number().int().positive(),
  type: z.enum(['COMPRA', 'DEVOLUCION', 'OTRO']),
  supplier: z.string().max(150).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(itemSchema).min(1),
});

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listEntries({
      status: strParam(req.query.status),
      locationId: intParam(req.query.locationId),
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.get('/:id', asyncH(async (req, res) => {
  const entry = await getEntry(parseInt(req.params.id, 10));
  if (!entry) return res.status(404).json({ error: 'Entrada no encontrada' });
  res.json({ entry });
}));

router.post(
  '/',
  requirePerm('entries.write'),
  asyncH(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const confirm = req.query.confirm === 'true';
    const result = await createEntry(req.user!, req.ip, input, confirm);
    res.status(201).json(result);
  })
);

router.post(
  '/:id/confirm',
  requirePerm('entries.write'),
  asyncH(async (req, res) => {
    await confirmEntry(req.user!, req.ip, parseInt(req.params.id, 10));
    res.json({ ok: true });
  })
);

router.post(
  '/:id/void',
  requirePerm('entries.write'),
  asyncH(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(5).max(255) }).parse(req.body);
    await voidEntry(req.user!, req.ip, parseInt(req.params.id, 10), reason);
    res.json({ ok: true });
  })
);

export default router;
