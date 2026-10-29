import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { idempotent } from '../../middleware/idempotency';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam, pathId } from '../../lib/pagination';
import { 
  createTransfer, 
  receiveTransfer, 
  voidTransfer, 
  getTransfer, 
  listTransfers,
  approveTransfer,
  rejectTransfer,
  verifyTransferReceipt
} from './transfers.service';

const router = Router();
router.use(authRequired, requirePerm('transfers.read'));

const draftSchema = z.object({
  originLocationId: z.number().int().positive(),
  destinationLocationId: z.number().int().positive(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().positive() })).min(1),
  driverUserId: z.number().int().positive().nullable().optional(),
  driverId: z.number().int().positive().nullable().optional(),
  deliveryAddress: z.string().max(250).nullable().optional(),
  deliveryLat: z.number().nullable().optional(),
  deliveryLng: z.number().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  deliveryObservations: z.string().nullable().optional(),
});

router.get(
  '/',
  asyncH(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req, 20);
    const result = await listTransfers({
      status: strParam(req.query.status),
      locationId: intParam(req.query.locationId),
      page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
  })
);

router.get('/:id', asyncH(async (req, res) => {
  const transfer = await getTransfer(pathId(req.params.id));
  if (!transfer) return res.status(404).json({ error: 'Transferencia no encontrada' });
  res.json({ transfer });
}));

router.post(
  '/',
  requirePerm('transfers.write'),
  idempotent(asyncH(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const result = await createTransfer(req.user!, req.ip, input);
    res.status(201).json(result);
  }))
);

router.post(
  '/:id/approve',
  requirePerm('transfers.approve'),
  asyncH(async (req, res) => {
    const result = await approveTransfer(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

router.post(
  '/:id/reject',
  requirePerm('transfers.approve'),
  asyncH(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(5).max(255) }).parse(req.body);
    const result = await rejectTransfer(req.user!, req.ip, pathId(req.params.id), reason);
    res.json(result);
  })
);

router.post(
  '/:id/receive',
  requirePerm('transfers.receive'),
  idempotent(asyncH(async (req, res) => {
    const id = pathId(req.params.id);
    const { items } = z
      .object({
        items: z.array(
          z.object({ itemId: z.number().int().positive(), quantityReceived: z.number().min(0) })
        ).min(1),
      })
      .parse(req.body);
    const result = await receiveTransfer(req.user!, req.ip, id, items);
    res.json(result);
  }))
);

router.post(
  '/:id/verify',
  requirePerm('transfers.verify'),
  asyncH(async (req, res) => {
    const result = await verifyTransferReceipt(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

router.post(
  '/:id/void',
  requirePerm('transfers.void'),
  idempotent(asyncH(async (req, res) => {
    const { reason, voidApprovedBy } = z.object({
      reason: z.string().min(5).max(255),
      voidApprovedBy: z.number().int().positive().optional()
    }).parse(req.body);
    await voidTransfer(req.user!, req.ip, pathId(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
  }))
);

export default router;