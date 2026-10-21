import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam } from '../../lib/pagination';
import { createDelivery, updateDelivery, confirmDelivery, voidDelivery, getDelivery, listDeliveries } from './deliveries.service';

const router = Router();
router.use(authRequired, requirePerm('deliveries.read'));

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().positive(),
  requestedQuantity: z.number().nonnegative().nullable().optional(),
});

const draftSchema = z.object({
  locationId: z.number().int().positive(),
  invoiceNumber: z.string().max(40).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(itemSchema).min(1),
});

router.get(
  '/',
  requirePerm('deliveries.read'),
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listDeliveries({
      status: strParam(req.query.status),
      locationId: intParam(req.query.locationId),
      q: strParam(req.query.q),
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.get(
  '/:id',
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const delivery = await getDelivery(id);
    if (!delivery) return res.status(404).json({ error: 'Entrega no encontrada' });
    res.json({ delivery });
  })
);

router.post(
  '/',
  requirePerm('deliveries.write'),
  asyncH(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const confirm = req.query.confirm === 'true';
    const result = await createDelivery(req.user!, req.ip, input, confirm);
    res.status(201).json(result);
  })
);

router.put(
  '/:id',
  requirePerm('deliveries.write'),
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const input = draftSchema.parse(req.body);
    const result = await updateDelivery(req.user!, req.ip, id, input);
    res.json(result);
  })
);

router.post(
  '/:id/confirm',
  requirePerm('deliveries.write'),
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await confirmDelivery(req.user!, req.ip, id);
    res.json({ ok: true });
  })
);

router.post(
  '/:id/void',
  requirePerm('deliveries.void'),
  asyncH(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { reason } = z.object({ reason: z.string().min(5, 'Explica el motivo (minimo 5 caracteres)').max(255) }).parse(req.body);
    await voidDelivery(req.user!, req.ip, id, reason);
    res.json({ ok: true });
  })
);

export default router;
