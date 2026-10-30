/**
 * Caché en memoria con TTL para datos de configuración que casi nunca
 * cambian (settings de confirmación, business rules, thresholds).
 * La BD esta en Supabase: cada SELECT es un round-trip de red (1-5 ms),
 * leer la misma configuracion en cada operacion es tiempo puro desperdiciado.
 */
interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function cacheGet<T>(key: string): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() >= e.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return e.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Ejecuta fn devolviendo el valor cacheado si existe y no expiró (TTL por key). */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  cacheSet(key, value, ttlMs);
  return value;
}

/** Invalida por prefijo (ej. 'confirm-setting:' → borra todas las variantes). */
export function cacheInvalidate(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
