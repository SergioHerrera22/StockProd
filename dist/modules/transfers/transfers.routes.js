"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const idempotency_1 = require("../../middleware/idempotency");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const transfers_service_1 = require("./transfers.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('transfers.read'));
const draftSchema = zod_1.z.object({
    originLocationId: zod_1.z.number().int().positive(),
    destinationLocationId: zod_1.z.number().int().positive(),
    notes: zod_1.z.string().max(2000).nullable().optional(),
    items: zod_1.z.array(zod_1.z.object({ productId: zod_1.z.number().int().positive(), quantity: zod_1.z.number().positive() })).min(1),
    driverUserId: zod_1.z.number().int().positive().nullable().optional(),
    driverId: zod_1.z.number().int().positive().nullable().optional(),
    deliveryAddress: zod_1.z.string().max(250).nullable().optional(),
    deliveryLat: zod_1.z.number().nullable().optional(),
    deliveryLng: zod_1.z.number().nullable().optional(),
    dueAt: zod_1.z.string().nullable().optional(),
    deliveryObservations: zod_1.z.string().nullable().optional(),
});
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, transfers_service_1.listTransfers)({
        status: (0, pagination_1.strParam)(req.query.status),
        locationId: (0, pagination_1.intParam)(req.query.locationId),
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.get('/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const transfer = await (0, transfers_service_1.getTransfer)((0, pagination_1.pathId)(req.params.id));
    if (!transfer)
        return res.status(404).json({ error: 'Transferencia no encontrada' });
    res.json({ transfer });
}));
router.post('/', (0, auth_1.requirePerm)('transfers.write'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const result = await (0, transfers_service_1.createTransfer)(req.user, req.ip, input);
    res.status(201).json(result);
})));
router.post('/:id/approve', (0, auth_1.requirePerm)('transfers.approve'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, transfers_service_1.approveTransfer)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.post('/:id/reject', (0, auth_1.requirePerm)('transfers.approve'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason } = zod_1.z.object({ reason: zod_1.z.string().min(5).max(255) }).parse(req.body);
    const result = await (0, transfers_service_1.rejectTransfer)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason);
    res.json(result);
}));
router.post('/:id/receive', (0, auth_1.requirePerm)('transfers.receive'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const id = (0, pagination_1.pathId)(req.params.id);
    const { items } = zod_1.z
        .object({
        items: zod_1.z.array(zod_1.z.object({ itemId: zod_1.z.number().int().positive(), quantityReceived: zod_1.z.number().min(0) })).min(1),
    })
        .parse(req.body);
    const result = await (0, transfers_service_1.receiveTransfer)(req.user, req.ip, id, items);
    res.json(result);
})));
router.post('/:id/verify', (0, auth_1.requirePerm)('transfers.verify'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, transfers_service_1.verifyTransferReceipt)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.post('/:id/void', (0, auth_1.requirePerm)('transfers.void'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason, voidApprovedBy } = zod_1.z.object({
        reason: zod_1.z.string().min(5).max(255),
        voidApprovedBy: zod_1.z.number().int().positive().optional()
    }).parse(req.body);
    await (0, transfers_service_1.voidTransfer)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
})));
exports.default = router;
