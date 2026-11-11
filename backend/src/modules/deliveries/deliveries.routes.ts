import { Router } from 'express';
import { z } from 'zod';
import { asyncH } from '../../middleware/errorHandler';
import { idempotent } from '../../middleware/idempotency';
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
  rederiveShortfalls,
  scanDeliveryBarcode,
  createDeliveryFromOcr
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
  invoiceNumber: z.string().trim().min(1, 'El número de factura es obligatorio').max(150),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(itemSchema).min(1),
  deliveryType: z.enum(['LOCAL', 'DOMICILIO']).optional(),
  customerName: z.string().max(150).nullable().optional(),
  customerPhone: z.string().max(40).nullable().optional(),
  deliveryAddress: z.string().max(250).nullable().optional(),
  deliveryLat: z.number().nullable().optional(),
  deliveryLng: z.number().nullable().optional(),
  driverUserId: z.number().int().positive().nullable().optional(),
  driverId: z.number().int().positive().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  deliveryObservations: z.string().nullable().optional(),
  pendingDelivery: z.boolean().optional().default(false),
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

// Escaneo del código de barras (EAN-13) de la orden de entrega.
// IMPORTANTE: debe ir ANTES de '/:id' para que 'scan' no se interprete como id.
router.get('/scan/:barcode', asyncH(async (req, res) => {
  const result = await scanDeliveryBarcode(strParam(req.params.barcode) ?? '');
  res.json({ delivery: result });
}));

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
  // Protege el alta (y el ?confirm=true) contra doble envío / red caída.
  idempotent(asyncH(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const confirm = req.query.confirm === 'true';
    const result = await createDelivery(req.user!, req.ip, input, confirm);
    res.status(201).json(result);
  }))
);

// Crear entrega desde OCR (productos detectados automáticamente desde captura de pantalla)
router.post(
  '/ocr',
  requirePerm('deliveries.write'),
  asyncH(async (req, res) => {
    const { detectedProducts, saleLocationId, pickupLocationId, customerName, customerPhone, notes } = req.body;
    
    if (!detectedProducts || !Array.isArray(detectedProducts) || detectedProducts.length === 0) {
      return res.status(400).json({ error: 'No se detectaron productos en la captura' });
    }
    
    if (!saleLocationId) {
      return res.status(400).json({ error: 'Ubicación de venta requerida' });
    }
    
    // Validate products exist and are active
    const pool = new (require('../../db/pool')).Pool();
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Validate all products exist and are active
      const productIds = detectedProducts.map((p: any) => p.productId).filter((id: number) => id > 0);
      
      let validProducts: Array<{ id: number; code: string; name: string }> = [];
      
      if (productIds.length > 0) {
        const { rows } = await client.query(
          `SELECT id, code, name FROM products WHERE id = ANY($1) AND is_active = true`,
          [productIds]
        );
        validProducts = rows;
      }
      
      if (validProducts.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Ningún producto detectado es válido o está inactivo' });
      }
      
      // Match detected products with database products by ID (exact match)
      // In a full implementation, would also match by name/description similarity
      const productMap = new Map<number, { id: number; code: string; name: string }>();
      validProducts.forEach((p: any) => {
        productMap.set(p.id, { id: p.id, code: p.code, name: p.name });
      });
      
      // Build items array from detected products, matching by product ID
      const items = detectedProducts
        .filter((p: any) => p.productId && productMap.has(p.productId))
        .map((p: any) => {
          const matched = productMap.get(p.productId)!;
          // Use the quantity from OCR detection, minimum 1
          const quantity = Math.max(1, p.quantity || 1);
          return {
            productId: p.productId,
            quantity: quantity,
            requestedQuantity: null
          };
        });
      
      if (items.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No se pudieron emparejar los productos detectados con la base de datos' });
      }
      
      // Create the delivery draft with the detected products
      const invoiceNumber = 'OCR-' + Date.now().toString().substring(8);
      
      const input = {
        locationId: saleLocationId,
        invoiceNumber: invoiceNumber,
        notes: notes || 'Entrega creada desde captura de pantalla OCR',
        items: items,
        pendingDelivery: true,
        customerName: customerName || null,
        customerPhone: customerPhone || null
      };
      
      const { createDelivery } = require('./deliveries.service');
      const result = await createDelivery(req.user as any, undefined, input, false);
      
      await client.query('COMMIT');
      
      return res.status(201).json({
        ...result,
        ocrSource: true,
        message: 'Entrega creada desde captura OCR - revisá y ajustá cantidades si es necesario',
        detectedProductCount: detectedProducts.length
      });
      
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('OCR delivery error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Error desconocido' });
    } finally {
      client.release();
      await pool.end();
    }
  })
);

router.post(
  '/ocr',
  requirePerm('deliveries.write'),
  asyncH(async (req, res) => {
    const { products, saleLocationId, pickupLocationId, customerName, customerPhone, notes } = req.body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'No se detectaron productos en la captura' });
    }
    
    if (!saleLocationId) {
      return res.status(400).json({ error: 'Ubicación de venta requerida' });
    }
    
    // Validate that products exist and are active
    const productIds = products.map((p: any) => p.productId).filter((id: number) => id > 0);
    
    if (productIds.length === 0) {
      return res.status(400).json({ error: 'No hay IDs de producto válidos' });
    }
    
    // Check products are active
    const { PoolClient } = require('pg');
    // We'll use the existing pool client pattern
    
    // Create the pending delivery with the detected products
    // We need to adapt the createDelivery to work with OCR-detected products
    // For now, we'll create a minimal delivery with the products
    
    // Get a client for transaction
    const { Pool } = require('../../db/pool');
    const pool = new Pool();
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Generate delivery number and barcode
      const { nextDocNumber } = require('../../services/numbering');
      const deliveryNumber = 'PD-' + (await nextDocNumber(client, 'delivery')).toString().padStart(6, '0');
      const { Barcode } = require('./deliveries.service'); // This won't work, let's use raw SQL
      
      // Actually, let's use a simpler approach - create the delivery with the products
      // We'll need to adapt the createPendingDeliveryFromOcr function
      
      // For now, let's just return an error and note that this needs implementation
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Funcionalidad en desarrollo - use el frontend' });
      
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Error desconocido' });
    } finally {
      client.release();
      await pool.end();
    }
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
  idempotent(asyncH(async (req, res) => {
    // Checklist de picking (mejora 10): body opcional { pick: [{productId, quantity}] }
    // con lo que el operador realmente recibió item por item. Sin body, todo
    // el stock disponible como siempre.
    const pick = req.body && Array.isArray((req.body as Record<string, unknown>).pick)
      ? z.array(z.object({
          productId: z.number().int().positive(),
          quantity: z.number().min(0),
        })).parse((req.body as Record<string, unknown>).pick)
      : undefined;
    const result = await confirmDelivery(req.user!, req.ip, pathId(req.params.id), pick);
    res.json(result);
  }))
);

router.post(
  '/:id/confirm-with-alternatives',
  requirePerm('deliveries.confirm'),
  idempotent(asyncH(async (req, res) => {
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
  }))
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
  idempotent(asyncH(async (req, res) => {
    const { reason, voidApprovedBy } = z.object({
      reason: z.string().min(5).max(255),
      voidApprovedBy: z.number().int().positive().optional()
    }).parse(req.body);
    await voidDelivery(req.user!, req.ip, pathId(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
  }))
);

export default router;