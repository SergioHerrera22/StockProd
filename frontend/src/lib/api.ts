/** Cliente HTTP del frontend. Adjunta el token, normaliza errores y
 *  reacciona a sesiones vencidas. */

import type {
  DeliveryAvailabilityResult,
} from '../types';

const BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL ?? '/api';

let token: string | null = localStorage.getItem('robles_token');

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('robles_token', t);
  else localStorage.removeItem('robles_token');
}

export function getToken() {
  return token;
}

function readStoredToken(): string | null {
  try {
    return localStorage.getItem('robles_token');
  } catch {
    return null;
  }
}

/**
 * Token vigente para cada petición.
 * El valor en memoria puede quedar desincronizado de localStorage (otra pestaña,
 * cierre de sesión en background, recarga a medias). Si eso pasaba, la petición
 * salía SIN el encabezado Authorization y el backend respondía
 * "Sesión no iniciada" aunque el usuario estuviera logueado.
 */
function currentToken(): string | null {
  const stored = readStoredToken();
  if (stored !== token) token = stored;
  return token;
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

async function doFetch(path: string, options: Options, t: string | null) {
  const res = await fetch(BASE + path, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { res, sentAuth: Boolean(t) };
}

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  let { res, sentAuth } = await doFetch(path, options, currentToken());

  // Reintento único: si la llamada salió sin token pero en localStorage hay uno
  // válido, se reintenta antes de dar la sesión por cerrada.
  if (res.status === 401 && !sentAuth) {
    const stored = readStoredToken();
    if (stored) {
      setToken(stored);
      ({ res, sentAuth } = await doFetch(path, options, stored));
    }
  }

  let json: { error?: string; details?: unknown } & Record<string, unknown> = {} as never;
  try {
    json = await res.json();
  } catch {
    /* respuesta sin cuerpo */
  }

  if (res.status === 401) {
    setToken(null);
    // Guarda el motivo (inactividad, expulsada por admin, vencida…) para mostrarlo en el login
    try { sessionStorage.setItem('robles_logout_reason', (json.error as string) ?? 'Sesión cerrada'); } catch { /* noop */ }
    onUnauthorized();
    throw new ApiError(401, (json.error as string) ?? 'Sesión vencida. Volvé a ingresar.');
  }

  if (!res.ok) {
    throw new ApiError(res.status, (json.error as string) ?? `Error ${res.status}`, json.details);
  }
  return json as T;
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

// ===== API DE ENTREGAS PENDIENTES / RETIROS MULTI-SUCURSAL =====

import type {
  PendingDeliveryListResponse,
  PendingDelivery,
  PendingDeliveryStatus,
  ScanPendingDeliveryResult,
  ConfirmPickupInput,
  MultiLocationAvailability,
  StockAvailabilityRow,
  UserAlternativeChoice,
} from '../types';

/** Lista órdenes pendientes (retiros) con filtros y paginación */
export async function listPendingDeliveries(filters: {
  pickupLocationId?: number;
  saleLocationId?: number;
  status?: PendingDeliveryStatus;
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<PendingDeliveryListResponse> {
  const params: Record<string, string | number> = {};
  if (filters.pickupLocationId) params.pickupLocationId = filters.pickupLocationId;
  if (filters.saleLocationId) params.saleLocationId = filters.saleLocationId;
  if (filters.status) params.status = filters.status;
  if (filters.q) params.q = filters.q;
  if (filters.page) params.page = filters.page;
  if (filters.pageSize) params.pageSize = filters.pageSize;
  return api<PendingDeliveryListResponse>(`/pending-deliveries${qs(params)}`);
}

/** Detalle completo de una orden pendiente */
export async function getPendingDelivery(id: number): Promise<PendingDelivery> {
  return api<PendingDelivery>(`/pending-deliveries/${id}`);
}

/** Escanea el código de barras (EAN-13) y devuelve la orden completa */
export async function scanPendingDelivery(barcode: string): Promise<ScanPendingDeliveryResult> {
  return api<ScanPendingDeliveryResult>(
    `/pending-deliveries/scan/${encodeURIComponent(barcode)}`
  );
}

/** Confirma el retiro en la sucursal destino (descuenta stock real) */
export async function confirmPendingDeliveryPickup(
  input: ConfirmPickupInput
): Promise<{ ok: boolean; status: string; pendingDeliveryId: number }> {
  return api('/pending-deliveries/confirm-pickup', { method: 'POST', body: input });
}

/** Cancela una orden pendiente y libera las reservas de stock */
export async function cancelPendingDeliveryOrder(
  id: number,
  reason: string
): Promise<{ ok: boolean }> {
  return api(`/pending-deliveries/${id}/cancel`, { method: 'POST', body: { reason } });
}

/** Disponibilidad multi-sucursal para productos (antes de derivar) */
export async function checkMultiLocationAvailability(
  productIds: number[],
  saleLocationId: number,
  quantities: number[]
): Promise<{ availability: MultiLocationAvailability[] }> {
  const params: Record<string, string | number> = {
    productIds: productIds.join(','),
    saleLocationId,
    qty: quantities.join(','),
  };
  return api(`/pending-deliveries/availability${qs(params)}`);
}

/** Stock disponible real (total - reservado) por producto/ubicación */
export async function getStockAvailable(
  productId?: number,
  locationId?: number
): Promise<{ stock: StockAvailabilityRow[] }> {
  const params: Record<string, string | number> = {};
  if (productId) params.productId = productId;
  if (locationId) params.locationId = locationId;
  return api(`/pending-deliveries/stock-available${qs(params)}`);
}

/** Verifica disponibilidad de una entrega en borrador (faltantes + alternativas) */
export async function checkDeliveryAvailability(deliveryId: number): Promise<DeliveryAvailabilityResult> {
  return api<DeliveryAvailabilityResult>(`/deliveries/${deliveryId}/check-availability`);
}

/** Confirma la entrega eligiendo sucursales alternativas para los faltantes */
export async function confirmDeliveryWithAlternatives(
  data: { choices: UserAlternativeChoice[] },
  deliveryId: number
): Promise<{
  success: boolean;
  deliveryId: number;
  deliveryNumber: string;
  fullyDelivered: { productId: number; quantity: number }[];
  shortfalls: unknown[];
  pendingDelivery?: {
    id: number;
    number: string;
    barcode: string;
    pickupLocationId: number;
    pickupLocationName: string;
  };
}> {
  return api(`/deliveries/${deliveryId}/confirm-with-alternatives`, {
    method: 'POST',
    body: data,
  });
}
