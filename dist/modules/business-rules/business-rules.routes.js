"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const pagination_1 = require("../../lib/pagination");
const businessRules_service_1 = require("../../services/businessRules.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('audit.read')); // Reusar perm de auditoría o crear uno específico
// Reglas de negocio
router.get('/', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, businessRules_service_1.listBusinessRules)({
        entityType: req.query.entityType,
        triggerEvent: req.query.triggerEvent,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.post('/', 
// Mutación de configuración: solo ADMIN (settings.write). El router base
// exige audit.read, pero leer no es lo mismo que configurar reglas.
(0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({
        code: zod_1.z.string().min(3).max(50),
        name: zod_1.z.string().min(3).max(100),
        description: zod_1.z.string().optional(),
        entityType: zod_1.z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
        triggerEvent: zod_1.z.enum(['BEFORE_CREATE', 'BEFORE_CONFIRM', 'BEFORE_RECEIVE', 'BEFORE_VOID', 'BEFORE_APPLY', 'BEFORE_ADJUST']),
        condition: zod_1.z.record(zod_1.z.unknown()).default({}),
        action: zod_1.z.record(zod_1.z.unknown()).default({}),
        severity: zod_1.z.enum(['INFO', 'WARNING', 'BLOCKING']).optional(),
    }).parse(req.body);
    const result = await (0, businessRules_service_1.createBusinessRule)(req.user, req.ip, input);
    res.status(201).json(result);
}));
router.patch('/:id', 
// Mutación de configuración: solo ADMIN (settings.write)
(0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({
        name: zod_1.z.string().min(3).max(100).optional(),
        description: zod_1.z.string().optional(),
        condition: zod_1.z.record(zod_1.z.unknown()).optional(),
        action: zod_1.z.record(zod_1.z.unknown()).optional(),
        severity: zod_1.z.enum(['INFO', 'WARNING', 'BLOCKING']).optional(),
        isActive: zod_1.z.boolean().optional(),
    }).parse(req.body);
    const result = await (0, businessRules_service_1.updateBusinessRule)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id), input);
    res.json(result);
}));
// Evaluar reglas para un contexto
router.post('/evaluate', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { entityType, triggerEvent, context } = zod_1.z.object({
        entityType: zod_1.z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST']),
        triggerEvent: zod_1.z.enum(['BEFORE_CREATE', 'BEFORE_CONFIRM', 'BEFORE_RECEIVE', 'BEFORE_VOID', 'BEFORE_APPLY', 'BEFORE_ADJUST']),
        context: zod_1.z.record(zod_1.z.unknown()),
    }).parse(req.body);
    const rules = await (0, businessRules_service_1.evaluateBusinessRules)(entityType, triggerEvent, context);
    res.json({ rules });
}));
// Umbrales de control
router.get('/thresholds', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { page, pageSize, offset } = (0, pagination_1.pageParams)(req, 20);
    const result = await (0, businessRules_service_1.listControlThresholds)({
        locationId: req.query.locationId ? parseInt(req.query.locationId, 10) : null,
        entityType: req.query.entityType,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        page, pageSize, offset,
    });
    res.json({ ...result, page, pageSize });
}));
router.post('/thresholds', 
// Mutación de configuración: solo ADMIN (settings.write)
(0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({
        locationId: zod_1.z.number().int().positive().nullable().optional().transform(v => v ?? null),
        entityType: zod_1.z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST', 'PRODUCT']),
        metric: zod_1.z.string().min(1).max(50),
        thresholdValue: zod_1.z.number(),
        thresholdOperator: zod_1.z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ']),
        action: zod_1.z.record(zod_1.z.unknown()).default({}),
    }).parse(req.body);
    const result = await (0, businessRules_service_1.upsertControlThreshold)(req.user, req.ip, input);
    res.json(result);
}));
router.delete('/thresholds/:id', 
// Mutación de configuración: solo ADMIN (settings.write)
(0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, businessRules_service_1.deleteControlThreshold)(req.user, req.ip, (0, pagination_1.pathId)(req.params.id));
    res.json(result);
}));
// Evaluar umbrales y generar alertas si corresponde
router.post('/thresholds/evaluate', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { entityType, context, targetLocationId } = zod_1.z.object({
        entityType: zod_1.z.enum(['TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST', 'PRODUCT']),
        context: zod_1.z.record(zod_1.z.unknown()),
        targetLocationId: zod_1.z.number().int().positive().optional(),
    }).parse(req.body);
    const alerts = await (0, businessRules_service_1.evaluateThresholdsAndAlert)(entityType, context, targetLocationId);
    res.json({ alerts });
}));
exports.default = router;
