"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listApprovalRules = listApprovalRules;
exports.createApprovalRule = createApprovalRule;
exports.updateApprovalRule = updateApprovalRule;
exports.evaluateApprovalRules = evaluateApprovalRules;
exports.createApprovalRequest = createApprovalRequest;
exports.listApprovalRequests = listApprovalRequests;
exports.getApprovalRequest = getApprovalRequest;
exports.resolveApprovalRequest = resolveApprovalRequest;
exports.cancelApprovalRequest = cancelApprovalRequest;
exports.checkApprovalStatus = checkApprovalStatus;
const pool_1 = require("../db/pool");
const errors_1 = require("../lib/errors");
const audit_service_1 = require("./audit.service");
/**
 * Listar reglas de aprobacion
 */
async function listApprovalRules(opts) {
    const params = [];
    const where = [];
    if (opts.entityType) {
        params.push(opts.entityType);
        where.push(`entity_type = $${params.length}`);
    }
    if (opts.operation) {
        params.push(opts.operation);
        where.push(`operation = $${params.length}`);
    }
    if (opts.isActive !== undefined) {
        params.push(opts.isActive);
        where.push(`is_active = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await (0, pool_1.query)(`SELECT COUNT(*) total FROM approval_rules ${whereSql}`, params);
    const rows = await (0, pool_1.query)(`SELECT * FROM approval_rules ${whereSql} ORDER BY priority ASC, id ASC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`, params);
    return { rules: rows.rows.map(mapRule), total: Number(count.rows[0].total) };
}
function mapRule(r) {
    return {
        id: r.id,
        name: r.name,
        entityType: r.entity_type,
        operation: r.operation,
        condition: r.condition,
        action: r.action,
        isActive: r.is_active,
        priority: r.priority,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
/**
 * Crear regla de aprobacion
 */
async function createApprovalRule(user, ip, input) {
    return (0, pool_1.withTx)(async (c) => {
        const r = await c.query(`INSERT INTO approval_rules (name, entity_type, operation, condition, action, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [input.name, input.entityType, input.operation, JSON.stringify(input.condition), JSON.stringify(input.action), input.priority ?? 100, user.id]);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'APPROVAL_RULE_CREATE', entity: 'approval_rule', entityId: r.rows[0].id, details: input, ip });
        return { id: r.rows[0].id };
    });
}
/**
 * Actualizar regla
 */
