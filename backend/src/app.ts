import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { securityHeaders, apiLimiter } from './middleware/security';
import authRoutes from './modules/auth/auth.routes';
import sessionRoutes from './modules/sessions/sessions.routes';
import userRoutes from './modules/users/users.routes';
import locationRoutes from './modules/locations/locations.routes';
import categoryRoutes from './modules/categories/categories.routes';
import productRoutes from './modules/products/products.routes';
import stockRoutes from './modules/stock/stock.routes';
import deliveryRoutes from './modules/deliveries/deliveries.routes';
import entryRoutes from './modules/entries/entries.routes';
import transferRoutes from './modules/transfers/transfers.routes';
import countRoutes from './modules/counts/counts.routes';
import movementRoutes from './modules/movements/movements.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import reportRoutes from './modules/reports/reports.routes';
import auditRoutes from './modules/audit/audit.routes';
import pendingDeliveryRoutes from './modules/pending-deliveries/pending-deliveries.routes';
// Nuevos módulos de control y seguridad
import approvalRoutes from './modules/approvals/approvals.routes';
import alertRoutes from './modules/alerts/alerts.routes';
import locationPermissionRoutes from './modules/location-permissions/location-permissions.routes';
import businessRuleRoutes from './modules/business-rules/business-rules.routes';
import reconciliationRoutes from './modules/reconciliation/reconciliation.routes';
import snapshotRoutes from './modules/snapshots/snapshots.routes';
import confirmationRoutes from './modules/settings/confirmation.routes';
import trackingRoutes from './modules/tracking/tracking.routes';
import driversRoutes from './modules/drivers/drivers.routes';
import { pool } from './db/pool';

export function createApp() {
  const app = express();

  // Hostinger termina TLS y hace proxy: sin esto req.ip = IP del proxy y el
  // rate limiting / auditoria de IPs no distinguiria a los clientes.
  app.set('trust proxy', 1);

  // ===== Barrera 1: cabeceras de seguridad en TODAS las respuestas =====
  app.use(securityHeaders);

  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','), credentials: false }));
  // 1 MB basta para todo uso real (los importes de Excel se procesan en el
  // navegador): baja el costo de un payload gigante para agotar memoria.
  app.use(express.json({ limit: '1mb' }));

  // ===== Barrera 2: freno general por IP contra abuso/DoS =====
  app.use('/api', apiLimiter);

  // Health check
  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({
        status: 'ok',
        db: 'ok',
        time: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({ status: 'ok', db: 'error' });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/locations', locationRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/stock', stockRoutes);
  app.use('/api/deliveries', deliveryRoutes);
  app.use('/api/entries', entryRoutes);
  app.use('/api/transfers', transferRoutes);
  app.use('/api/pending-deliveries', pendingDeliveryRoutes);
  app.use('/api/counts', countRoutes);
  app.use('/api/movements', movementRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/audit', auditRoutes);
  // Nuevos módulos de control y seguridad
  app.use('/api/approvals', approvalRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api/location-permissions', locationPermissionRoutes);
  app.use('/api/business-rules', businessRuleRoutes);
  app.use('/api/reconciliation', reconciliationRoutes);
  app.use('/api/snapshots', snapshotRoutes);
  app.use('/api/settings/confirmations', confirmationRoutes);
  app.use('/api/tracking', trackingRoutes);
  app.use('/api/drivers', driversRoutes);

  // En produccion sirve el frontend compilado
  // Desarrollo: ../../frontend/dist | Hostinger (root): ./public
  const candidates = [
    path.resolve(__dirname, '../../frontend/dist'),  // dev local
    path.resolve(__dirname, '../../../public'),      // Hostinger (dist/index.js -> root/public)
    path.resolve(process.cwd(), 'public'),           // Hostinger (cwd = root)
  ];
  const distDir = candidates.find((d) => fs.existsSync(d));
  if (config.isProd && distDir) {
    // Assets de Vite con hash inmutable y el index.html siempre fresco
    // (Cache-Control equivocado tendria a todos con la version vieja).
    app.use(express.static(distDir, {
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use(errorHandler);

  return app;
}
