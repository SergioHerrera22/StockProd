"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const idempotency_1 = require("../../middleware/idempotency");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const entries_service_1 = require("./entries.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('entries.read'));
const itemSchema = zod_1.z.object({
    productId: zod_1.z.number().int().positive(),
    quantity: zod_1.z.number().positive(),
    unitCost: zod_1.z.number().nonnegative().nullable().optional(),
});
const draftSchema = zod_1.z.object({
    locationId: zod_1.z.number().int().positive(),
    type: zod_1.z.enum(['COMPRA', 'DEVOLUCION', 'OTRO']),
    supplier: zod_1.z.string().max(150).nullable().optional(),
    supplierId: zod_1.z.number().int().positive().nullable().optional(),
    notes: zod_1.z.string().max(2000).nullable().optional(),
    items: zod_1.z.array(itemSchema).min(1),
});
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const searchTerm = (0, pagination_1.strParam)(req.query.q);
    const result = await (0, entries_service_1.listEntries)({
        status: (0, pagination_1.strParam)(req.query.status),
        locationId: (0, pagination_1.intParam)(req.query.locationId),
        page, pageSize, offset,
        ...(searchTerm && { searchTerm }),
    });
    res.json({ ...result, page, pageSize });
}));
router.get('/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const entry = await (0, entries_service_1.getEntry)((0, pagination_1.pathId)(req.params.id));
    if (!entry)
        return res.status(404).json({ error: 'Entrada no encontrada' });
    res.json({ entry });
}));
router.post('/', (0, auth_1.requirePerm)('entries.write'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const input = draftSchema.parse(req.body);
    const confirm = req.query.confirm === 'true';
    const result = await (0, entries_service_1.createEntry)(req.user, req.ip, input, confirm);
    res.status(201).json(result);
})));
router.post('/:id/confirm', (0, auth_1.requirePerm)('entries.confirm'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    await (0, entries_service_1.confirmEntry)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json({ ok: true });
})));
router.post('/:id/approve', (0, auth_1.requirePerm)('entries.approve'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, entries_service_1.approveEntry)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.post('/:id/void', (0, auth_1.requirePerm)('entries.void'), (0, idempotency_1.idempotent)((0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason, voidApprovedBy } = zod_1.z.object({
        reason: zod_1.z.string().min(5).max(255),
        voidApprovedBy: zod_1.z.number().int().positive().optional()
    }).parse(req.body);
    await (0, entries_service_1.voidEntry)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
})));
exports.default = router;
