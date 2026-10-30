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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/**
 * Idempotencia (punto 9 del audit): en las operaciones críticas el frontend
 * envía un header `Idempotency-Key`. La clave se reutiliza si la petición
 * anterior FALLÓ EN RED (fetch rechazado) o devolvió error de conexión, de
 * modo que el reintento del usuario devuelva la respuesta real guardada en el
 * servidor en vez de ejecutar la operación dos veces.
 * Clave estable por operación <acción>-<id>; para creaciones, uuid por
 * llamada (protege del doble click; contra red caída nada razonable puede
 * reusar la clave porque el body se acaba de crear).
 */
const IDEMPOTENT_PATTERNS: RegExp[] = [
  /^\/deliveries$/,
  /^\/deliveries\/\d+\/(confirm|void|rederive)$/,
  /^\/deliveries\/\d+\/confirm-with-alternatives$/,
  /^\/entries$/,
  /^\/entries\/\d+\/(confirm|void)$/,
  /^\/transfers$/,
  /^\/transfers\/\d+\/(receive|void)$/,
  /^\/pending-deliveries$/,
  /^\/pending-deliveries\/confirm-pickup$/,
  /^\/pending-deliveries\/\d+\/(cancel|extend)$/,
  /^\/tracking\/trips$/,
  /^\/tracking\/trips\/\d+\/(depart|complete|cancel)$/,
  /^\/tracking\/trips\/\d+\/stops\/\d+\/delivered$/,
];

/** Claves en "vuelo": si la red se cae, el reintento reusa la misma clave. */
const inFlightKeys = new Map<string, string>();

/**
 * Coalesce identical GET requests while they are in flight.
 * This avoids duplicate network/DB work when multiple components mount or
 * refresh the same resource at the same time. Responses are not cached:
 * stock and operational reads always reach the server on the next call.
 */
const inFlightGetRequests = new Map<string, Promise<unknown>>();

function idempotencyKeyFor(path: string): string | null {
  if (IDEMPOTENT_PATTERNS.some((re) => re.test(path))) {
    let key = inFlightKeys.get(path);
    if (!key) {
      key = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 32)
        : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
      inFlightKeys.set(path, key);
    }
    return key;
  }
  return null;
}

function clearInFlightKey(path: string, key: string) {
  if (inFlightKeys.get(path) === key) inFlightKeys.delete(path);
}

async function doFetch(path: string, options: Options, t: string | null, extraHeaders: Record<string, string>) {
  const res = await fetch(BASE + path, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...extraHeaders,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { res, sentAuth: Boolean(t) };
}

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  // El 401 de las credenciales inválidas del propio login NO es "sesión
  // vencida": tratarlo igual recargaba la página de login sobre sí misma,
  // borraba lo tipeado y desconectaba otras pestañas con sesión válida.
  const isAuthCall = path.startsWith('/auth/login');

  // GET idénticos simultáneos comparten una única petición. No se cachea
  // el resultado: la siguiente lectura vuelve a consultar el estado real.
  if ((options.method ?? 'GET') === 'GET') {
    const requestToken = currentToken();
    const requestKey = `${requestToken ?? 'anonymous'}:${path}`;
    const existing = inFlightGetRequests.get(requestKey);
    if (existing) return existing as Promise<T>;

    const request = rawApi<T>(path, options, isAuthCall, null).finally(() => {
      if (inFlightGetRequests.get(requestKey) === request) {
        inFlightGetRequests.delete(requestKey);
      }
    });
    inFlightGetRequests.set(requestKey, request);
    return request;
  }

  // Clave de idempotencia solo para POST críticos
  const idempKey = options.method === 'POST' ? idempotencyKeyFor(path.replace(/\?.*$/, '')) : null;

  try {
    return await rawApi<T>(path, options, isAuthCall, idempKey);
  } catch (e) {
    // Si falló en RED (no una ApiError del servidor), la clave sigue viva para
    // que el reintento devuelva la respuesta real en lugar de re-ejecutar.
    const networkFailure = !(e instanceof ApiError);
    if (idempKey && networkFailure) {
      inFlightKeys.set(path.replace(/\?.*$/, ''), idempKey);
    } else if (idempKey) {
      clearInFlightKey(path.replace(/\?.*$/, ''), idempKey);
    }
    throw e;
  }
  // nota: clearInFlightKey también se ocupa acá para peticiones exitosas
  // (rawApi nunca lanza ApiError con status 2xx).
}

