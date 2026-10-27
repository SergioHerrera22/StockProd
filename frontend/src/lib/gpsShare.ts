/**
 * MOTOR GPS de compartido continuo (nivel usuario, hasta cerrar sesión).
 *
 * Es un singleton de vanilla TS (no React): sobrevive a cambios de página.
 * El chofer acepta compartir UNA VEZ y:
 *  - llega la posición cada ~8s (throttle client 8s + server 8s),
 *  - SOLO se envian fixes con precisión <= MAX_ACCURACY_M (evita el típico
 *    error de "5-6 cuadras" mientras el GPS todavía no convergió),
 *  - si la página se recarga, se reanuda solo (localStorage),
 *  - se corta al: apretar Detener, cerrar sesión, o que el servidor expire
 *    el token; fuera del horario laboral configurado queda en PAUSA y retoma
 *    solo cuando abre la ventada de nuevo.
 *
 * Requiere https (o localhost): el API de geolocalización es "secure context".
 */
import { api } from './api';

export type GpsState =
  | 'off'        // el usuario no acepto compartir (esta sesión de navegador)
  | 'starting'
  | 'active'
  | 'paused'     // activo pero fuera de horario laboral / señal débil
  | 'error';

export interface GpsShareState {
  state: GpsState;
  /** último fix enviado al servidor */
  lastSentAt: number | null;
  lastAccuracy: number | null;
  message: string | null;
  /** horario laboral restaurado desde el server */
  restricted: boolean;
  within: boolean;
  startedAt: string | null;
}

const FLAG_KEY = 'robles_gps_share';

/** Precisión máxima aceptada (metros). Un fix peor que esto pinta al chofer
 *  varias cuadras del lugar: se descarta y se sigue esperando uno bueno. */
const MAX_ACCURACY_M = 35;
/** Distancia mínima entre envíos (m) y espera entre envíos (txn client-side). */
const MIN_DISTANCE_M = 12;
const MIN_INTERVAL_MS = 6000;

const listeners = new Set<() => void>();
let state: GpsShareState = {
  state: 'off',
  lastSentAt: null,
  lastAccuracy: null,
  message: null,
  restricted: false,
  within: true,
  startedAt: null,
};

function setState(patch: Partial<GpsShareState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function getGpsState(): GpsShareState {
  return state;
}

/** Nueva sesión de navegación = nueva decisión del usuario. */
export function clearSharePersistence(): void {
  localStorage.removeItem(FLAG_KEY);
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let watchId: number | null = null;
let wakeLock: { release: () => Promise<void> } | null = null;
let lastSentPos: { lat: number; lng: number } | null = null;
let lastSentAt = 0;

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function send(pos: { lat: number; lng: number; accuracy: number | null; speed: number | null; heading: number | null }) {
  try {
    const r = await api<{ skipped: boolean; reason?: string }>('/tracking/positions', {
      method: 'POST',
      body: { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, speed: pos.speed, heading: pos.heading },
    });
    if (r.reason === 'fuera_de_horario') {
      setState({ state: 'paused', message: 'Fuera del horario laboral configurado. Se reanuda solo.' });
      return;
    }
    lastSentPos = { lat: pos.lat, lng: pos.lng };
    lastSentAt = Date.now();
    setState({
      state: 'active',
      lastSentAt: Date.now(),
      lastAccuracy: pos.accuracy,
      message: null,
    });
  } catch (e) {
    // Error de sesión (401): el handler global manda al login. Otros errores:
    // aviso puntual sin cortar el compartido (tiene que aguantar túneles).
    const status = (e as { status?: number }).status;
    if (!status) setState({ message: 'Sin conexión: reintentando…' });
  }
}

function handleFix(p: GeolocationPosition) {
  const acc = p.coords.accuracy ?? 0;
  if (acc > MAX_ACCURACY_M) {
    setState({ message: `Esperando señal precisa (${Math.round(acc)}m ahora)` });
    return;
  }
  const cur = { lat: p.coords.latitude, lng: p.coords.longitude };
  const movedEnough = !lastSentPos || haversineMeters(lastSentPos, cur) >= MIN_DISTANCE_M;
  const waitedEnough = Date.now() - lastSentAt >= MIN_INTERVAL_MS;
  if (movedEnough && waitedEnough) {
    void send({
      lat: cur.lat, lng: cur.lng, accuracy: acc,
      speed: p.coords.speed ?? null, heading: p.coords.heading ?? null,
    });
  }
}

function handleFixError(err: GeolocationPositionError) {
  if (err.code === err.PERMISSION_DENIED) {
    // El usuario revocó el permiso del navegador: cortamos limpio.
    void stopInternal('user');
    setState({ state: 'error', message: 'Permiso de ubicación revocado por el navegador' });
  } else if (err.code === err.POSITION_UNAVAILABLE) {
    setState({ message: 'GPS no disponible, reintentando…' });
  }
}

/** API real: acepta compartir y abre la sesión hasta cerrar sesión. */
export async function startSharing(): Promise<void> {
  if (!('geolocation' in navigator)) {
    setState({ state: 'error', message: 'Tu navegador no soporta geolocalización' });
    return;
  }
  if (watchId != null) return;
  setState({ state: 'starting', message: null });
  try {
    const r = await api<ShareStartResponse>('/tracking/share/start', { method: 'POST' });
    localStorage.setItem(FLAG_KEY, '1');
    lastSentPos = null;
    lastSentAt = 0;
    watchId = navigator.geolocation.watchPosition(handleFix, handleFixError, {
      enableHighAccuracy: true,
      maximumAge: 0,          // fixes frescos; nada de caché del navegador
      timeout: 20000,
    });
    // Wake lock: mantener la pantalla activa si el navegador lo permite
    void requestWakeLock();
    void refreshSchedule(r.restricted, r.within, r.started_at ?? null);
    setState({ state: 'active', startedAt: r.started_at ?? new Date().toISOString() });
  } catch (e) {
    setState({ state: 'error', message: (e as Error).message });
    localStorage.removeItem(FLAG_KEY);
  }
}

async function requestWakeLock() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void>; addEventListener: (e: string, fn: () => void) => void }> } };
    if (nav.wakeLock) {
      wakeLock = await nav.wakeLock.request('screen');
    }
  } catch { /* el navegador puede rechazarlo: best-effort */ }
}

