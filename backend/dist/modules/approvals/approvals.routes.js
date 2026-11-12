"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const approval_service_1 = require("../../services/approval.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
// Reglas de aprobación (ADMIN/ENCARGADO con perm approvals.read)
router.get('/rules', (0, auth_1.requirePerm)('approvals.read'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, approval_service_1.listApprovalRules)({
        entityType: req.query.entityType,
        operation: req.query.operation,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.post('/rules', 
// Mutación de configuración: solo ADMIN (settings.write). Antes solo exigía
// approvals.read: un EMPLEADO podía crear reglas de aprobación vía API.
(0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({
        name: zod_1.z.string().min(3).max(100),
        entityType: zod_1.z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
        operation: zod_1.z.enum(['CREATE', 'CONFIRM', 'RECEIVE', 'VOID', 'APPLY', 'ADJUST']),
        condition: zod_1.z.record(zod_1.z.unknown()).default({}),
        action: zod_1.z.record(zod_1.z.unknown()).default({}),
        priority: zod_1.z.number().int().optional(),
    }).parse(req.body);
    const result = await (0, approval_service_1.createApprovalRule)(req.user, req.ip, input);
    res.status(201).json(result);
}));
router.patch('/rules/:id', 
// Mutación de configuración: solo ADMIN (settings.write)
(0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({
        name: zod_1.z.string().min(3).max(100).optional(),
        condition: zod_1.z.record(zod_1.z.unknown()).optional(),
        action: zod_1.z.record(zod_1.z.unknown()).optional(),
        priority: zod_1.z.number().int().optional(),
        isActive: zod_1.z.boolean().optional(),
    }).parse(req.body);
    const result = await (0, approval_service_1.updateApprovalRule)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), input);
    res.json(result);
}));
// Solicitudes de aprobación
router.get('/requests', (0, auth_1.requirePerm)('approvals.read'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, approval_service_1.listApprovalRequests)({
        status: req.query.status,
        entityType: req.query.entityType,
        requestedBy: req.query.requestedBy ? parseInt(req.query.requestedBy, 10) : undefined,
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.get('/requests/:id', (0, auth_1.requirePerm)('approvals.read'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const request = await (0, approval_service_1.getApprovalRequest)((0, pagination_1.pathId)(req.params.id));
    if (!request)
        return res.status(404).json({ error: 'Solicitud no encontrada' });
    res.json({ request });
}));
router.post('/requests/:id/resolve', (0, auth_1.requirePerm)('approvals.approve'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { action, notes } = zod_1.z.object({
        action: zod_1.z.enum(['APPROVE', 'REJECT']),
        notes: zod_1.z.string().max(500).optional(),
    }).parse(req.body);
    const result = await (0, approval_service_1.resolveApprovalRequest)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), action, notes);
    res.json(result);
}));
router.post('/requests/:id/cancel', (0, auth_1.requirePerm)('approvals.approve'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, approval_service_1.cancelApprovalRequest)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
// Evaluar reglas para un contexto (útil para UI)
router.post('/evaluate', (0, auth_1.requirePerm)('approvals.read'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { entityType, operation, context } = zod_1.z.object({
        entityType: zod_1.z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
        operation: zod_1.z.enum(['CREATE', 'CONFIRM', 'RECEIVE', 'VOID', 'APPLY', 'ADJUST']),
        context: zod_1.z.record(zod_1.z.unknown()),
    }).parse(req.body);
    const rules = await (0, approval_service_1.evaluateApprovalRules)(entityType, operation, context);
    res.json({ rules });
}));
// Verificar estado de aprobación de una entidad
router.get('/status/:entityType/:entityId', (0, auth_1.requirePerm)('approvals.read'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const { entityType, entityId } = req.params;
    const status = await (0, approval_service_1.checkApprovalStatus)(entityType, parseInt(entityId, 10));
    res.json(status);
}));
exports.default = router;
