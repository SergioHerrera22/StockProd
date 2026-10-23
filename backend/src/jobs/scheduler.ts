import { query } from '../db/pool';
import { logger } from '../lib/logger';
import { runAllScheduledChecks } from '../services/alerts.service';

/**
 * Scheduler interno de jobs de stock/entregas.
 *
 * Ejecuta en un intervalo (default 15 min):
 *   1. cleanup_expired_reservations()      -> libera reservas con expires_at vencido
 *   2. auto_cancel_expired_pending_deliveries() -> cancela ordenes de retiro vencidas
 *   3. runAllScheduledChecks()             -> alertas (vencimientos, stock bajo, anomalias)
 *
 * Antes de este scheduler las funciones de BD existian pero NADIE las llamaba:
 * las reservas expiradas quedaban ACTIVA para siempre y bloqueaban stock.
 */

const INTERVAL_MINUTES = Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? 15);

let inFlight = false;
let timer: NodeJS.Timeout | null = null;

export function startScheduler() {
  if (INTERVAL_MINUTES <= 0) {
    logger.info('SCHEDULER_INTERVAL_MINUTES <= 0: scheduler deshabilitado');
    return;
  }

  // Primera corrida rapida tras el boot (1 min) para limpiar lo viejo
  setTimeout(() => { void runCycle(); }, 60_000);
  timer = setInterval(() => { void runCycle(); }, INTERVAL_MINUTES * 60_000);
  timer.unref();
  logger.info(`Scheduler iniciado: cada ${INTERVAL_MINUTES} min (reservas expiradas, retiros vencidos, alertas)`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function runCycle() {
  if (inFlight) return; // no solapar ciclos
  inFlight = true;
  const started = Date.now();
  try {
    // 1. Liberar reservas vencidas (debe ir antes de la auto-cancelacion)
    const cleanup = await query<{ cleaned_count: string; message: string }>(
      'SELECT * FROM cleanup_expired_reservations()'
    );
    logger.info('Scheduler cleanup:', cleanup.rows[0]?.message);

    // 2. Cancelar ordenes pendientes vencidas (48h sin retiro, sin reservas vigentes)
    const autoCancel = await query<{ cancelled_count: string; message: string }>(
      'SELECT * FROM auto_cancel_expired_pending_deliveries()'
    );
    logger.info('Scheduler auto-cancel:', autoCancel.rows[0]?.message);

    // 3. Alertas programadas (dedupe propio; crea solo si no existe una abierta)
    const checks = await runAllScheduledChecks();
    const failed = checks.filter(c => 'error' in c);
    if (failed.length > 0) {
      logger.warn('Scheduler checks con error:', failed);
    }
  } catch (err) {
    logger.error('Scheduler cycle error:', (err as Error).message);
  } finally {
    inFlight = false;
    logger.info(`Scheduler cycle completo en ${Date.now() - started}ms`);
  }
}