/** Corte local (sin llamar al server): solo al cerrar sesión/expiración. */
export function stopForLogout(): void {
  localStorage.removeItem(FLAG_KEY);
  stopInternal('logout');
}

/** Detiene y avisa al server (botón Detener). */
export async function stopUser(): Promise<void> {
  localStorage.removeItem(FLAG_KEY);
  try { await api('/tracking/share/stop', { method: 'POST' }); } catch { /* try&continue */ }
  stopInternal('user');
}

function stopInternal(_reason: 'user' | 'logout' | 'replace') {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  lastSentPos = null;
  lastSentAt = 0;
  setState({ state: 'off', message: null, lastSentAt: null, lastAccuracy: null, startedAt: null });
}

/** Reanudar tras recargar la página: solo si quedó el flag y el rol puede. */
export async function maybeResume(canGps: boolean): Promise<void> {
  if (!canGps || localStorage.getItem(FLAG_KEY) !== '1') return;
  if (watchId != null) return;
  try {
    const st = await api<ShareStatusResponse>('/tracking/share');
    await refreshSchedule(st.restricted, st.within, st.started_at ?? null);
    if (!st.active) {
      // Cerró sesión y volvió a entrar: la sesión server murió, pedir de nuevo
      // el "sí, compartir" explícito (botón en Repartos).
      localStorage.removeItem(FLAG_KEY);
      return;
    }
    lastSentPos = null;
    lastSentAt = 0;
    watchId = navigator.geolocation.watchPosition(handleFix, handleFixError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
    });
    void requestWakeLock();
    setState({ state: 'active' });
  } catch {
    localStorage.removeItem(FLAG_KEY);
  }
}

async function refreshSchedule(restricted: boolean, within: boolean, startedAt: string | null) {
  setState({ restricted, within, startedAt });
}

/** Pregunta al server el horario vigente (usado por la UI del chofer). */
export async function pollSchedule(): Promise<void> {
  try {
    const st = await api<ShareStatusResponse>('/tracking/share');
    setState({ restricted: st.restricted, within: st.within });
    if (state.state === 'paused' && st.within) setState({ state: watchId != null ? 'active' : state.state, message: null });
    if (state.state === 'active' && st.restricted && !st.within) setState({ state: 'paused' });
  } catch { /* silencioso */ }
}

interface ShareStartResponse { active: boolean; restricted: boolean; within: boolean; started_at: string | null; schedule: unknown }
interface ShareStatusResponse extends ShareStartResponse {}