async function rawApi<T>(
  path: string,
  options: Options,
  isAuthCall: boolean,
  idempKey: string | null,
): Promise<T> {
  const { res, sentAuth } = await doFetch(path, options, currentToken(), idempKey ? { 'Idempotency-Key': idempKey } : {});
  if (res.ok && idempKey) clearInFlightKey(path.replace(/\?.*$/, ''), idempKey);

  // Reintento único: si la llamada salió sin token pero en localStorage hay uno
  // válido, se reintenta antes de dar la sesión por cerrada.
  if (res.status === 401 && !sentAuth && !isAuthCall) {
    const stored = readStoredToken();
    if (stored) {
      setToken(stored);
      const retry = await doFetch(path, options, stored, idempKey ? { 'Idempotency-Key': idempKey } : {});
      return finishResponse<T>(path, retry.res, isAuthCall, idempKey);
    }
  }

  return finishResponse<T>(path, res, isAuthCall, idempKey);
}

async function finishResponse<T>(
  path: string,
  res: Response,
  isAuthCall: boolean,
  idempKey: string | null,
): Promise<T> {

  let json: { error?: string; details?: unknown } & Record<string, unknown> = {} as never;
  try {
    json = await res.json();
  } catch {
    /* respuesta sin cuerpo */
  }

  if (res.status === 401 && !isAuthCall) {
    setToken(null);
    // Guarda el motivo (inactividad, expulsada por admin, vencida…) para mostrarlo en el login
    try { sessionStorage.setItem('robles_logout_reason', (json.error as string) ?? 'Sesión cerrada'); } catch { /* noop */ }
    onUnauthorized();
    throw new ApiError(401, (json.error as string) ?? 'Sesión vencida. Volvé a ingresar.');
  }

  if (!res.ok) {
    const msg = (json.error as string) ?? `Error ${res.status}`;
    // Los 5xx no dicen nada del problema real: guiá al usuario sobre que hacer.
    const hint = res.status >= 500 ? ' (problema del servidor; reintentá en unos segundos)' : '';
    throw new ApiError(res.status, msg + hint, json.details);
  }
  return json as T;
}

