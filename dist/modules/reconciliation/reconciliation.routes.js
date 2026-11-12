"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const reconciliation_service_1 = require("../../services/reconciliation.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('audit.read')); // Solo ADMIN/ENCARGADO con audit.read
// Ejecutar conciliación completa
router.post('/run', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { locationId } = zod_1.z.object({
        locationId: zod_1.z.number().int().positive().optional(),
    }).parse(req.body);
    const result = await (0, reconciliation_service_1.runFullReconciliation)(req.user, req.ip, locationId);
    res.json(result);
}));
// Historial de conciliaciones
router.get('/history', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, reconciliation_service_1.getReconciliationHistory)({
        locationId: req.query.locationId ? parseInt(req.query.locationId, 10) : undefined,
        status: req.query.status,
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
exports.default = router;
