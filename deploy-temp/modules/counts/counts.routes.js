"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const counts_service_1 = require("./counts.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('counts.read'));
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, counts_service_1.listCounts)({
        locationId: (0, pagination_1.intParam)(req.query.locationId),
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.get('/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const count = await (0, counts_service_1.getCount)((0, pagination_1.pathId)(req.params.id));
    if (!count)
        return res.status(404).json({ error: 'Inventario no encontrado' });
    res.json({ count });
}));
router.post('/', (0, auth_1.requirePerm)('counts.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { locationId, notes, productIds } = zod_1.z.object({
        locationId: zod_1.z.number().int().positive(),
        notes: zod_1.z.string().max(2000).nullable().optional(),
        productIds: zod_1.z.array(zod_1.z.number().int().positive()).optional(),
    }).parse(req.body);
    const result = await (0, counts_service_1.createCount)(req.user, req.ip, locationId, notes ?? null, productIds);
    res.status(201).json(result);
}));
// El frontend y la prueba de humo envían PUT; se acepta POST por compatibilidad.
const saveItemsHandler = (0, errorHandler_1.asyncH)(async (req, res) => {
    const body = zod_1.z.object({
        items: zod_1.z.array(zod_1.z.object({
            itemId: zod_1.z.number().int().positive(),
            countedQuantity: zod_1.z.number().min(0),
        })).min(1),
    }).parse(req.body);
    const result = await (0, counts_service_1.saveCountItems)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), body.items);
    res.json(result);
});
router.post('/:id/items', (0, auth_1.requirePerm)('counts.write'), saveItemsHandler);
router.put('/:id/items', (0, auth_1.requirePerm)('counts.write'), saveItemsHandler);
router.post('/:id/apply', (0, auth_1.requirePerm)('counts.apply'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason } = zod_1.z.object({ reason: zod_1.z.string().min(5).max(255) }).parse(req.body);
    const result = await (0, counts_service_1.applyCount)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason);
    res.json(result);
}));
router.post('/:id/approve', (0, auth_1.requirePerm)('counts.approve'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason } = zod_1.z.object({ reason: zod_1.z.string().min(5).max(255) }).parse(req.body);
    const result = await (0, counts_service_1.approveCount)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason);
    res.json(result);
}));
router.post('/:id/void', (0, auth_1.requirePerm)('counts.void'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { reason, voidApprovedBy } = zod_1.z.object({
        reason: zod_1.z.string().min(5).max(255),
        voidApprovedBy: zod_1.z.number().int().positive().optional()
    }).parse(req.body);
    await (0, counts_service_1.voidCount)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), reason, voidApprovedBy);
    res.json({ ok: true });
}));
exports.default = router;
