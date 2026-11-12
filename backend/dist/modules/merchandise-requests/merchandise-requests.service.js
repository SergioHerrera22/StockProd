"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMerchandiseRequests = listMerchandiseRequests;
exports.getMerchandiseRequest = getMerchandiseRequest;
exports.createMerchandiseRequest = createMerchandiseRequest;
exports.setMerchandiseRequestStatus = setMerchandiseRequestStatus;
const pool_1 = require("../../db/pool");
const errors_1 = require("../../lib/errors");
const audit_service_1 = require("../../services/audit.service");
const permissions_1 = require("../../lib/permissions");
async function assertWarehouseManager(user, c) { if (user.role === 'ADMIN')
    return; if (!(0, permissions_1.hasPermission)(user.role, 'merchandise_requests.manage', user.permissions))
    throw errors_1.ApiError.forbidden(); const rows = c ? await c.query("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true") : await (0, pool_1.query)("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true"); if (rows.rows.length !== 1 || Number(user.locationId) !== Number(rows.rows[0].id))
    throw errors_1.ApiError.forbidden('Solo el encargado del Depósito Central puede gestionar todos los pedidos.'); }
async function centralWarehouseId(c) {
    const r = await c.query("SELECT id FROM locations WHERE type='DEPOSITO' AND is_active=true ORDER BY id");
    if (r.rows.length !== 1)
        throw errors_1.ApiError.conflict('Debe existir exactamente un Depósito Central activo para gestionar pedidos.');
    return r.rows[0].id;
}
async function listMerchandiseRequests(user, status) {
    const params = [];
    let where = '';
    if ((0, permissions_1.hasPermission)(user.role, 'merchandise_requests.manage', user.permissions)) {
        await assertWarehouseManager(user);
    }
    const manager = (0, permissions_1.hasPermission)(user.role, 'merchandise_requests.manage', user.permissions);
    if (!manager) {
        params.push(user.locationId);
        where = 'WHERE r.destination_location_id=$1';
    }
    if (status) {
        params.push(status);
        where += (where ? ' AND ' : 'WHERE ') + 'r.status=$' + params.length;
    }
    const result = await (0, pool_1.query)(`SELECT r.id,r.number,r.status,r.notes,r.created_at,r.destination_location_id,
      dst.name destination_name,u.full_name created_by_name,u.username,
      (SELECT count(*)::int FROM merchandise_request_items i WHERE i.request_id=r.id) item_count
     FROM merchandise_requests r
     JOIN locations dst ON dst.id=r.destination_location_id
     JOIN users u ON u.id=r.created_by
     ${where} ORDER BY r.created_at DESC LIMIT 200`, params);
    return result.rows;
}
async function getMerchandiseRequest(user, id) {
    return (0, pool_1.withTx)(async (c) => {
        const r = await c.query(`SELECT r.*, src.name origin_name,dst.name destination_name,u.full_name created_by_name
      FROM merchandise_requests r JOIN locations src ON src.id=r.origin_location_id
      JOIN locations dst ON dst.id=r.destination_location_id JOIN users u ON u.id=r.created_by
      WHERE r.id=$1`, [id]);
        const row = r.rows[0];
        if (!row)
            throw errors_1.ApiError.notFound('Pedido no encontrado');
        const manager = (0, permissions_1.hasPermission)(user.role, 'merchandise_requests.manage', user.permissions);
        if (manager)
            await assertWarehouseManager(user, c);
        if (!manager && Number(row.destination_location_id) !== Number(user.locationId))
            throw errors_1.ApiError.forbidden();
        const items = await c.query(`SELECT i.*,p.code,p.barcode,p.name,p.unit FROM merchandise_request_items i
      JOIN products p ON p.id=i.product_id WHERE i.request_id=$1 ORDER BY p.name`, [id]);
        return { ...row, items: items.rows };
    });
}
async function createMerchandiseRequest(user, items, notes, ip) {
    if (!user.locationId)
        throw errors_1.ApiError.forbidden('Tu usuario no tiene una sucursal asignada.');
    if (user.role === 'TRANSPORTE')
        throw errors_1.ApiError.forbidden();
    const merged = new Map();
    for (const it of items) {
        if (!Number.isInteger(it.productId) || it.productId <= 0 || !Number.isInteger(it.quantity) || it.quantity < 3)
            throw errors_1.ApiError.badRequest('Cada producto debe tener una cantidad mínima de 3 unidades.');
        merged.set(it.productId, (merged.get(it.productId) || 0) + it.quantity);
    }
    if (!merged.size)
        throw errors_1.ApiError.badRequest('Agregá al menos un producto.');
    return (0, pool_1.withTx)(async (c) => {
        const origin = await centralWarehouseId(c);
        if (origin === user.locationId)
            throw errors_1.ApiError.badRequest('El pedido debe realizarse desde una sucursal.');
        const loc = await c.query("SELECT id FROM locations WHERE id=$1 AND type='SUCURSAL' AND is_active=true", [user.locationId]);
        if (!loc.rows[0])
            throw errors_1.ApiError.forbidden('Tu usuario debe tener una sucursal activa asignada.');
        const ids = [...merged.keys()];
        const products = await c.query("SELECT id,name,is_active FROM products WHERE id=ANY($1::int[])", [ids]);
        if (products.rows.length !== ids.length || products.rows.some(p => !p.is_active))
            throw errors_1.ApiError.badRequest('Hay productos inexistentes o inactivos en el pedido.');
        const ins = await c.query(`INSERT INTO merchandise_requests(number,origin_location_id,destination_location_id,created_by,notes)
      VALUES ('PENDIENTE',$1,$2,$3,$4) RETURNING id`, [origin, user.locationId, user.id, notes?.trim() || null]);
        const id = ins.rows[0].id, number = 'PED-' + String(id).padStart(7, '0');
        await c.query('UPDATE merchandise_requests SET number=$1 WHERE id=$2', [number, id]);
        await c.query(`INSERT INTO merchandise_request_items(request_id,product_id,quantity_requested)
      SELECT $1,p,q FROM unnest($2::int[],$3::numeric[]) AS x(p,q)`, [id, ids, [...merged.values()]]);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'MERCHANDISE_REQUEST_CREATE', entity: 'merchandise_request', entityId: id, details: { number, items: ids.length, destination: user.locationId }, ip });
        return { id, number, status: 'PENDIENTE' };
    });
}
async function setMerchandiseRequestStatus(user, id, status, reason, ip) {
    await assertWarehouseManager(user);
    return (0, pool_1.withTx)(async (c) => {
        const r = await c.query('SELECT id,status FROM merchandise_requests WHERE id=$1 FOR UPDATE', [id]);
        if (!r.rows[0])
            throw errors_1.ApiError.notFound('Pedido no encontrado');
        if (!['PENDIENTE', 'VISTO', 'EN_PREPARACION'].includes(r.rows[0].status))
            throw errors_1.ApiError.conflict('El pedido ya fue tomado o resuelto.');
        if (status === 'RECHAZADO' && (!reason || reason.trim().length < 5))
            throw errors_1.ApiError.badRequest('Indicá el motivo del rechazo.');
        await c.query("UPDATE merchandise_requests SET status=$1,rejection_reason=$2,handled_by=$3,handled_at=CASE WHEN $1 IN ('ATENDIDO','RECHAZADO') THEN now() ELSE handled_at END,updated_at=now() WHERE id=$4", [status, status === 'RECHAZADO' ? reason.trim() : null, user.id, id]);
        await (0, audit_service_1.writeAudit)(c, { userId: user.id, action: 'MERCHANDISE_REQUEST_STATUS', entity: 'merchandise_request', entityId: id, details: { status, reason }, ip });
        return { ok: true, status };
    });
}