export function qs(params: Record<string, string | number | undefined | null>): string {  const usp = new URLSearchParams();
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
  ScanDeliveryResult,
  ConfirmPickupInput,
  MultiLocationAvailability,
  StockAvailabilityRow,
  UserAlternativeChoice,
  DeliveryPendingOrder,
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

/** Escanea el EAN-13 de la ORDEN DE ENTREGA y devuelve la entrega con toda la
 *  mercadería solicitada (cantidad, facturado y stock disponible). */
export async function scanDelivery(barcode: string): Promise<ScanDeliveryResult> {
  const res = await api<{ delivery: ScanDeliveryResult }>(
    `/deliveries/scan/${encodeURIComponent(barcode)}`
  );
  return res.delivery;
}

/** Órdenes pendientes (retiros) derivadas de una entrega, con ítems y barcode.
 *  Pueden ser varias: una por sucursal de retiro. */
export async function getDeliveryPendingDeliveries(
  deliveryId: string | number
): Promise<DeliveryPendingOrder[]> {
  try {
    const res = await api<{ pendingDeliveries: DeliveryPendingOrder[] }>(
      `/deliveries/${deliveryId}/pending-delivery`
    );
    return res.pendingDeliveries ?? [];
  } catch {
    return [];
  }
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
): Promise<DeliveryConfirmResponse> {
  return api(`/deliveries/${deliveryId}/confirm-with-alternatives`, {
    method: 'POST',
    body: data,
  });
}

/** Resultado de confirmar una entrega (directo o con alternativas) */
export interface DeliveryConfirmResponse {
  success: boolean;
  deliveryId: number;
  deliveryNumber: string;
  fullyDelivered: { productId: number; quantity: number }[];
  shortfalls: unknown[];
  /** Una orden de retiro por sucursal de retiro */
  pendingDeliveries: {
    id: number;
    number: string;
    barcode: string;
    pickupLocationId: number;
    pickupLocationName: string;
  }[];
  pendingDelivery?: {
    id: number;
    number: string;
    barcode: string;
    pickupLocationId: number;
    pickupLocationName: string;
  };
  /** Faltantes que quedaron sin stock en ninguna sucursal para derivar */
  unresolvedShortfalls?: { productId: number; productName: string; quantity: number }[];
}

/** Registra quién recibió físicamente un reparto a domicilio. No mueve stock. */
export async function markDeliveryDelivered(
  deliveryId: number,
  input: { receivedBy: string; notes?: string | null }
): Promise<{ ok: boolean; deliveryId: number; deliveredAt: string }> {
  return api(`/deliveries/${deliveryId}/mark-delivered`, { method: 'POST', body: input });
}

/** Re-deriva faltantes pendientes de una entrega ya confirmada */
export async function rederiveDeliveryShortfalls(
  deliveryId: number
): Promise<{ ok: boolean; created: DeliveryConfirmResponse['pendingDeliveries']; message?: string }> {
  return api(`/deliveries/${deliveryId}/rederive`, { method: 'POST' });
}

/** Confirma (acepta) una entrega en borrador. Recordar que el resultado puede
 *  traer shortfalls/pendientes si faltó stock (flujo de entrega parcial).
 *  `pick` (mejora 10): checklist de picking — {productId, quantity} recibido
 *  por item. Lo que no entra queda como PARCIAL/deuda con re-derivación. */
export async function confirmDelivery(
  deliveryId: number,
  pick?: Array<{ productId: number; quantity: number }>
): Promise<DeliveryConfirmResponse> {
  return api(`/deliveries/${deliveryId}/confirm`, { method: 'POST', ...(pick ? { body: { pick } } : {}) });
}

/** Descarga un CSV protegido (lleva Authorization). csvPath SIN la base B, ej:
 *  '/movements/export.csv?q=...' */
export async function downloadCsv(csvPath: string, filename: string): Promise<void> {
  const res = await fetch(BASE + csvPath, {
    headers: { Authorization: `Bearer ${currentToken()}` },
  });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const j = await res.json();
      msg = (j.error as string) ?? msg;
    } catch { /* respuesta no json */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== TRANSPORTE / REPARTO CON GPS =====

import type {
  Trip,
  TripStop,
  TripStatus,
  AvailableDocs,
} from '../types';

export interface TripListResponse { trips: Trip[]; total: number; page: number; pageSize: number }

export async function listTrips(filters: {
  status?: string; originLocationId?: number; q?: string; page?: number; pageSize?: number;
} = {}): Promise<TripListResponse> {
  return api(`/tracking/trips${qs(filters as Record<string, string | number | undefined>)}`);
}

export async function getTrip(id: number): Promise<Trip> {
  const r = await api<{ trip: Trip }>(`/tracking/trips/${id}`);
  return r.trip;
}

export async function getTripTrack(id: number, limit = 500): Promise<{ points: { lat: number; lng: number; recorded_at: string }[] }> {
  return api(`/tracking/trips/${id}/track${qs({ limit })}`);
}

export async function createTrip(input: {
  originLocationId: number; driverName: string; driverPhone?: string | null;
  vehicle?: string | null; notes?: string | null;
  stops: { docType: string; docId: number; address?: string | null; customerName?: string | null }[];
}): Promise<Trip> {
  const r = await api<{ trip: Trip }>('/tracking/trips', { method: 'POST', body: input });
  return r.trip;
}

export async function updateTrip(id: number, input: {
  driverName?: string; driverPhone?: string | null; vehicle?: string | null; notes?: string | null;
}): Promise<Trip> {
  const r = await api<{ trip: Trip }>(`/tracking/trips/${id}`, { method: 'PUT', body: input });
  return r.trip;
}

export async function addTripStop(id: number, input: {
  docType: string; docId: number; address?: string | null; customerName?: string | null;
}): Promise<TripStop[]> {
  const r = await api<{ stops: TripStop[] }>(`/tracking/trips/${id}/stops`, { method: 'POST', body: input });
  return r.stops;
}

export async function removeTripStop(id: number, stopId: number): Promise<TripStop[]> {
  const r = await api<{ stops: TripStop[] }>(`/tracking/trips/${id}/stops/${stopId}`, { method: 'DELETE' });
  return r.stops;
}

export async function departTrip(id: number): Promise<Trip> {
  const r = await api<{ trip: Trip }>(`/tracking/trips/${id}/depart`, { method: 'POST' });
  return r.trip;
}

export async function completeTrip(id: number): Promise<Trip> {
  const r = await api<{ trip: Trip }>(`/tracking/trips/${id}/complete`, { method: 'POST' });
  return r.trip;
}

export async function cancelTrip(id: number, reason: string): Promise<Trip> {
  const r = await api<{ trip: Trip }>(`/tracking/trips/${id}/cancel`, { method: 'POST', body: { reason } });
  return r.trip;
}

export async function markStopDelivered(id: number, stopId: number, notes?: string): Promise<{ ok: boolean; allDelivered: boolean; trip: Trip }> {
  return api(`/tracking/trips/${id}/stops/${stopId}/delivered`, { method: 'POST', body: { notes } });
}

/** Envía la posición del dispositivo (throttle server-side ~8s) */
export async function postTripPosition(id: number, pos: {
  lat: number; lng: number; accuracy?: number | null; speed?: number | null; heading?: number | null;
}): Promise<{ skipped: boolean }> {
  return api(`/tracking/trips/${id}/positions`, { method: 'POST', body: pos });
}

/** Viajes EN_RUTA con última posición y paradas: feed del mapa en vivo */
export async function getLiveTracking(): Promise<LiveTracking> {
  return api('/tracking/live');
}

export interface DriverLive {
  user_id: number;
  full_name: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  recorded_at: string;
  share_started_at: string;
}

export interface LiveTracking {
  trips: Trip[];
  /** Choferes con compartido GPS activo (posición continua por usuario) */
  drivers?: DriverLive[];
}

export interface GpsShareInfo {
  active: boolean;
  started_at: string | null;
  restricted: boolean;
  within: boolean;
  schedule: unknown;
}

export interface GpsSchedule {
  enabled: boolean;
  /** 0=domingo .. 6=sábado */
  days: number[];
  start: string;
  end: string;
}

/* ===== Compartido GPS continuo por usuario (hasta cerrar sesión) ===== */

export async function getGpsShareStatus(): Promise<GpsShareInfo> {
  return api('/tracking/share');
}

export async function startGpsShare(): Promise<GpsShareInfo> {
  return api('/tracking/share/start', { method: 'POST' });
}

export async function stopGpsShare(): Promise<void> {
  await api('/tracking/share/stop', { method: 'POST' });
}

/** Posición del usuario compartiendo (se espeja a su viaje EN_RUTA solo) */
export async function postSharedPosition(pos: {
  lat: number; lng: number; accuracy?: number | null; speed?: number | null; heading?: number | null;
}): Promise<{ skipped: boolean; reason?: string }> {
  return api('/tracking/positions', { method: 'POST', body: pos });
}

/** Horario laboral en el que se comparte la ubicación (config del admin) */
export async function getGpsSchedule(): Promise<{ schedule: GpsSchedule | null; restricted: boolean; within: boolean }> {
  return api('/tracking/schedule');
}

export async function saveGpsSchedule(schedule: GpsSchedule): Promise<{ schedule: GpsSchedule | null; restricted: boolean; within: boolean }> {
  return api('/tracking/schedule', { method: 'PUT', body: schedule });
}

/** Documentos elegibles para paradas de un viaje desde `originLocationId` */
export async function getAvailableDocs(originLocationId: number): Promise<AvailableDocs> {
  return api(`/tracking/available${qs({ originLocationId })}`);
}


/* ============================ CHOFERES / REPARTO DIRECTO ============================ */
export async function getDrivers(){const r=await api<{drivers:any[]}>('/drivers/drivers');return r.drivers;} 
export async function getMyDriverAssignments(){const r=await api<{assignments:any[]}>('/drivers/my-assignments');return r.assignments;} 
export async function getMyDriverHistory(){const r=await api<{history:any[]}>('/drivers/my-history');return r.history;} 
export async function assignDriverTo(type:string,id:number,driverUserId:number){return api('/drivers/assign',{method:'POST',body:{type,id,driverUserId}});} 
export async function startDriverDelivery(type:string,id:number){return api('/drivers/start',{method:'POST',body:{type,id}});} 
export async function completeDriverDelivery(type:string,id:number,notes?:string){return api('/drivers/complete',{method:'POST',body:{type,id,notes}});} 
export async function getDeliveryDelays(){return api('/drivers/delays');} 
export async function geocodeAddressApi(address:string){return api('/drivers/geocode',{method:'POST',body:{address}});}
