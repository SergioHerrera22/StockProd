"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startScheduler = startScheduler;
exports.stopScheduler = stopScheduler;
const pool_1 = require("../db/pool");
const logger_1 = require("../lib/logger");
const alerts_service_1 = require("../services/alerts.service");
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
let timer = null;
function startScheduler() {
    if (INTERVAL_MINUTES <= 0) {
        logger_1.logger.info('SCHEDULER_INTERVAL_MINUTES <= 0: scheduler deshabilitado');
        return;
    }
    // Primera corrida rapida tras el boot (1 min) para limpiar lo viejo
    setTimeout(() => { void runCycle(); }, 60_000);
    timer = setInterval(() => { void runCycle(); }, INTERVAL_MINUTES * 60_000);
    timer.unref();
    logger_1.logger.info(`Scheduler iniciado: cada ${INTERVAL_MINUTES} min (reservas expiradas, retiros vencidos, alertas)`);
}
function stopScheduler() {
    if (timer)
        clearInterval(timer);
    timer = null;
}
async function runCycle() {
    if (inFlight)
        return; // no solapar ciclos
    inFlight = true;
    const started = Date.now();
    try {
        // 1. Liberar reservas vencidas (debe ir antes de la auto-cancelacion)
        const cleanup = await (0, pool_1.query)('SELECT * FROM cleanup_expired_reservations()');
        logger_1.logger.info('Scheduler cleanup:', cleanup.rows[0]?.message);
        // 2. Cancelar ordenes pendientes vencidas (48h sin retiro, sin reservas vigentes)
        const autoCancel = await (0, pool_1.query)('SELECT * FROM auto_cancel_expired_pending_deliveries()');
        logger_1.logger.info('Scheduler auto-cancel:', autoCancel.rows[0]?.message);
        // 3. Alertas programadas (dedupe propio; crea solo si no existe una abierta)
        const checks = await (0, alerts_service_1.runAllScheduledChecks)();
        const failed = checks.filter(c => 'error' in c);
        if (failed.length > 0) {
            logger_1.logger.warn('Scheduler checks con error:', failed);
        }
    }
    catch (err) {
        logger_1.logger.error('Scheduler cycle error:', err.message);
    }
    finally {
        inFlight = false;
        logger_1.logger.info(`Scheduler cycle completo en ${Date.now() - started}ms`);
    }
}
