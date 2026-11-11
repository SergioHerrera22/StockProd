"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const drivers_service_1 = require("./drivers.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
router.get('/drivers', (0, auth_1.requirePerm)('users.read'), (0, errorHandler_1.asyncH)(async (_req, res) => {
    res.json({ drivers: await (0, drivers_service_1.listDrivers)() });
}));
router.get('/my-assignments', (0, errorHandler_1.asyncH)(async (req, res) => {
    res.json({ assignments: await (0, drivers_service_1.getMyAssignments)(req.user) });
}));
router.get('/my-history', (0, errorHandler_1.asyncH)(async (req, res) => {
    res.json({ history: await (0, drivers_service_1.getMyHistory)(req.user) });
}));
router.post('/assign', (0, auth_1.requirePerm)('deliveries.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const body = zod_1.z.object({
        type: zod_1.z.enum(['DELIVERY', 'TRANSFER']),
        id: zod_1.z.number().int().positive(),
        driverUserId: zod_1.z.number().int().positive(),
    }).parse(req.body);
    res.json(await (0, drivers_service_1.assignDriver)(req.user, req.ip, body.type, body.id, body.driverUserId));
}));
router.post('/start', (0, auth_1.requirePerm)('tracking.gps'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const body = zod_1.z.object({
        type: zod_1.z.enum(['DELIVERY', 'TRANSFER']),
        id: zod_1.z.number().int().positive(),
    }).parse(req.body);
    res.json(await (0, drivers_service_1.startDelivery)(req.user, req.ip, body.type, body.id));
}));
router.post('/complete', (0, auth_1.requirePerm)('tracking.gps'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const body = zod_1.z.object({
        type: zod_1.z.enum(['DELIVERY', 'TRANSFER']),
        id: zod_1.z.number().int().positive(),
        notes: zod_1.z.string().optional(),
    }).parse(req.body);
    res.json(await (0, drivers_service_1.completeDelivery)(req.user, req.ip, body.type, body.id, body.notes));
}));
router.get('/delays', (0, auth_1.requirePerm)('tracking.read'), (0, errorHandler_1.asyncH)(async (_req, res) => {
    res.json(await (0, drivers_service_1.getAdminDelays)());
}));
router.post('/geocode', (0, errorHandler_1.asyncH)(async (req, res) => {
    const body = zod_1.z.object({ address: zod_1.z.string().min(3) }).parse(req.body);
    res.json(await (0, drivers_service_1.geocodeAddress)(body.address));
}));
exports.default = router;
