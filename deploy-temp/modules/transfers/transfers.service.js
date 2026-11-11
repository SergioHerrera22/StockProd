"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTransfer = createTransfer;
exports.approveTransfer = approveTransfer;
exports.rejectTransfer = rejectTransfer;
exports.receiveTransfer = receiveTransfer;
exports.verifyTransferReceipt = verifyTransferReceipt;
exports.voidTransfer = voidTransfer;
exports.getTransfer = getTransfer;
exports.listTransfers = listTransfers;
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const stockEngine_1 = require("../../services/stockEngine");
const numbering_1 = require("../../services/numbering");
const audit_service_1 = require("../../services/audit.service");
const locationGuard_1 = require("../../lib/locationGuard");
const reservation_service_1 = require("../../services/reservation.service");
const businessRules_service_1 = require("../../services/businessRules.service");
const approval_service_1 = require("../../services/approval.service");
const alerts_service_1 = require("../../services/alerts.service");
const confirmationSettings_service_1 = require("../../services/confirmationSettings.service");
async function validateTransferItems(c, items) {
    if (!items.length)
        throw errors_1.ApiError.badRequest('La transferencia debe tener al menos un producto');
    const ids = items.map((i) => i.productId);
    const r = await c.query('SELECT id, name, is_active FROM products WHERE id = ANY($1)', [ids]);
    const map = new Map(r.rows.map((p) => [p.id, p]));
    for (const it of items) {
        if (!Number.isFinite(it.quantity) || it.quantity <= 0) {
            throw errors_1.ApiError.badRequest('Todas las cantidades deben ser mayores a cero');
        }
        const p = map.get(it.productId);
        if (!p)
            throw errors_1.ApiError.badRequest(`Producto inexistente (id ${it.productId})`);
        if (!p.is_active)
            throw errors_1.ApiError.badRequest(`El producto "${p.name}" esta inactivo`);
    }
}
/**
 * Crea la transferencia: RESERVA stock en origen y CONSUME (descuenta) atómicamente.
 * La mercaderia queda EN_TRANSITO: no suma al destino hasta recibir.
 * Ahora con: evaluación de reglas, solicitud de aprobación si corresponde, segregación de funciones.
 */
