"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const snapshot_service_1 = require("../../services/snapshot.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('stock.read'));
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, snapshot_service_1.listSnapshots)({
        locationId: req.query.locationId ? parseInt(req.query.locationId, 10) : undefined,
        snapshotType: req.query.snapshotType,
        referenceType: req.query.referenceType,
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.get('/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const snap = await (0, snapshot_service_1.getSnapshot)((0, pagination_1.pathId)(req.params.id));
    if (!snap)
        return res.status(404).json({ error: 'Snapshot no encontrado' });
    res.json({ snapshot: snap });
}));
router.get('/:id/verify', (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, snapshot_service_1.verifySnapshotIntegrity)((0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.post('/', (0, auth_1.requirePerm)('stock.adjust'), // Permiso elevado para crear snapshots manuales
(0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({
        locationId: zod_1.z.number().int().positive(),
        snapshotType: zod_1.z.enum(['DAILY', 'WEEKLY', 'MANUAL', 'PRE_COUNT', 'POST_COUNT', 'PRE_TRANSFER', 'POST_TRANSFER']),
        referenceId: zod_1.z.number().int().positive().optional(),
        referenceType: zod_1.z.string().optional(),
    }).parse(req.body);
    const snap = await (0, snapshot_service_1.createSnapshot)(req.user, req.ip, input.locationId, input.snapshotType, input.referenceId, input.referenceType);
    res.status(201).json({ snapshot: snap });
}));
router.post('/compare', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { snapshotId1, snapshotId2 } = zod_1.z.object({
        snapshotId1: zod_1.z.number().int().positive(),
        snapshotId2: zod_1.z.number().int().positive(),
    }).parse(req.body);
    const result = await (0, snapshot_service_1.compareSnapshots)(snapshotId1, snapshotId2);
    res.json(result);
}));
router.get('/product/:productId/history', (0, errorHandler_1.asyncH)(async (req, res) => {
    const locationId = parseInt(req.query.locationId, 10);
    const productId = (0, pagination_1.pathId)(req.params.productId);
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 30;
    if (!locationId)
        return res.status(400).json({ error: 'locationId es requerido' });
    const history = await (0, snapshot_service_1.getProductStockHistory)(locationId, productId, limit);
    res.json({ history });
}));
// Jobs programados (llamar desde cron externo)
router.post('/daily', (0, auth_1.requirePerm)('stock.adjust'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, snapshot_service_1.createDailySnapshots)(req.user);
    res.json({ results: result });
}));
router.post('/weekly', (0, auth_1.requirePerm)('stock.adjust'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, snapshot_service_1.createWeeklySnapshots)(req.user);
    res.json({ results: result });
}));
exports.default = router;
