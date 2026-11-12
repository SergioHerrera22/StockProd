"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const locationPermissions_service_1 = require("../../services/locationPermissions.service");
const pagination_1 = require("../../lib/pagination");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired, (0, auth_1.requirePerm)('users.manage'));
// Catálogo de permisos estándar (para UI)
router.get('/catalog', (0, errorHandler_1.asyncH)(async (_req, res) => {
    res.json({ permissions: locationPermissions_service_1.STANDARD_PERMISSIONS });
}));
// Permisos efectivos del usuario actual (para frontend)
router.get('/my-effective', (0, errorHandler_1.asyncH)(async (req, res) => {
    const perms = await (0, locationPermissions_service_1.getEffectivePermissions)(req.user.id);
    res.json({ permissions: perms });
}));
// Verificar permiso específico (para guards en frontend)
router.get('/check', (0, errorHandler_1.asyncH)(async (req, res) => {
    const { permission, locationId } = zod_1.z.object({
        permission: zod_1.z.string(),
        locationId: zod_1.z.number().int().positive().optional(),
    }).parse(req.query);
    const has = await (0, locationPermissions_service_1.hasEffectivePermission)(req.user.id, permission, locationId);
    res.json({ hasPermission: has });
}));
// Gestionar permisos de un usuario
router.get('/user/:userId', (0, errorHandler_1.asyncH)(async (req, res) => {
    const perms = await (0, locationPermissions_service_1.listUserPermissions)((0, pagination_1.pathId)(req.params.userId));
    res.json({ permissions: perms });
}));
router.post('/user/:userId', (0, errorHandler_1.asyncH)(async (req, res) => {
    const input = zod_1.z.object({
        locationId: zod_1.z.number().int().positive(),
        permission: zod_1.z.string(),
        scope: zod_1.z.enum(['GLOBAL', 'LOCATION', 'OWN_LOCATION']),
        expiresAt: zod_1.z.string().datetime().nullable().optional(),
    }).parse(req.body);
    const result = await (0, locationPermissions_service_1.grantLocationPermission)(req.user, req.ip, {
        userId: (0, pagination_1.pathId)(req.params.userId),
        locationId: input.locationId,
        permission: input.permission,
        scope: input.scope,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
    res.status(201).json(result);
}));
router.delete('/user/:userId/:locationId/:permission', (0, errorHandler_1.asyncH)(async (req, res) => {
    const result = await (0, locationPermissions_service_1.revokeLocationPermission)(req.user, req.ip, (0, pagination_1.pathId)(req.params.userId), (0, pagination_1.pathId)(req.params.locationId), req.params.permission);
    res.json(result);
}));
// Usuarios con permisos en una ubicación
router.get('/location/:locationId', (0, errorHandler_1.asyncH)(async (req, res) => {
    const perms = await (0, locationPermissions_service_1.listLocationPermissions)((0, pagination_1.pathId)(req.params.locationId));
    res.json({ permissions: perms });
}));
exports.default = router;