async function createTransfer(user, ip, input) {
    (0, locationGuard_1.assertTransferAccess)(user, input.originLocationId, input.destinationLocationId);
    return (0, pool_1.withTx)(async (c) => {
        if (input.originLocationId === input.destinationLocationId) {
            throw errors_1.ApiError.badRequest('El origen y el destino deben ser distintos');
        }
        await validateTransferItems(c, input.items);
        const locs = await c.query('SELECT id, name, is_active FROM locations WHERE id = ANY($1)', [[input.originLocationId, input.destinationLocationId]]);
        if (locs.rows.length !== 2 || locs.rows.some((l) => !l.is_active)) {
            throw errors_1.ApiError.badRequest('Ubicacion de origen o destino invalida');
        }
        const qtySum = input.items.reduce((s, it) => s + it.quantity, 0);
        const context = { qty_sum: qtySum, location_id: input.originLocationId, user_role: user.role };
        // Evaluar reglas de negocio ANTES de crear
        const rules = await (0, businessRules_service_1.evaluateBusinessRules)('TRANSFER', 'BEFORE_CREATE', context);
        const requiresApproval = rules.some(r => r.action.require_approval);
        let status = 'EN_TRANSITO';
        let approvalRequestId = null;
        if (requiresApproval) {
            status = 'BORRADOR'; // Queda en borrador hasta aprobación
        }
        const number = await (0, numbering_1.nextDocNumber)(c, 'transfer');
        const driverUserId = input.driverUserId ?? input.driverId ?? null;
        const t = await c.query(`INSERT INTO transfers (number, origin_location_id, destination_location_id, notes, created_by, status,
                              driver_user_id, driver_assigned_at, delivery_address, delivery_lat, delivery_lng, due_at, delivery_observations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [
            number,
            input.originLocationId,
            input.destinationLocationId,
            input.notes?.trim() || null,
            user.id,
            status,
            driverUserId,
            driverUserId ? new Date() : null,
            input.deliveryAddress?.trim() || null,
            input.deliveryLat ?? null,
            input.deliveryLng ?? null,
            input.dueAt ? new Date(input.dueAt) : null,
            input.deliveryObservations?.trim() || null,
        ]);
        const transferId = t.rows[0].id;
        // Insertar items en UNA sola query (unnest)
        await c.query(`INSERT INTO transfer_items (transfer_id, product_id, quantity_sent)
       SELECT $1, p, q FROM unnest($2::int[], $3::numeric[]) AS t(p, q)`, [transferId, input.items.map(it => it.productId), input.items.map(it => it.quantity)]);
        // Si requiere aprobación, crear solicitud y NO reservar/consumir aún
        if (requiresApproval) {
            const rule = rules.find(r => r.action.require_approval);
            await (0, approval_service_1.createApprovalRequest)({
                ruleId: rule.ruleId,
                entityType: 'TRANSFER',
                entityId: transferId,
                entityNumber: number,
                requestedBy: user.id,
                context: { ...context, items: input.items, origin: locs.rows.find(l => l.id === input.originLocationId)?.name, destination: locs.rows.find(l => l.id === input.destinationLocationId)?.name },
            }, c);
            await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'TRANSFER_CREATE_PENDING_APPROVAL', entity: 'transfer', entityId: transferId, details: { number, requiresApproval: true, rules: rules.map(r => r.ruleCode) }, ip });
            return { id: transferId, number, status: 'BORRADOR', requiresApproval: true };
        }
        // ===== RESERVAR + CONSUMIR stock en origen (atómico) =====
        const reservationInputs = input.items.map(it => ({
            referenceType: 'TRANSFER',
            referenceId: transferId,
            productId: it.productId,
            sourceLocationId: input.originLocationId,
            quantity: it.quantity,
            reservedBy: user.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h para transferencias
        }));
        const reservations = await (0, reservation_service_1.reserveStockBatch)(c, reservationInputs);
        for (let i = 0; i < input.items.length; i++) {
            const it = input.items[i];
            const reservation = reservations[i];
            const consumeResult = await (0, reservation_service_1.consumeReservation)(c, {
                reservationId: reservation.reservationId,
                quantity: it.quantity,
                consumedBy: user.id,
                movementType: 'TRANS_SALIDA',
                reason: `Envio a transferencia ${number}`,
            });
            if (!consumeResult.success) {
                throw errors_1.ApiError.conflict(`Error al consumir reserva: ${consumeResult.message}`);
            }
        }
        // Registrar dispatched_by y dispatched_at (quien despacha)
        await c.query(`UPDATE transfers SET dispatched_by = $1, dispatched_at = now() WHERE id = $2`, [user.id, transferId]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: user.id, action: 'TRANSFER_CREATE', entity: 'transfer', entityId: transferId,
            details: { number, origin: input.originLocationId, destination: input.destinationLocationId, dispatchedBy: user.id }, ip,
        });
        return { id: transferId, number, status: 'EN_TRANSITO', requiresApproval: false };
    });
}
/**
 * Aprobar transferencia en borrador: reserva y consume stock, pasa a EN_TRANSITO
 */
async function approveTransfer(user, ip, id) {
    return (0, pool_1.withTx)(async (c) => {
        const t = await c.query('SELECT id, number, status, origin_location_id, destination_location_id, created_by FROM transfers WHERE id = $1 FOR UPDATE', [id]);
        const transfer = t.rows[0];
        if (!transfer)
            throw errors_1.ApiError.notFound('Transferencia no encontrada');
        if (transfer.status !== 'BORRADOR')
            throw errors_1.ApiError.conflict('Solo se pueden aprobar transferencias en borrador');
        (0, locationGuard_1.assertTransferAccess)(user, transfer.origin_location_id, transfer.destination_location_id);
        // Verificar que el aprobador no sea el creador (segregación configurable)
        const cfgAppr = await (0, confirmationSettings_service_1.getConfirmationSetting)(c, 'TRANSFER', 'APPROVE');
        if (cfgAppr?.enabled && cfgAppr.require_different_user && !cfgAppr.allow_same_user) {
            if (transfer.created_by === user.id) {
                throw errors_1.ApiError.forbidden('No puedes aprobar tu propia transferencia (segregación de funciones)');
            }
        }
        const items = await c.query('SELECT product_id, quantity_sent as quantity FROM transfer_items WHERE transfer_id = $1', [id]);
        const qtySum = items.rows.reduce((s, it) => s + Number(it.quantity), 0);
        const context = { qty_sum: qtySum, location_id: transfer.origin_location_id, user_role: user.role };
        // Evaluar reglas al momento de aprobar (por si cambiaron)
        const rules = await (0, businessRules_service_1.evaluateBusinessRules)('TRANSFER', 'BEFORE_CONFIRM', context);
        const stillRequiresApproval = rules.some(r => r.action.require_approval);
        if (stillRequiresApproval && user.role === 'EMPLEADO') {
            throw errors_1.ApiError.forbidden('Esta transferencia requiere aprobador con rol ENCARGADO o superior');
        }
        // Reservar y consumir
        const reservationInputs = items.rows.map(it => ({
            referenceType: 'TRANSFER',
            referenceId: transfer.id,
            productId: it.product_id,
            sourceLocationId: transfer.origin_location_id,
            quantity: Number(it.quantity),
            reservedBy: user.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }));
        const reservations = await (0, reservation_service_1.reserveStockBatch)(c, reservationInputs);
        for (let i = 0; i < items.rows.length; i++) {
            const it = items.rows[i];
            const consumeResult = await (0, reservation_service_1.consumeReservation)(c, {
                reservationId: reservations[i].reservationId,
                quantity: Number(it.quantity),
                consumedBy: user.id,
                movementType: 'TRANS_SALIDA',
                reason: `Envio a transferencia ${transfer.number} (aprobada)`,
            });
            if (!consumeResult.success) {
                throw errors_1.ApiError.conflict(`Error al consumir reserva: ${consumeResult.message}`);
            }
        }
        await c.query(`UPDATE transfers SET status = 'EN_TRANSITO', dispatched_by = $1, dispatched_at = now() WHERE id = $2`, [user.id, id]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: user.id, action: 'TRANSFER_APPROVE', entity: 'transfer', entityId: id,
            details: { number: transfer.number, approvedBy: user.id }, ip,
        });
        // Resolver solicitud de aprobación si existe
        await c.query(`UPDATE approval_requests SET status = 'APROBADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'TRANSFER' AND entity_id = $2 AND status = 'PENDIENTE'`, [user.id, id]);
        return { ok: true, status: 'EN_TRANSITO' };
    });
}
/**
 * Rechazar transferencia en borrador
 */
async function rejectTransfer(user, ip, id, reason) {
    return (0, pool_1.withTx)(async (c) => {
        const t = await c.query('SELECT id, number, status FROM transfers WHERE id = $1 FOR UPDATE', [id]);
        if (!t.rows[0])
            throw errors_1.ApiError.notFound('Transferencia no encontrada');
        if (t.rows[0].status !== 'BORRADOR')
            throw errors_1.ApiError.conflict('Solo se pueden rechazar transferencias en borrador');
        await c.query(`UPDATE transfers SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2 WHERE id = $3`, [user.id, `Rechazada: ${reason}`, id]);
        await c.query(`UPDATE approval_requests SET status = 'RECHAZADO', resolved_by = $1, resolved_at = now(), resolution_notes = $2 WHERE entity_type = 'TRANSFER' AND entity_id = $3 AND status = 'PENDIENTE'`, [user.id, reason, id]);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'TRANSFER_REJECT', entity: 'transfer', entityId: id, details: { reason }, ip });
        return { ok: true };
    });
}
async function receiveTransfer(user, ip, id, items) {
    return (0, pool_1.withTx)(async (c) => {
        const t = await c.query('SELECT id, number, status, destination_location_id, origin_location_id FROM transfers WHERE id = $1 FOR UPDATE', [id]);
        const transfer = t.rows[0];
        if (!transfer)
            throw errors_1.ApiError.notFound('Transferencia no encontrada');
        (0, locationGuard_1.assertLocationAccess)(user, transfer.destination_location_id);
        if (!['EN_TRANSITO', 'RECIBIDO_CON_DIF'].includes(transfer.status)) {
            throw errors_1.ApiError.conflict(`La transferencia ${transfer.number} no admite nuevas recepciones (estado: ${transfer.status})`);
        }
        // Segregación: quien recibe NO puede ser quien despachó (configurable).
        const dispatched = await c.query('SELECT dispatched_by FROM transfers WHERE id = $1', [id]);
        const cfgRecv = await (0, confirmationSettings_service_1.getConfirmationSetting)(c, 'TRANSFER', 'RECEIVE');
        if (cfgRecv?.enabled && cfgRecv.require_different_user && !cfgRecv.allow_same_user) {
            if (dispatched.rows[0]?.dispatched_by === user.id) {
                throw errors_1.ApiError.forbidden('No puedes recibir una transferencia que tú mismo despachaste (segregación de funciones)');
            }
        }
        const dbItems = await c.query('SELECT id, product_id, quantity_sent, quantity_received FROM transfer_items WHERE transfer_id = $1 ORDER BY product_id, id', [id]);
        const byId = new Map(dbItems.rows.map((item) => [item.id, item]));
        // quantityReceived representa SOLO las unidades de esta recepción.
        // La acumulación se realiza contra lo ya registrado, nunca se sobrescribe.
        const receivedThisCall = new Map();
        for (const item of items) {
            const dbItem = byId.get(item.itemId);
            if (!dbItem)
                throw errors_1.ApiError.badRequest('Item de transferencia invalido');
            if (!Number.isFinite(item.quantityReceived) || item.quantityReceived < 0) {
                throw errors_1.ApiError.badRequest('Cantidades recibidas invalidas');
            }
            if (Math.abs(item.quantityReceived * 1000 - Math.round(item.quantityReceived * 1000)) > 1e-7) {
                throw errors_1.ApiError.badRequest('Las cantidades recibidas admiten hasta 3 decimales');
            }
            receivedThisCall.set(item.itemId, (receivedThisCall.get(item.itemId) ?? 0) + item.quantityReceived);
        }
        const deltas = [...receivedThisCall.entries()]
            .filter(([, quantity]) => quantity > 0)
            .map(([itemId, quantity]) => ({ itemId, quantity }));
        if (!deltas.length) {
            throw errors_1.ApiError.badRequest('Debes indicar cantidades recibidas mayores a cero');
        }
        for (const delta of deltas) {
            const dbItem = byId.get(delta.itemId);
            const alreadyReceived = Number(dbItem.quantity_received ?? 0);
            const remaining = Number(dbItem.quantity_sent) - alreadyReceived;
            if (delta.quantity - remaining > 0.0005) {
                throw errors_1.ApiError.conflict(`La cantidad recibida supera el pendiente del producto (enviado: ${dbItem.quantity_sent}, recibido: ${alreadyReceived}, pendiente: ${Math.max(0, remaining)})`);
            }
        }
        // El lock FOR UPDATE de la transferencia serializa las recepciones.
        // Bloqueamos stock en orden estable y aplicamos únicamente el delta nuevo.
        const sortedDeltas = [...deltas].sort((a, b) => byId.get(a.itemId).product_id - byId.get(b.itemId).product_id);
        for (const delta of sortedDeltas) {
            const dbItem = byId.get(delta.itemId);
            await (0, stockEngine_1.applyStockChange)(c, {
                productId: dbItem.product_id,
                locationId: transfer.destination_location_id,
                delta: delta.quantity,
                type: 'TRANS_ENTRADA',
                referenceType: 'TRANSFER',
                referenceId: transfer.id,
                referenceNumber: transfer.number,
                userId: user.id,
                reason: `Recepcion parcial de transferencia ${transfer.number}`,
            });
        }
        // Sumar cantidades por línea; no tocar las líneas omitidas del request.
        await c.query(`UPDATE transfer_items ti
       SET quantity_received = COALESCE(ti.quantity_received, 0) + v.qty
       FROM unnest($2::int[], $3::numeric[]) AS v(iid, qty)
       WHERE ti.id = v.iid AND ti.transfer_id = $1`, [id, deltas.map((item) => item.itemId), deltas.map((item) => item.quantity)]);
        const allComplete = dbItems.rows.every((dbItem) => {
            const previous = Number(dbItem.quantity_received ?? 0);
            const additional = receivedThisCall.get(dbItem.id) ?? 0;
            return previous + additional >= Number(dbItem.quantity_sent) - 0.0005;
        });
        const status = allComplete ? 'RECIBIDO' : 'RECIBIDO_CON_DIF';
        await c.query(`UPDATE transfers SET status = $1, received_by = $2, received_at = now() WHERE id = $3`, [status, user.id, id]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: user.id, action: 'TRANSFER_RECEIVE', entity: 'transfer', entityId: id,
            details: {
                status,
                receivedThisCall: deltas,
                cumulativeReceived: dbItems.rows.map((dbItem) => ({
                    itemId: dbItem.id,
                    quantity: Number(dbItem.quantity_received ?? 0) + (receivedThisCall.get(dbItem.id) ?? 0),
                    quantitySent: Number(dbItem.quantity_sent),
                })),
                receivedBy: user.id,
            },
            ip,
        });
        return { ok: true, status, receivedItems: deltas };
    });
}
/**
 * Verificar recepción (segunda persona) - opcional, para transferencias críticas
 */
