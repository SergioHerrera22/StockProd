"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyStockArrival = notifyStockArrival;
exports.notifyStockArrivalForEntryId = notifyStockArrivalForEntryId;
const pool_1 = require("../db/pool");
const alerts_service_1 = require("./alerts.service");
const logger_1 = require("../lib/logger");
/** Deuda por ENTREGA/PRODUCTO (misma formula que listDeliveries), acotada a los productos de la entrada. */
function debtQuery() {
    return `
    SELECT oi.delivery_id, oi.product_id,
           GREATEST(oi.owed - COALESCE(wd.withdrawn, 0), 0) AS units
    FROM (
      SELECT di.delivery_id, di.product_id,
             GREATEST(di.quantity, COALESCE(di.requested_quantity, di.quantity))
               - COALESCE(di.quantity_delivered, 0) AS owed
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      WHERE d.status IN ('CONFIRMADO', 'PARCIAL') AND di.product_id = ANY($1::integer[])
    ) oi
    LEFT JOIN (
      SELECT pd.delivery_id, pdi.product_id, SUM(pdi.quantity_delivered) AS withdrawn
      FROM pending_deliveries pd
      JOIN pending_delivery_items pdi ON pdi.pending_delivery_id = pd.id
      WHERE pdi.quantity_delivered > 0 AND pd.status NOT IN ('CANCELADO')
      GROUP BY pd.delivery_id, pdi.product_id
    ) wd ON wd.delivery_id = oi.delivery_id AND wd.product_id = oi.product_id
  `;
}
async function notifyStockArrival(data) {
    try {
        const productIds = data.items.map((i) => i.product_id);
        if (productIds.length === 0)
            return;
        const debts = await (0, pool_1.query)(debtQuery(), [productIds]);
        if (debts.rows.length === 0)
            return;
        // Agregar por entrega
        const byDelivery = new Map();
        for (const r of debts.rows) {
            const units = Number(r.units);
            if (units <= 0)
                continue;
            const list = byDelivery.get(r.delivery_id) ?? [];
            list.push({ productId: r.product_id, units });
            byDelivery.set(r.delivery_id, list);
        }
        if (byDelivery.size === 0)
            return;
        // Productos deuda, que participan y cuantas unidades quedan debiendo
        const names = await (0, pool_1.query)(`SELECT id, name, code FROM products WHERE id = ANY($1::integer[])`, [productIds]);
        const namesById = new Map(names.rows.map((r) => [r.id, r]));
        const numbers = await (0, pool_1.query)(`SELECT id, number FROM deliveries WHERE id = ANY($1::integer[])`, [[...byDelivery.keys()]]);
        const numbersById = new Map(numbers.rows.map((r) => [r.id, r.number]));
        for (const [deliveryId, prodList] of byDelivery.entries()) {
            const dNumber = numbersById.get(deliveryId) ?? `#${deliveryId}`;
            const total = prodList.reduce((s, p) => s + p.units, 0);
            const detalle = prodList
                .map((p) => `${namesById.get(p.productId)?.name ?? `producto ${p.productId}`} +${p.units}`)
                .join(', ');
            // Rotar alertas previas no vistas de la misma entrega: llegar de nuevo
            // stock es un evento NUEVO; la alerta vieja quedaria bloqueando por el
            // mecanismo de dedupe (code+entity+location).
            await (0, pool_1.query)(`UPDATE alerts SET status = 'RESUELTA',
           resolution_notes = 'Reemplazada por nueva llegada de mercaderia',
           resolved_at = now()
         WHERE code = 'STOCK_ARRIVAL_FOR_DEBT' AND entity_type = 'DELIVERY' AND entity_id = $1
           AND status IN ('PENDIENTE', 'VISTA')`, [deliveryId]);
            // Cuenta cuantas ordenes de retiro ACTIVAS esperan stock de esa entrega
            const orders = await (0, pool_1.query)(`SELECT COALESCE(string_agg(pd.number, ', '), '') AS pd_ids
         FROM pending_deliveries pd
         WHERE pd.delivery_id = $1 AND pd.status IN ('PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL')`, [deliveryId]);
            const pdIds = (orders.rows[0]?.pd_ids ?? '').trim();
            const sugerencia = pdIds
                ? `Ya hay orden de retiro activa: ${pdIds}. Cuando llegue el stock de otras sucursales se retira por esa orden.`
                : 'No hay orden de retiro activa todavía: vas a Entregas y tocá "Re-derivar faltantes".';
            await (0, alerts_service_1.createAlert)({
                code: 'STOCK_ARRIVAL_FOR_DEBT',
                severity: 'INFO',
                entityType: 'DELIVERY',
                entityId: deliveryId,
                title: `Llegó stock para la deuda de la entrega ${dNumber}`,
                message: `La entrada ${data.entryNumber} en ${data.locationName} recargó ${total} unidades (${detalle}). ${sugerencia}`,
                data: {
                    entryId: data.entryId,
                    entryNumber: data.entryNumber,
                    locationId: data.locationId,
                    products: prodList.map((p) => ({ ...p, name: namesById.get(p.productId)?.name ?? null, code: namesById.get(p.productId)?.code ?? null })),
                    pendingOrders: pdIds || null,
                },
                targetRoles: ['ADMIN', 'ENCARGADO'],
                // La alerta la ve la sucursal A LA QUE SE LE DEBE (donde se entrega),
                // no la que acaba de recibir la entrada.
                targetLocationId: null,
            });
        }
    }
    catch (e) {
        logger_1.logger.error('notifyStockArrival: no se pudo crear la alerta de llegada', e instanceof Error ? e.message : String(e));
    }
}
/**
 * Versión autocontenida para llamar post-commit desde confirmar/aprobar
 * entrada: re-lee la entrada y sus items, y solo notifica si hubo productos
 * relevantes. Si la entrada esta ANULADA o no existe, no hace nada.
 */
async function notifyStockArrivalForEntryId(entryId) {
    try {
        const entry = await (0, pool_1.query)(`SELECT e.number, e.location_id, l.name AS location_name, e.status
       FROM stock_entries e JOIN locations l ON l.id = e.location_id
       WHERE e.id = $1`, [entryId]);
        if (!entry.rows[0])
            return;
        const e = entry.rows[0];
        if (e.status !== 'CONFIRMADO')
            return;
        const items = await (0, pool_1.query)(`SELECT product_id, quantity FROM stock_entry_items WHERE entry_id = $1`, [entryId]);
        await notifyStockArrival({
            entryId,
            entryNumber: e.number,
            locationId: e.location_id,
            locationName: e.location_name,
            items: items.rows,
        });
    }
    catch (err) {
        logger_1.logger.error('notifyStockArrivalForEntryId', err instanceof Error ? err.message : String(err));
    }
}
