"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const idempotency_1 = require("../../middleware/idempotency");
const auth_1 = require("../../middleware/auth");
const svc = __importStar(require("./pending-deliveries.service"));
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('deliveries.read'));
// ===== Esquemas de validación =====
const PendingDeliveryItemSchema = zod_1.z.object({
    productId: zod_1.z.number().int().positive(),
    quantityRequested: zod_1.z.number().positive(),
    sourceLocationId: zod_1.z.number().int().positive(),
    // 0 permitido = deuda sin reserva todavía (el service lo soporta y lo
    // valida; antes el schema rechazaba 0 y contradecía al service).
    quantityReserved: zod_1.z.number().min(0),
});
const CreatePendingDeliverySchema = zod_1.z.object({
    saleLocationId: zod_1.z.number().int().positive(),
    pickupLocationId: zod_1.z.number().int().positive(),
    customerName: zod_1.z.string().max(150).optional().nullable(),
    customerPhone: zod_1.z.string().max(40).optional().nullable(),
    customerDocument: zod_1.z.string().max(40).optional().nullable(),
    notes: zod_1.z.string().optional().nullable(),
    items: zod_1.z.array(PendingDeliveryItemSchema).min(1),
});
const ConfirmPickupSchema = zod_1.z.object({
    barcode: zod_1.z.string().min(1),
    items: zod_1.z.array(zod_1.z.object({
        productId: zod_1.z.number().int().positive(),
        quantityDelivered: zod_1.z.number().positive(),
    })).min(1),
});
const CancelSchema = zod_1.z.object({
    reason: zod_1.z.string().min(3).max(255),
});
// ===== RUTAS =====
/**
 * GET /api/pending-deliveries/availability
 * Verifica disponibilidad multi-sucursal para productos
 * Query: productIds=1,2,3&saleLocationId=1&qty=10,5,3
 */
router.get('/availability', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { productIds, saleLocationId, qty } = req.query;
    if (!productIds || !saleLocationId || !qty) {
        throw new Error('Parámetros requeridos: productIds (csv), saleLocationId, qty (csv)');
    }
    const ids = productIds.split(',').map(Number);
    const quantities = qty.split(',').map(Number);
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
router.get('/stock-available', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { productId, locationId } = req.query;
    const result = await svc.getStockAvailability(productId ? Number(productId) : undefined, locationId ? Number(locationId) : undefined);
    res.json({ stock: result });
}));
/**
 * POST /api/pending-deliveries
 * Crea una nueva orden de entrega pendiente con reservas
 * Body: CreatePendingDeliverySchema
 */
router.post('/', (0, auth_1.requirePerm)('deliveries.write'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const input = CreatePendingDeliverySchema.parse(req.body);
    const result = await svc.createPendingDelivery(req.user, req.ip, input);
    res.status(201).json({ success: true, ...result });
})));
/**
 * GET /api/pending-deliveries/scan/:barcode
 * Escanea código de barras y devuelve la orden completa
 * Usado por el empleado en sucursal de retiro
 */
router.get('/scan/:barcode', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { barcode } = req.params;
    const result = await svc.scanPendingDeliveryBarcode(barcode);
    res.json(result);
}));
/**
 * POST /api/pending-deliveries/confirm-pickup
 * Confirma retiro/entrega: descuenta stock real
 * Body: ConfirmPickupSchema
 */
router.post('/confirm-pickup', (0, auth_1.requirePerm)('deliveries.write'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const input = ConfirmPickupSchema.parse(req.body);
    const result = await svc.confirmPickup(req.user, req.ip, input);
    res.json(result);
})));
/**
 * POST /api/pending-deliveries/:id/cancel
 * Cancela orden pendiente y libera reservas
 */
router.post('/:id/cancel', (0, auth_1.requirePerm)('deliveries.void'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason } = CancelSchema.parse(req.body);
    const result = await svc.cancelPendingDelivery(req.user, req.ip, Number(req.params.id), reason);
    res.json(result);
})));
/**
 * POST /api/pending-deliveries/:id/extend
 * Extiende el plazo de retiro (dias desde ahora). Solo orden activa.
 */
router.post('/:id/extend', (0, auth_1.requirePerm)('deliveries.write'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const { days, note } = zod_1.z.object({
        days: zod_1.z.number().int().min(1).max(60).default(7),
        note: zod_1.z.string().max(300).nullable().optional(),
    }).parse(req.body ?? {});
    const result = await svc.extendPendingDelivery(req.user, req.ip, Number(req.params.id), days, note ?? null);
    res.json(result);
})));
/**
 * GET /api/pending-deliveries
 * Lista órdenes pendientes con paginación y filtros
 */
router.get('/', (0, auth_1.requirePerm)('deliveries.read'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const result = await svc.listPendingDeliveries({
        status: req.query.status,
        saleLocationId: req.query.saleLocationId ? Number(req.query.saleLocationId) : undefined,
        pickupLocationId: req.query.pickupLocationId ? Number(req.query.pickupLocationId) : undefined,
        q: req.query.q,
        page, pageSize, offset,
    });
    res.json({
        data: result.pendingDeliveries,
        pagination: { page, pageSize, total: result.total, totalPages: Math.ceil(result.total / pageSize) }
    });
}));
/**
 * GET /api/pending-deliveries/:id
 * Detalle completo de una orden pendiente
 */
router.get('/:id', (0, auth_1.requirePerm)('deliveries.read'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await svc.getPendingDelivery(Number(req.params.id));
    if (!result)
        return res.status(404).json({ error: 'Orden no encontrada' });
    res.json(result);
}));
exports.default = router;