async function verifyTransferReceipt(user, ip, id) {
    return (0, pool_1.withTx)(async (c) => {
        const t = await c.query('SELECT id, number, status, received_by FROM transfers WHERE id = $1 FOR UPDATE', [id]);
        if (!t.rows[0])
            throw errors_1.ApiError.notFound('Transferencia no encontrada');
        if (!['RECIBIDO', 'RECIBIDO_CON_DIF'].includes(t.rows[0].status)) {
            throw errors_1.ApiError.conflict('Solo se pueden verificar transferencias recibidas');
        }
        const cfgVer = await (0, confirmationSettings_service_1.getConfirmationSetting)(c, 'TRANSFER', 'VERIFY');
        if (cfgVer?.enabled && cfgVer.require_different_user && !cfgVer.allow_same_user) {
            if (t.rows[0].received_by === user.id) {
                throw errors_1.ApiError.forbidden('No puedes verificar una recepción que tú mismo hiciste (segregación de funciones)');
            }
        }
        await c.query(`UPDATE transfers SET verified_by = $1, verified_at = now() WHERE id = $2`, [user.id, id]);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'TRANSFER_VERIFY', entity: 'transfer', entityId: id, details: { verifiedBy: user.id }, ip });
        return { ok: true };
    });
}
/** Anula una transferencia en transito y devuelve el stock al origen. Libera reservas.
 *  Requiere DOBLE AUTORIZACIÓN: voided_by != void_approved_by (rol >= ENCARGADO)
 */
