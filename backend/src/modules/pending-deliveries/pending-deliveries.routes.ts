import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { idempotent } from '../../middleware/idempotency';
import { authRequired, requirePerm } from '../../middleware/auth';
import { pageParams, intParam, strParam } from '../../lib/pagination';
import * as svc from './pending-deliveries.service';

const router = Router();
router.use(authRequired, requirePerm('deliveries.read'));

// ===== Esquemas de validación =====
const PendingDeliveryItemSchema = z.object({
  productId: z.number().int().positive(),
  quantityRequested: z.number().positive(),
  sourceLocationId: z.number().int().positive(),
  // 0 permitido = deuda sin reserva todavía (el service lo soporta y lo
  // valida; antes el schema rechazaba 0 y contradecía al service).
  quantityReserved: z.number().min(0),
});

const CreatePendingDeliverySchema = z.object({
  saleLocationId: z.number().int().positive(),
  pickupLocationId: z.number().int().positive(),
  customerName: z.string().max(150).optional().nullable(),
  customerPhone: z.string().max(40).optional().nullable(),
  customerDocument: z.string().max(40).optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z.array(PendingDeliveryItemSchema).min(1),
});

const ConfirmPickupSchema = z.object({
  barcode: z.string().min(1),
  items: z.array(z.object({
    productId: z.number().int().positive(),
    quantityDelivered: z.number().positive(),
  })).min(1),
});

const CancelSchema = z.object({
  reason: z.string().min(3).max(255),
});

// ===== RUTAS =====

/**
 * GET /api/pending-deliveries/availability
 * Verifica disponibilidad multi-sucursal para productos
 * Query: productIds=1,2,3&saleLocationId=1&qty=10,5,3
 */
router.get('/availability', asyncH(async (req: Request, res: Response) => {
  const { productIds, saleLocationId, qty } = req.query;
  
  if (!productIds || !saleLocationId || !qty) {
    throw new Error('Parámetros requeridos: productIds (csv), saleLocationId, qty (csv)');
  }

  const ids = (productIds as string).split(',').map(Number);
  const quantities = (qty as string).split(',').map(Number);
  const locId = Number(saleLocationId);

  if (ids.length !== quantities.length) {
    throw new Error('productIds y qty deben tener la misma cantidad de elementos');
  }

  const result = await svc.checkAvailability(ids, locId, quantities);
  res.json({ availability: result });
}));

/**
 * GET /api/pending-deliveries/stock-available
 * Obtiene stock disponible (total - reservado) para producto/ubicación
 * Query: productId=1&locationId=2
 */
router.get('/stock-available', asyncH(async (req: Request, res: Response) => {
  const { productId, locationId } = req.query;
  const result = await svc.getStockAvailability(
    productId ? Number(productId) : undefined,
    locationId ? Number(locationId) : undefined
  );
  res.json({ stock: result });
}));

/**
 * POST /api/pending-deliveries
 * Crea una nueva orden de entrega pendiente con reservas
 * Body: CreatePendingDeliverySchema
 */
router.post('/', 
  requirePerm('deliveries.write'),
  idempotent(asyncH(async (req: Request, res: Response) => {
    const input = CreatePendingDeliverySchema.parse(req.body);
    const result = await svc.createPendingDelivery(req.user!, req.ip, input);
    res.status(201).json({ success: true, ...result });
  }))
);

/**
 * GET /api/pending-deliveries/scan/:barcode
 * Escanea código de barras y devuelve la orden completa
 * Usado por el empleado en sucursal de retiro
 */
router.get('/scan/:barcode', asyncH(async (req: Request, res: Response) => {
  const { barcode } = req.params;
  const result = await svc.scanPendingDeliveryBarcode(barcode);
  res.json(result);
}));

/**
 * POST /api/pending-deliveries/confirm-pickup
 * Confirma retiro/entrega: descuenta stock real
 * Body: ConfirmPickupSchema
 */
router.post('/confirm-pickup',
  requirePerm('deliveries.write'),
  idempotent(asyncH(async (req: Request, res: Response) => {
    const input = ConfirmPickupSchema.parse(req.body);
    const result = await svc.confirmPickup(req.user!, req.ip, input);
    res.json(result);
  }))
);

/**
 * POST /api/pending-deliveries/:id/cancel
 * Cancela orden pendiente y libera reservas
 */
router.post('/:id/cancel',
  requirePerm('deliveries.void'),
  idempotent(asyncH(async (req: Request, res: Response) => {
    const { reason } = CancelSchema.parse(req.body);
    const result = await svc.cancelPendingDelivery(req.user!, req.ip, Number(req.params.id), reason);
    res.json(result);
  }))
);

/**
 * POST /api/pending-deliveries/:id/extend
 * Extiende el plazo de retiro (dias desde ahora). Solo orden activa.
 */
router.post('/:id/extend',
  requirePerm('deliveries.write'),
  idempotent(asyncH(async (req: Request, res: Response) => {
    const { days, note } = z.object({
      days: z.number().int().min(1).max(60).default(7),
      note: z.string().max(300).nullable().optional(),
    }).parse(req.body ?? {});
    const result = await svc.extendPendingDelivery(req.user!, req.ip, Number(req.params.id), days, note ?? null);
    res.json(result);
  }))
);

/**
 * GET /api/pending-deliveries
 * Lista órdenes pendientes con paginación y filtros
 */
router.get('/', 
  requirePerm('deliveries.read'),
  asyncH(async (req: Request, res: Response) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const result = await svc.listPendingDeliveries({
      status: req.query.status as string,
      saleLocationId: req.query.saleLocationId ? Number(req.query.saleLocationId) : undefined,
      pickupLocationId: req.query.pickupLocationId ? Number(req.query.pickupLocationId) : undefined,
      q: req.query.q as string,
      page, pageSize, offset,
    });

    res.json({
      data: result.pendingDeliveries,
      pagination: { page, pageSize, total: result.total, totalPages: Math.ceil(result.total / pageSize) }
    });
  })
);

/**
 * GET /api/pending-deliveries/:id
 * Detalle completo de una orden pendiente
 */
router.get('/:id', 
  requirePerm('deliveries.read'),
  asyncH(async (req: Request, res: Response) => {
    const result = await svc.getPendingDelivery(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json(result);
  })
);

export default router;