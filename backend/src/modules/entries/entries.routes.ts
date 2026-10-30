import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { idempotent } from '../../middleware/idempotency';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam, pathId } from '../../lib/pagination';
import { createEntry, confirmEntry, voidEntry, getEntry, listEntries, approveEntry } from './entries.service';

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
  supplierId: z.number().int().positive().nullable().optional(),
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
  const entry = await getEntry(pathId(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Entrada no encontrada' });
  res.json({ entry });
}));

router.post(
  '/',
  requirePerm('entries.write'),
  idempotent(asyncH(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const confirm = req.query.confirm === 'true';
    const result = await createEntry(req.user!, req.ip, input, confirm);
    res.status(201).json(result);
  }))
);

router.post(
  '/:id/confirm',
  requirePerm('entries.confirm'),
  idempotent(asyncH(async (req, res) => {
    await confirmEntry(req.user!, req.ip, pathId(req.params.id));
    res.json({ ok: true });
  }))
);

router.post(
  '/:id/approve',
  requirePerm('entries.approve'),
  asyncH(async (req, res) => {
    const result = await approveEntry(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

router.post(
  '/:id/void',
  requirePerm('entries.void'),
  idempotent(asyncH(async (req, res) => {
    const { reason, voidApprovedBy } = z.object({
      reason: z.string().min(5).max(255),
      voidApprovedBy: z.number().int().positive().optional()
    }).parse(req.body);
    await voidEntry(req.user!, req.ip, pathId(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
  }))
);

export default router;