async function voidTransfer(user, ip, id, reason, voidApprovedBy) {
    return (0, pool_1.withTx)(async (c) => {
        const t = await c.query('SELECT status, number, origin_location_id, destination_location_id, void_approved_by FROM transfers WHERE id = $1 FOR UPDATE', [id]);
        const transfer = t.rows[0];
        if (!transfer)
            throw errors_1.ApiError.notFound('Transferencia no encontrada');
        (0, locationGuard_1.assertLocationAccess)(user, transfer.origin_location_id);
        // Si ya estaba recibida, requiere doble autorización. 'CONFIRMADO' no es un
        // estado de transferencia (estados: BORRADOR/EN_TRANSITO/RECIBIDO/
        // RECIBIDO_CON_DIF/ANULADO) y figuraba en la lista por error.
        const requiresDualAuth = ['RECIBIDO', 'RECIBIDO_CON_DIF'].includes(transfer.status);
        if (requiresDualAuth) {
            if (!voidApprovedBy)
                throw errors_1.ApiError.badRequest('Anulación de transferencia procesada requiere segundo autorizador (voidApprovedBy)');
            if (voidApprovedBy === user.id)
                throw errors_1.ApiError.forbidden('El segundo autorizador debe ser distinto del solicitante');
            // Verificar rol del aprobador
            const approver = await c.query('SELECT role_code FROM users WHERE id = $1', [voidApprovedBy]);
            if (!approver.rows[0] || !['ENCARGADO', 'ADMIN'].includes(approver.rows[0].role_code)) {
                throw errors_1.ApiError.forbidden('El segundo autorizador debe tener rol ENCARGADO o ADMIN');
            }
        }
        if (transfer.status === 'ANULADO')
            throw errors_1.ApiError.conflict('La transferencia ya esta anulada');
        // Evaluar reglas de anulación
        const rules = await (0, businessRules_service_1.evaluateBusinessRules)('VOID', 'VOID', { entity_id: id, user_role: user.role });
        const requiresApproval = rules.some(r => r.action.require_approval);
        if (requiresApproval && !voidApprovedBy) {
            throw errors_1.ApiError.badRequest('Esta anulación requiere aprobación según reglas de negocio');
        }
        // Liberar reservas de la transferencia
        await (0, reservation_service_1.releaseAllReservationsForReference)(c, 'TRANSFER', id, user.id, `Anulación: ${reason}`);
        // Anular una transferencia RECIBIDA debe revertir TODO el movimiento:
        // lo no recibido vuelve a origin, y lo ya recibido sale de destino y
        // vuelve a origin (antes el stock recibido quedaba en destino amparado
        // por un documento ANULADO, sin rastro).
        if (['EN_TRANSITO', 'RECIBIDO', 'RECIBIDO_CON_DIF'].includes(transfer.status)) {
            const items = await c.query('SELECT product_id, quantity_sent, quantity_received FROM transfer_items WHERE transfer_id = $1', [id]);
            for (const it of items.rows) {
                const sent = Number(it.quantity_sent);
                const received = it.quantity_received ? Number(it.quantity_received) : 0;
                if (received > 0) {
                    // Revertir lo ya recibido en destino
                    await (0, stockEngine_1.applyStockChange)(c, {
                        productId: it.product_id, locationId: transfer.destination_location_id,
                        delta: -received,
                        type: 'TRANS_SALIDA', referenceType: 'TRANSFER', referenceId: id,
                        referenceNumber: transfer.number, userId: user.id,
                        reason: `Anulacion de transferencia ${transfer.number}: retiro de lo recibido`,
                    });
                }
                if (sent > 0) {
                    // Recuperar el total enviado en origen
                    await (0, stockEngine_1.applyStockChange)(c, {
                        productId: it.product_id, locationId: transfer.origin_location_id,
                        delta: sent,
                        type: 'TRANS_ENTRADA', referenceType: 'TRANSFER', referenceId: id,
                        referenceNumber: transfer.number, userId: user.id,
                        reason: `Anulacion de transferencia ${transfer.number}: ${reason}`,
                    });
                }
            }
        }
        await c.query(`UPDATE transfers SET status = 'ANULADO', voided_by = $1, voided_at = now(), void_reason = $2, void_approved_by = $3 WHERE id = $4`, [user.id, reason, voidApprovedBy ?? null, id]);
        // Resolver solicitudes de aprobacion pendientes del documento anulado
        await c.query(`UPDATE approval_requests SET status = 'RECHAZADO', resolved_by = $1, resolved_at = now() WHERE entity_type = 'TRANSFER' AND entity_id = $2 AND status = 'PENDIENTE'`, [user.id, id]);
        await (0, audit_service_1.writeAudit)(c, {
            userId: user.id, action: 'TRANSFER_VOID', entity: 'transfer', entityId: id,
            details: { reason, voidApprovedBy, requiresDualAuth }, ip,
        });
        // Alerta si anulación inusual
        if (requiresDualAuth) {
            await (0, alerts_service_1.createAlert)({
                code: 'TRANSFER_VOID_DUAL_AUTH',
                severity: 'WARNING',
                entityType: 'TRANSFER',
                entityId: id,
                title: `Transferencia anulada con doble autorización: ${transfer.number}`,
                message: `Anulada por ${user.fullName}, autorizada por usuario ${voidApprovedBy}. Motivo: ${reason}`,
                data: { transferId: id, voidedBy: user.id, voidApprovedBy, reason },
                targetRoles: ['ADMIN'],
            });
        }
        return { ok: true };
    });
}
async function getTransfer(id) {
    // Lectura pura: sin transaccion (antes withTx = BEGIN/COMMIT de regalo)
    const c = await pool_1.pool.connect();
    try {
        const head = await c.query(`SELECT t.*, lo.name AS origin_name, ld.name AS destination_name,
              cu.full_name AS created_by_name, ru.full_name AS received_by_name,
              du.full_name AS dispatched_by_name, vu.full_name AS verified_by_name,
              vau.full_name AS void_approved_by_name,
              drv.full_name AS driver_name
       FROM transfers t
       JOIN locations lo ON lo.id = t.origin_location_id
       JOIN locations ld ON ld.id = t.destination_location_id
       JOIN users cu ON cu.id = t.created_by
       LEFT JOIN users ru ON ru.id = t.received_by
       LEFT JOIN users du ON du.id = t.dispatched_by
       LEFT JOIN users vu ON vu.id = t.verified_by
       LEFT JOIN users vau ON vau.id = t.void_approved_by
       LEFT JOIN users drv ON drv.id = t.driver_user_id
       WHERE t.id = $1`, [id]);
        if (!head.rows[0])
            return null;
        const items = await c.query(`SELECT ti.id, ti.product_id, ti.quantity_sent, ti.quantity_received,
              p.code, p.name, p.unit
       FROM transfer_items ti JOIN products p ON p.id = ti.product_id
       WHERE ti.transfer_id = $1 ORDER BY ti.id`, [id]);
        return { ...head.rows[0], items: items.rows };
    }
    finally {
        c.release();
    }
}
async function listTransfers(opts) {
    const params = [];
    const where = [];
    if (opts.status) {
        params.push(opts.status);
        where.push(`t.status = $${params.length}`);
    }
    if (opts.locationId) {
        params.push(opts.locationId);
        where.push(`(t.origin_location_id = $${params.length} OR t.destination_location_id = $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Un solo round-trip: el total viene en cada fila con COUNT(*) OVER()
    const rows = await (0, pool_1.query)(`SELECT t.id, t.number, t.status, t.origin_location_id, t.destination_location_id,
            lo.name AS origin_name, ld.name AS destination_name,
            t.created_at, t.dispatched_at, t.received_at, t.verified_at,
            t.driver_user_id, t.driver_assigned_at, t.delivery_address, t.delivered_at, t.delivery_started_at, t.due_at,
            drv.full_name AS driver_name,
            cu.full_name AS created_by_name,
            (SELECT COUNT(*) FROM transfer_items WHERE transfer_id = t.id) AS line_count,
            COUNT(*) OVER() AS total
     FROM transfers t
     JOIN locations lo ON lo.id = t.origin_location_id
     JOIN locations ld ON ld.id = t.destination_location_id
     JOIN users cu ON cu.id = t.created_by
     LEFT JOIN users drv ON drv.id = t.driver_user_id
     ${whereSql} ORDER BY t.created_at DESC
     LIMIT ${opts.pageSize} OFFSET ${opts.offset}`, params);
    const total = rows.rows.length > 0 && rows.rows[0].total != null ? Number(rows.rows[0].total) : 0;
    return { transfers: rows.rows.map(({ total: _t, ...rest }) => rest), total };
}
