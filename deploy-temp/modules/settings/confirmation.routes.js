"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const errorHandler_1 = require("../../middleware/errorHandler");
const auth_1 = require("../../middleware/auth");
const confirmationSettings_service_1 = require("../../services/confirmationSettings.service");
const router = (0, express_1.Router)();
router.use(auth_1.authRequired);
router.get('/', (0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (_req, res) => {
    const rows = await (0, confirmationSettings_service_1.listConfirmationSettings)();
    res.json({ settings: rows });
}));
router.put('/:module/:action', (0, auth_1.requirePerm)('settings.write'), (0, errorHandler_1.asyncH)(async (req, res) => {
    const schema = zod_1.z.object({
        allow_same_user: zod_1.z.boolean().optional(),
        require_different_user: zod_1.z.boolean().optional(),
        require_min_role: zod_1.z.string().nullable().optional(),
        require_dual_auth: zod_1.z.boolean().optional(),
        enabled: zod_1.z.boolean().optional(),
        notes: zod_1.z.string().nullable().optional(),
    });
    const body = schema.parse(req.body);
    const result = await (0, confirmationSettings_service_1.upsertConfirmationSetting)(req.user.id, req.ip, {
        module: req.params.module,
        action: req.params.action,
        ...body,
    });
    res.json(result);
}));
exports.default = router;