async function updateApprovalRule(user, ip, id, input) {
    return (0, pool_1.withTx)(async (c) => {
        const existing = await c.query('SELECT id FROM approval_rules WHERE id = $1', [id]);
        if (!existing.rows[0])
            throw errors_1.ApiError.notFound('Regla no encontrada');
        const fields = [];
        const values = [];
        let idx = 1;
        if (input.name !== undefined) {
            fields.push(`name = $${idx++}`);
            values.push(input.name);
        }
        if (input.condition !== undefined) {
            fields.push(`condition = $${idx++}`);
            values.push(JSON.stringify(input.condition));
        }
        if (input.action !== undefined) {
            fields.push(`action = $${idx++}`);
            values.push(JSON.stringify(input.action));
        }
        if (input.priority !== undefined) {
            fields.push(`priority = $${idx++}`);
            values.push(input.priority);
        }
        if (input.isActive !== undefined) {
            fields.push(`is_active = $${idx++}`);
            values.push(input.isActive);
        }
        if (!fields.length)
            return { ok: true };
        fields.push(`updated_at = now()`);
        values.push(id);
        await c.query(`UPDATE approval_rules SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'APPROVAL_RULE_UPDATE', entity: 'approval_rule', entityId: id, details: input, ip });
        return { ok: true };
    });
}
/**
 * Evaluar reglas para una operacion (devuelve reglas que aplican)
 */
async function evaluateApprovalRules(entityType, operation, context) {
    const rows = await (0, pool_1.query)(`SELECT * FROM evaluate_approval_rules($1::approval_entity, $2, $3::jsonb)`, [entityType, operation, JSON.stringify(context)]);
    return rows.rows;
}
/**
 * Crear solicitud de aprobacion.
 * Acepta un PoolClient OPCIONAL: invocada dentro de la transaccion del
 * documento padre (entrada/transferencia/entrega/conteo), corre en esa MISMA
 * tx. Antes abria withTx propia: obtenia una SEGUNDA conexion del pool con la
 * primera retenida (agotamiento/bloqueos bajo carga) y, peor, si el padre
 * hacia ROLLBACK la solicitud quedaba COMMITTEADA apuntando a un documento
 * que nunca existio. Con client opcional queda todo atomico.
 */
async function createApprovalRequest(input, client) {
    const run = async (c) => {
        const r = await c.query(`SELECT create_approval_request($1,$2,$3,$4,$5,$6::jsonb,$7) AS id`, [input.ruleId, input.entityType, input.entityId, input.entityNumber, input.requestedBy, JSON.stringify(input.context), input.expiresHours ?? 48]);
        return { approvalRequestId: r.rows[0].id };
    };
    return client ? run(client) : (0, pool_1.withTx)(run);
}
/**
 * Listar solicitudes pendientes (para el aprobador)
 */
async function listApprovalRequests(opts) {
    const params = [];
    const where = [];
    if (opts.status) {
        params.push(opts.status);
        where.push(`status = $${params.length}`);
    }
    if (opts.entityType) {
        params.push(opts.entityType);
        where.push(`entity_type = $${params.length}`);
    }
    if (opts.requestedBy) {
        params.push(opts.requestedBy);
        where.push(`requested_by = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await (0, pool_1.query)(`SELECT COUNT(*) total FROM approval_requests ${whereSql}`, params);
    const rows = await (0, pool_1.query)(`SELECT ar.*, u.full_name AS requested_by_name
     FROM approval_requests ar
     JOIN users u ON u.id = ar.requested_by
     ${whereSql} ORDER BY ar.requested_at DESC LIMIT ${opts.pageSize} OFFSET ${opts.offset}`, params);
    return { requests: rows.rows.map(mapRequest), total: Number(count.rows[0].total) };
}
function mapRequest(r) {
    return {
        id: r.id,
        ruleId: r.rule_id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityNumber: r.entity_number,
        requestedBy: r.requested_by,
        requestedAt: r.requested_at,
        status: r.status,
        context: r.context,
        resolvedBy: r.resolved_by,
        resolvedAt: r.resolved_at,
        resolutionNotes: r.resolution_notes,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        requestedByName: r.requested_by_name,
    };
}
/**
 * Obtener detalle de solicitud con historial
 */
async function getApprovalRequest(id) {
    const head = await (0, pool_1.query)(`SELECT ar.*, u.full_name AS requested_by_name, ru.full_name AS resolved_by_name
     FROM approval_requests ar
     JOIN users u ON u.id = ar.requested_by
     LEFT JOIN users ru ON ru.id = ar.resolved_by
     WHERE ar.id = $1`, [id]);
    if (!head.rows[0])
        return null;
    const hist = await (0, pool_1.query)(`SELECT ah.*, u.full_name AS performed_by_name
     FROM approval_history ah
     JOIN users u ON u.id = ah.performed_by
     WHERE ah.approval_request_id = $1 ORDER BY ah.performed_at`, [id]);
    return { ...mapRequest(head.rows[0]), history: hist.rows.map(mapHistory) };
}
function mapHistory(r) {
    return {
        id: r.id,
        approvalRequestId: r.approval_request_id,
        action: r.action,
        performedBy: r.performed_by,
        performedAt: r.performed_at,
        notes: r.notes,
        previousStatus: r.previous_status,
        newStatus: r.new_status,
    };
}
/**
 * Resolver solicitud (aprobar/rechazar)
 */
async function resolveApprovalRequest(user, ip, id, action, notes) {
    return (0, pool_1.withTx)(async (c) => {
        const r = await c.query(`SELECT resolve_approval_request($1, $2, $3, $4) AS success`, [id, user.id, action, notes ?? null]);
        if (!r.rows[0].success)
            throw errors_1.ApiError.conflict('No se pudo resolver la solicitud');
        const req = await getApprovalRequest(id);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: `APPROVAL_REQUEST_${action}`, entity: 'approval_request', entityId: id, details: { action, notes, entityType: req?.entityType, entityNumber: req?.entityNumber }, ip });
        return { ok: true, request: req };
    });
}
/**
 * Cancelar solicitud propia (solo si PENDIENTE)
 */
async function cancelApprovalRequest(user, ip, id) {
    return (0, pool_1.withTx)(async (c) => {
        const req = await c.query('SELECT status, requested_by FROM approval_requests WHERE id = $1 FOR UPDATE', [id]);
        if (!req.rows[0])
            throw errors_1.ApiError.notFound('Solicitud no encontrada');
        if (req.rows[0].requested_by !== user.id)
            throw errors_1.ApiError.forbidden('Solo el solicitante puede cancelar');
        if (req.rows[0].status !== 'PENDIENTE')
            throw errors_1.ApiError.conflict('Solo se pueden cancelar solicitudes pendientes');
        await c.query(`UPDATE approval_requests SET status = 'CANCELADO', updated_at = now() WHERE id = $1`, [id]);
        await c.query(`INSERT INTO approval_history (approval_request_id, action, performed_by, previous_status, new_status, notes) VALUES ($1, 'CANCELLED', $2, $3, 'CANCELADO', 'Cancelada por solicitante')`, [id, user.id, req.rows[0].status]);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'APPROVAL_REQUEST_CANCEL', entity: 'approval_request', entityId: id, ip });
        return { ok: true };
    });
}
/**
 * Verificar si una entidad tiene aprobacion pendiente o aprobada
 */
async function checkApprovalStatus(entityType, entityId) {
    const r = await (0, pool_1.query)(`SELECT status, id FROM approval_requests WHERE entity_type = $1 AND entity_id = $2 ORDER BY requested_at DESC LIMIT 1`, [entityType, entityId]);
    if (!r.rows[0])
        return { status: 'NOT_REQUIRED', approvalId: null };
    return { status: r.rows[0].status, approvalId: r.rows[0].id };
}
