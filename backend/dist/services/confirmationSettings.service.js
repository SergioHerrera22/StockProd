"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfirmationSetting = getConfirmationSetting;
exports.listConfirmationSettings = listConfirmationSettings;
exports.upsertConfirmationSetting = upsertConfirmationSetting;
const pool_1 = require("../db/pool");
const audit_service_1 = require("./audit.service");
const memCache_1 = require("../lib/memCache");
async function getConfirmationSetting(c, module, action) {
    // Config cambiante solo en el panel admin (023 system_confirmation_settings):
    // se cachea 30s para evitar un round-trip mas en cada confirm/approve/void.
    return (0, memCache_1.cached)(`confirm-setting:${module}:${action}`, 30_000, async () => {
        const r = await c.query(`SELECT module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at
       FROM system_confirmation_settings
       WHERE module = $1 AND action = $2`, [module, action]);
        return r.rows[0] ?? null;
    });
}
async function listConfirmationSettings() {
    const r = await (0, pool_1.query)(`SELECT module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at
     FROM system_confirmation_settings
     ORDER BY module, action`);
    return r.rows;
}
async function upsertConfirmationSetting(userId, ip, input) {
    const r = await (0, pool_1.query)(`INSERT INTO system_confirmation_settings (
       module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at
     ) VALUES (
       $1, $2, COALESCE($3, false), COALESCE($4, true), $5, COALESCE($6, false), COALESCE($7, true), $8, $9, now()
     )
     ON CONFLICT (module, action) DO UPDATE SET
       allow_same_user = EXCLUDED.allow_same_user,
       require_different_user = EXCLUDED.require_different_user,
       require_min_role = EXCLUDED.require_min_role,
       require_dual_auth = EXCLUDED.require_dual_auth,
       enabled = EXCLUDED.enabled,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING module, action, allow_same_user, require_different_user, require_min_role, require_dual_auth, enabled, notes, updated_by, updated_at`, [
        input.module,
        input.action,
        input.allow_same_user,
        input.require_different_user,
        input.require_min_role ?? null,
        input.require_dual_auth,
        input.enabled,
        input.notes ?? null,
        userId,
    ]);
    // Audit
    (0, memCache_1.cacheInvalidate)('confirm-setting:');
    try {
        const poolMod = await Promise.resolve().then(() => __importStar(require('../db/pool')));
        const client = await poolMod.pool.connect();
        try {
            await (0, audit_service_1.writeAudit)(client, {
                userId,
                action: 'SYSTEM_CONFIRMATION_SETTINGS_UPDATE',
                entity: 'system_confirmation_settings',
                entityId: null,
                details: { ...input, module: input.module, action: input.action },
                ip,
            });
        }
        finally {
            client.release();
        }
    }
    catch { }
    return r.rows[0];
}
