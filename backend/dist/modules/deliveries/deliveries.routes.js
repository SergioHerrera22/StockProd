"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const idempotency_1 = require("../../middleware/idempotency");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const deliveries_service_1 = require("./deliveries.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('deliveries.read'));
const itemSchema = zod_1.z.object({
    productId: zod_1.z.number().int().positive(),
    quantity: zod_1.z.number().positive(),
    requestedQuantity: zod_1.z.number().nonnegative().nullable().optional(),
});
const draftSchema = zod_1.z.object({
    locationId: zod_1.z.number().int().positive(),
    invoiceNumber: zod_1.z.string().trim().min(1, 'El número de factura es obligatorio').max(150),
    notes: zod_1.z.string().max(2000).nullable().optional(),
    items: zod_1.z.array(itemSchema).min(1),
    deliveryType: zod_1.z.enum(['LOCAL', 'DOMICILIO']).optional(),
    customerName: zod_1.z.string().max(150).nullable().optional(),
    customerPhone: zod_1.z.string().max(40).nullable().optional(),
    deliveryAddress: zod_1.z.string().max(250).nullable().optional(),
    deliveryLat: zod_1.z.number().nullable().optional(),
    deliveryLng: zod_1.z.number().nullable().optional(),
    driverUserId: zod_1.z.number().int().positive().nullable().optional(),
    driverId: zod_1.z.number().int().positive().nullable().optional(),
    dueAt: zod_1.z.string().nullable().optional(),
    deliveryObservations: zod_1.z.string().nullable().optional(),
    pendingDelivery: zod_1.z.boolean().optional().default(false),
});
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, deliveries_service_1.listDeliveries)({
        status: (0, pagination_1.strParam)(req.query.status),
        locationId: (0, pagination_1.intParam)(req.query.locationId),
        q: (0, pagination_1.strParam)(req.query.q),
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
// Escaneo del código de barras (EAN-13) de la orden de entrega.
// IMPORTANTE: debe ir ANTES de '/:id' para que 'scan' no se interprete como id.
router.get('/scan/:barcode', (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, deliveries_service_1.scanDeliveryBarcode)((0, pagination_1.strParam)(req.params.barcode) ?? '');
    res.json({ delivery: result });
}));
router.get('/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const delivery = await (0, deliveries_service_1.getDelivery)((0, pagination_1.pathId)(req.params.id));
    if (!delivery)
        return res.status(404).json({ error: 'Entrega no encontrada' });
    res.json({ delivery });
}));
// Disponibilidad multi-sucursal de un borrador: faltantes + alternativas.
// Es lo que el frontend consulta antes de confirmar para mostrar el modal
// de derivación a otra sucursal.
router.get('/:id/check-availability', (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, deliveries_service_1.checkDeliveryAvailability)((0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.post('/', (0, auth_1.requirePerm)('deliveries.write'), 
// Protege el alta (y el ?confirm=true) contra doble envío / red caída.
(0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const confirm = req.query.confirm === 'true';
    const result = await (0, deliveries_service_1.createDelivery)(req.user, req.ip, input, confirm);
    res.status(201).json(result);
})));
// Crear entrega desde OCR (productos detectados automáticamente desde captura de pantalla).
// Acepta ambos nombres de payload usados por versiones del frontend: products y detectedProducts.
router.post('/ocr', (0, auth_1.requirePerm)('deliveries.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const ocrItemSchema = zod_1.z.object({
        productId: zod_1.z.coerce.number().int().positive(),
        quantity: zod_1.z.coerce.number().positive().default(1),
    });
    const ocrSchema = zod_1.z.object({
        detectedProducts: zod_1.z.array(ocrItemSchema).optional(),
        products: zod_1.z.array(ocrItemSchema).optional(),
        saleLocationId: zod_1.z.coerce.number().int().positive(),
        customerName: zod_1.z.string().max(150).nullable().optional(),
        customerPhone: zod_1.z.string().max(40).nullable().optional(),
        notes: zod_1.z.string().max(2000).nullable().optional(),
    });
    const parsed = ocrSchema.parse(req.body);
    const detectedProducts = parsed.detectedProducts ?? parsed.products ?? [];
    if (detectedProducts.length === 0) {
        return res.status(400).json({ error: 'No se detectaron productos en la captura' });
    }
    // createDelivery centraliza validación, reservas, auditoría y transacción.
    // No abrir una segunda conexión/transacción: evita duplicar lógica y conexiones.
    const result = await (0, deliveries_service_1.createDelivery)(req.user, req.ip, {
        locationId: parsed.saleLocationId,
        invoiceNumber: `OCR-${Date.now()}`,
        notes: parsed.notes || 'Entrega creada desde captura de pantalla OCR',
        items: detectedProducts.map((product) => ({
            productId: product.productId,
            quantity: Math.max(1, product.quantity || 1),
            requestedQuantity: null,
        })),
        pendingDelivery: true,
        customerName: parsed.customerName ?? null,
        customerPhone: parsed.customerPhone ?? null,
    }, false);
    return res.status(201).json({
        ...result,
        ocrSource: true,
        message: 'Entrega creada desde captura OCR - revisá y ajustá cantidades si es necesario',
        detectedProductCount: detectedProducts.length,
    });
}));
router.put('/:id', (0, auth_1.requirePerm)('deliveries.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const result = await (0, deliveries_service_1.updateDelivery)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), input);
    res.json(result);
}));
router.post('/:id/confirm', (0, auth_1.requirePerm)('deliveries.confirm'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    // Checklist de picking (mejora 10): body opcional { pick: [{productId, quantity}] }
    // con lo que el operador realmente recibió item por item. Sin body, todo
    // el stock disponible como siempre.
    const pick = req.body && Array.isArray(req.body.pick)
        ? zod_1.z.array(zod_1.z.object({
            productId: zod_1.z.number().int().positive(),
            quantity: zod_1.z.number().min(0),
        })).parse(req.body.pick)
        : undefined;
    const result = await (0, deliveries_service_1.confirmDelivery)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), pick);
    res.json(result);
})));
router.post('/:id/confirm-with-alternatives', (0, auth_1.requirePerm)('deliveries.confirm'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const choiceSchema = zod_1.z.array(zod_1.z.object({
        productId: zod_1.z.number().int().positive(),
        chosenLocationId: zod_1.z.number().int().positive(),
        quantity: zod_1.z.number().positive(),
    }));
    // El frontend envía { choices: [...] }; se acepta también el array plano
    // para no romper llamadas existentes.
    const parsed = zod_1.z.union([choiceSchema, zod_1.z.object({ choices: choiceSchema })]).parse(req.body);
    const choices = Array.isArray(parsed) ? parsed : parsed.choices;
    const result = await (0, deliveries_service_1.confirmDeliveryWithAlternatives)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), choices);
    res.json(result);
})));
router.post('/:id/approve', (0, auth_1.requirePerm)('deliveries.approve'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, deliveries_service_1.approveDelivery)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.get('/:id/pending-delivery', (0, errorHandler_1.asyncH)(async (req, res) => {
    const list = await (0, deliveries_service_1.getPendingDeliveryForDelivery)((0, pagination_1.pathId)(req.params.id));
    // Array: una entrada por sucursal de retiro (puede haber varias órdenes)
    res.json({ pendingDeliveries: list });
}));
// Re-derivar faltantes de una entrega ya confirmada (PARCIAL/CONFIRMADO).
// Útil tras cancelar una orden de retiro o cuando llegó stock nuevo.
router.post('/:id/rederive', (0, auth_1.requirePerm)('deliveries.confirm'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, deliveries_service_1.rederiveShortfalls)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.post('/:id/void', (0, auth_1.requirePerm)('deliveries.void'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason, voidApprovedBy } = zod_1.z.object({
        reason: zod_1.z.string().min(5).max(255),
        voidApprovedBy: zod_1.z.number().int().positive().optional()
    }).parse(req.body);
    await (0, deliveries_service_1.voidDelivery)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
})));
exports.default = router;
