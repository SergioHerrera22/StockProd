import { PoolClient } from 'pg';
import { ApiError } from '../lib/errors';

export interface ReserveStockInput {
  referenceType: 'DELIVERY' | 'TRANSFER' | 'ENTRY' | 'COUNT' | 'PENDING_DELIVERY' | 'MANUAL';
  referenceId: number;
  productId: number;
  sourceLocationId: number;
  quantity: number;
  reservedBy: number;
  expiresAt?: Date | null;
}

export interface ReserveStockResult {
  reservationId: number;
  reservationNumber: string;
  success: boolean;
  message: string;
}

export interface ConsumeReservationInput {
  reservationId: number;
  quantity: number;
  consumedBy: number;
  movementType: 'ENTRADA' | 'SALIDA' | 'AJUSTE_POS' | 'AJUSTE_NEG' | 'TRANS_SALIDA' | 'TRANS_ENTRADA';
  reason?: string;
}

export interface ConsumeReservationResult {
  success: boolean;
  message: string;
  movementId: number | null;
}

/**
 * Reservar stock (llama a función PG reserve_stock)
 */
export async function reserveStock(
  client: PoolClient,
  input: ReserveStockInput
): Promise<ReserveStockResult> {
  const expiresAt = input.expiresAt ? input.expiresAt.toISOString() : null;
  const r = await client.query<any>(
    `SELECT * FROM reserve_stock($1, $2, $3, $4, $5, $6, $7)`,
    [input.referenceType, input.referenceId, input.productId, input.sourceLocationId, input.quantity, input.reservedBy, expiresAt]
  );
  const result = r.rows[0];
  if (!result.success) throw ApiError.conflict(result.message);
  return {
    reservationId: result.reservation_id,
    reservationNumber: result.reservation_number,
    success: result.success,
    message: result.message,
  };
}

/**
 * Reservar stock en batch (múltiples items)
 */
export async function reserveStockBatch(
  client: PoolClient,
  inputs: ReserveStockInput[]
): Promise<ReserveStockResult[]> {
  const results: ReserveStockResult[] = [];
  for (const input of inputs) {
    results.push(await reserveStock(client, input));
  }
  return results;
}

/**
 * Consumir reserva (llama a función PG consume_reservation)
 */
export async function consumeReservation(
  client: PoolClient,
  input: ConsumeReservationInput
): Promise<ConsumeReservationResult> {
  const r = await client.query<ConsumeReservationResult>(
    `SELECT * FROM consume_reservation($1, $2, $3, $4, $5)`,
    [input.reservationId, input.quantity, input.consumedBy, input.movementType, input.reason ?? null]
  );
  return r.rows[0];
}

/**
 * Liberar reserva individual
 */
export async function releaseReservation(
  client: PoolClient,
  reservationId: number,
  releasedBy: number,
  reason: string
): Promise<{ success: boolean; message: string }> {
  const r = await client.query<{ success: boolean; message: string }>(
    `SELECT * FROM release_reservation($1, $2, $3)`,
    [reservationId, releasedBy, reason]
  );
  return r.rows[0];
}

/**
 * Liberar TODAS las reservas de una referencia (anular delivery/transfer/etc)
 */
export async function releaseAllReservationsForReference(
  client: PoolClient,
  referenceType: string,
  referenceId: number,
  releasedBy: number,
  reason: string
): Promise<{ releasedCount: number; message: string }> {
  const r = await client.query<{ released_count: number; message: string }>(
    `SELECT * FROM release_all_reservations_for_reference($1, $2, $3, $4)`,
    [referenceType, referenceId, releasedBy, reason]
  );
  return { releasedCount: r.rows[0].released_count, message: r.rows[0].message };
}

/**
 * Obtener stock disponible (llama a función PG get_available_stock)
 */
export async function getAvailableStock(
  client: PoolClient,
  productId?: number,
  locationId?: number
) {
  const r = await client.query(
    `SELECT * FROM get_available_stock($1, $2)`,
    [productId ?? null, locationId ?? null]
  );
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
export async function checkMultiLocationAvailability(
  client: PoolClient,
  productIds: number[],
  saleLocationId: number,
  qtyRequested: number[]
) {
  const r = await client.query(
    `SELECT * FROM check_multi_location_availability($1, $2, $3)`,
    [productIds, saleLocationId, qtyRequested]
  );
  return r.rows;
}

/**
 * Obtener reservas activas para una referencia
 */
export async function getActiveReservationsForReference(
  client: PoolClient,
  referenceType: string,
  referenceId: number
) {
  const r = await client.query(
    `SELECT * FROM stock_reservations 
     WHERE reference_type = $1 AND reference_id = $2 AND status IN ('ACTIVA', 'PARCIAL')
     ORDER BY created_at`,
    [referenceType, referenceId]
  );
  return r.rows;
}
