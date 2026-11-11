"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reserveStock = reserveStock;
exports.reserveStockBatch = reserveStockBatch;
exports.consumeReservation = consumeReservation;
exports.releaseReservation = releaseReservation;
exports.releaseAllReservationsForReference = releaseAllReservationsForReference;
exports.getAvailableStock = getAvailableStock;
exports.checkMultiLocationAvailability = checkMultiLocationAvailability;
exports.getActiveReservationsForReference = getActiveReservationsForReference;
const errors_1 = require("../lib/errors");
/**
 * Reservar stock (llama a función PG reserve_stock)
 */
async function reserveStock(client, input) {
    const expiresAt = input.expiresAt ? input.expiresAt.toISOString() : null;
    const r = await client.query(`SELECT * FROM reserve_stock($1, $2, $3, $4, $5, $6, $7)`, [input.referenceType, input.referenceId, input.productId, input.sourceLocationId, input.quantity, input.reservedBy, expiresAt]);
    const result = r.rows[0];
    if (!result.success)
        throw errors_1.ApiError.conflict(result.message);
    return {
        reservationId: result.reservation_id,
        reservationNumber: result.reservation_number,
        success: result.success,
        message: result.message,
    };
}
/**
 * Reservar stock en batch (múltiples items).
 * LOCKEO DETERMINISTA: se lockean los saldos en orden (product, ubicacion)
 * aunque los resultados se devuelven en el orden original de los inputs.
 * Sin esto, dos operaciones concurrentes con items en orden opuesto
 * (A→B vs B→A) podian bloquearse mutuamente (deadlock 40P01) en operación
 * de rutina.
 */
async function reserveStockBatch(client, inputs) {
    const order = inputs
        .map((input, idx) => ({ input, idx }))
        .sort((a, b) => a.input.productId - b.input.productId || a.input.sourceLocationId - b.input.sourceLocationId);
    const results = new Array(inputs.length);
    for (const { input, idx } of order) {
        results[idx] = await reserveStock(client, input);
    }
    return results;
}
/**
 * Consumir reserva (llama a función PG consume_reservation)
 */
async function consumeReservation(client, input) {
    const r = await client.query(`SELECT * FROM consume_reservation($1, $2, $3, $4, $5)`, [input.reservationId, input.quantity, input.consumedBy, input.movementType, input.reason ?? null]);
    return r.rows[0];
}
/**
 * Liberar reserva individual
 */
async function releaseReservation(client, reservationId, releasedBy, reason) {
    const r = await client.query(`SELECT * FROM release_reservation($1, $2, $3)`, [reservationId, releasedBy, reason]);
    return r.rows[0];
}
/**
 * Liberar TODAS las reservas de una referencia (anular delivery/transfer/etc)
 */
async function releaseAllReservationsForReference(client, referenceType, referenceId, releasedBy, reason) {
    const r = await client.query(`SELECT * FROM release_all_reservations_for_reference($1, $2, $3, $4)`, [referenceType, referenceId, releasedBy, reason]);
    return { releasedCount: r.rows[0].released_count, message: r.rows[0].message };
}
/**
 * Obtener stock disponible (llama a función PG get_available_stock)
 */
async function getAvailableStock(client, productId, locationId) {
    const r = await client.query(`SELECT * FROM get_available_stock($1, $2)`, [productId ?? null, locationId ?? null]);
    return r.rows.map(row => ({
        productId: row.product_id,
        productCode: row.product_code,
        productName: row.product_name,
        locationId: row.location_id,
        locationCode: row.location_code,
        locationName: row.location_name,
        totalQuantity: Number(row.total_quantity),
        reservedQuantity: Number(row.reserved_quantity),
        availableQuantity: Number(row.available_quantity),
    }));
}
/**
 * Verificar disponibilidad multi-sucursal (para entregas con derivación)
 */
async function checkMultiLocationAvailability(client, productIds, saleLocationId, qtyRequested) {
    const r = await client.query(`SELECT * FROM check_multi_location_availability($1, $2, $3)`, [productIds, saleLocationId, qtyRequested]);
    return r.rows;
}
/**
 * Obtener reservas activas para una referencia
 */
async function getActiveReservationsForReference(client, referenceType, referenceId) {
    const r = await client.query(`SELECT * FROM stock_reservations 
     WHERE reference_type = $1 AND reference_id = $2 AND status IN ('ACTIVA', 'PARCIAL')
     ORDER BY created_at`, [referenceType, referenceId]);
    return r.rows;
}
