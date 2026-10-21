import { ApiError } from '../lib/errors';
import type { AuthUser } from '../middleware/auth';

/**
 * Control de acceso por ubicación.
 * Si el usuario tiene "restringir a su ubicación" activado, solo puede operar
 * (entregas, entradas, transferencias, inventarios) en su ubicación habitual.
 * La consulta (lectura de stock, productos, movimientos) sigue siendo global.
 */
export function assertLocationAccess(user: AuthUser, locationId: number): void {
  if (user.role === 'ADMIN' || !user.restrictToLocation) return;

  if (!user.locationId) {
    throw ApiError.forbidden(
      'Tu usuario está restringido a una ubicación pero no tiene ninguna asignada. Avisá al administrador.'
    );
  }
  if (Number(locationId) !== Number(user.locationId)) {
    throw ApiError.forbidden(
      `Tu usuario solo puede operar en su ubicación habitual. Esta operación corresponde a otra ubicación.`
    );
  }
}

/** Transferencias: la operación debe involucrar la ubicación del usuario (origen o destino). */
export function assertTransferAccess(user: AuthUser, originLocationId: number, destinationLocationId: number): void {
  if (user.role === 'ADMIN' || !user.restrictToLocation) return;

  if (!user.locationId) {
    throw ApiError.forbidden(
      'Tu usuario está restringido a una ubicación pero no tiene ninguna asignada. Avisá al administrador.'
    );
  }
  const loc = Number(user.locationId);
  if (Number(originLocationId) !== loc && Number(destinationLocationId) !== loc) {
    throw ApiError.forbidden('Solo podés operar transferencias que involucren tu ubicación.');
  }
}
