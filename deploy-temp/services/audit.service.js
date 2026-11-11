"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAudit = writeAudit;
/** Registra una operacion en audit_logs. */
async function writeAudit(poolOrClient, entry) {
    await poolOrClient.query(`INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`, [
        entry.userId ?? null,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null,
    ]);
}
