import { PoolClient } from 'pg';
import { ApiError } from '../lib/errors';

export type MovementType = 'ENTRADA' | 'SALIDA' | 'AJUSTE_POS' | 'AJUSTE_NEG' | 'TRANS_SALIDA' | 'TRANS_ENTRADA';
export type RefType = 'DELIVERY' | 'ENTRY' | 'TRANSFER' | 'COUNT' | 'MANUAL';

export interface StockChangeParams {
  productId: number;
  locationId: number;
  /** Variacion con signo: + entra, - sale. */
  delta: number;
  type: MovementType;
  referenceType: RefType;
  referenceId: number;
  referenceNumber?: string;
  userId: number;
  reason?: string;
  notes?: string;
}

export interface StockChangeResult {
  balanceBefore: number;
  balanceAfter: number;
}

/**
 * NUCLEO DEL SISTEMA.
 * Aplica una variacion de stock para (producto, ubicacion) dentro de la transaccion
 * del cliente recibido. Bloquea la fila del saldo (SELECT ... FOR UPDATE), inserta
 * el saldo si no existe, valida que no quede negativo y registra el movimiento
 * con saldo anterior y posterior.
 *
 * DEBE llamarse siempre dentro de withTx(): si algo falla, toda la operacion
 * se revierte y no quedan descuentos parciales.
 */
export async function applyStockChange(client: PoolClient, p: StockChangeParams): Promise<StockChangeResult> {
  if (!Number.isFinite(p.delta) || p.delta === 0) {
    throw ApiError.badRequest('La variacion de stock debe ser distinta de cero');
  }

  // Asegura que exista la fila de saldo y la bloquea para esta transaccion.
  await client.query(
    `INSERT INTO stock_balances (product_id, location_id, quantity)
     VALUES ($1, $2, 0)
     ON CONFLICT (product_id, location_id) DO NOTHING`,
    [p.productId, p.locationId]
  );

  const locked = await client.query<{ quantity: string }>(
    `SELECT quantity FROM stock_balances
     WHERE product_id = $1 AND location_id = $2
     FOR UPDATE`,
    [p.productId, p.locationId]
  );

  const before = Number(locked.rows[0].quantity);
  const after = Math.round((before + p.delta) * 1000) / 1000;

  if (after < 0) {
    throw ApiError.conflict(
      `Stock insuficiente: disponible ${before}, requerido ${Math.abs(p.delta)}`,
      { productId: p.productId, locationId: p.locationId, disponible: before, requerido: Math.abs(p.delta) }
    );
  }

  await client.query(
    `UPDATE stock_balances SET quantity = $1, updated_at = now()
     WHERE product_id = $2 AND location_id = $3`,
    [after, p.productId, p.locationId]
  );

  const qty = Math.abs(p.delta);
  await client.query(
    `INSERT INTO stock_movements
       (product_id, location_id, type, quantity, balance_before, balance_after,
        reference_type, reference_id, reference_number, user_id, reason, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      p.productId, p.locationId, p.type, qty, before, after,
      p.referenceType, p.referenceId, p.referenceNumber ?? null,
      p.userId, p.reason ?? null, p.notes ?? null,
    ]
  );

  return { balanceBefore: before, balanceAfter: after };
}
