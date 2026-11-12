"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const alerts_service_1 = require("../../services/alerts.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('alerts.read'));
// Contador para badge en UI
router.get('/pending-count', (0, errorHandler_1.asyncH)(async (req, res) => {
    const user = req.user;
    const locationId = req.query.locationId ? parseInt(req.query.locationId, 10) : undefined;
    // El usuario ve alertas dirigidas a su rol o globales
    const count = await (0, alerts_service_1.countPendingAlerts)(user.role, locationId);
    res.json({ count });
}));
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, alerts_service_1.listAlerts)({
        status: req.query.status,
        severity: req.query.severity,
        code: req.query.code,
        targetRole: req.user.role,
        targetLocationId: req.query.locationId ? parseInt(req.query.locationId, 10) : undefined,
        entityType: req.query.entityType,
        entityId: req.query.entityId ? parseInt(req.query.entityId, 10) : undefined,
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.get('/:id', (0, errorHandler_1.asyncH)(async (req, res) => {
    const alert = await (0, alerts_service_1.getAlert)((0, pagination_1.pathId)(req.params.id));
    if (!alert)
        return res.status(404).json({ error: 'Alerta no encontrada' });
    res.json({ alert });
}));
router.post('/:id/acknowledge', (0, auth_1.requirePerm)('alerts.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, alerts_service_1.acknowledgeAlert)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
router.post('/:id/resolve', (0, auth_1.requirePerm)('alerts.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { notes } = zod_1.z.object({ notes: zod_1.z.string().max(500).optional() }).parse(req.body);
    const result = await (0, alerts_service_1.resolveAlert)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), notes);
    res.json(result);
}));
router.post('/:id/dismiss', (0, auth_1.requirePerm)('alerts.manage'), // Solo ADMIN/ENCARGADO
(0, errorHandler_1.asyncH)(async (req, res) => {
    const { notes } = zod_1.z.object({ notes: zod_1.z.string().max(500).optional() }).parse(req.body);
    const result = await (0, alerts_service_1.dismissAlert)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), notes);
    res.json(result);
}));
// Endpoint para ejecutar checks programados (llamar desde cron/job scheduler)
router.post('/run-scheduled-checks', (0, auth_1.requirePerm)('alerts.manage'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const results = await (0, alerts_service_1.runAllScheduledChecks)();
    res.json({ results });
}));
exports.default = router;
