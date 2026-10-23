import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam, pathId } from '../../lib/pagination';
import { 
  createDelivery, 
  confirmDelivery, 
  voidDelivery, 
  getDelivery, 
  listDeliveries,
  updateDelivery,
  confirmDeliveryWithAlternatives,
  checkDeliveryAvailability,
  approveDelivery,
  getPendingDeliveryForDelivery,
  rederiveShortfalls
} from './deliveries.service';

const router = Router();
router.use(authRequired, requirePerm('deliveries.read'));

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().positive(),
  requestedQuantity: z.number().nonnegative().nullable().optional(),
});

const draftSchema = z.object({
  locationId: z.number().int().positive(),
  invoiceNumber: z.string().max(150).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(itemSchema).min(1),
});

router.get(
  '/',
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

router.get('/:id', asyncH(async (req, res) => {
  const delivery = await getDelivery(pathId(req.params.id));
  if (!delivery) return res.status(404).json({ error: 'Entrega no encontrada' });
  res.json({ delivery });
}));

// Disponibilidad multi-sucursal de un borrador: faltantes + alternativas.
// Es lo que el frontend consulta antes de confirmar para mostrar el modal
// de derivación a otra sucursal.
router.get('/:id/check-availability', asyncH(async (req, res) => {
  const result = await checkDeliveryAvailability(pathId(req.params.id));
  res.json(result);
}));

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
    const input = draftSchema.parse(req.body);
    const result = await updateDelivery(req.user!, req.ip, pathId(req.params.id), input);
    res.json(result);
  })
);

router.post(
  '/:id/confirm',
  requirePerm('deliveries.confirm'),
  asyncH(async (req, res) => {
    const result = await confirmDelivery(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

router.post(
  '/:id/confirm-with-alternatives',
  requirePerm('deliveries.confirm'),
  asyncH(async (req, res) => {
    const choiceSchema = z.array(z.object({
      productId: z.number().int().positive(),
      chosenLocationId: z.number().int().positive(),
      quantity: z.number().positive(),
    }));
    // El frontend envía { choices: [...] }; se acepta también el array plano
    // para no romper llamadas existentes.
    const parsed = z.union([choiceSchema, z.object({ choices: choiceSchema })]).parse(req.body);
    const choices = Array.isArray(parsed) ? parsed : parsed.choices;
    const result = await confirmDeliveryWithAlternatives(req.user!, req.ip, pathId(req.params.id), choices);
    res.json(result);
  })
);

router.post(
  '/:id/approve',
  requirePerm('deliveries.approve'),
  asyncH(async (req, res) => {
    const result = await approveDelivery(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

router.get(
  '/:id/pending-delivery',
  asyncH(async (req, res) => {
    const list = await getPendingDeliveryForDelivery(pathId(req.params.id));
    // Array: una entrada por sucursal de retiro (puede haber varias órdenes)
    res.json({ pendingDeliveries: list });
  })
);

// Re-derivar faltantes de una entrega ya confirmada (PARCIAL/CONFIRMADO).
// Útil tras cancelar una orden de retiro o cuando llegó stock nuevo.
router.post(
  '/:id/rederive',
  requirePerm('deliveries.confirm'),
  asyncH(async (req, res) => {
    const result = await rederiveShortfalls(req.user!, req.ip, pathId(req.params.id));
    res.json(result);
  })
);

router.post(
  '/:id/void',
  requirePerm('deliveries.void'),
  asyncH(async (req, res) => {
    const { reason, voidApprovedBy } = z.object({ 
      reason: z.string().min(5).max(255),
      voidApprovedBy: z.number().int().positive().optional()
    }).parse(req.body);
    await voidDelivery(req.user!, req.ip, pathId(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
  })
);

export default router;