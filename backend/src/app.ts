import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config/env';
import { errorHandler } from './middleware/errorHandler';
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
import { pool } from './db/pool';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','), credentials: false }));
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const dbInfo = await pool.query<{ current_database: string; current_user: string }>(
        'SELECT current_database() AS current_database, current_user AS current_user'
      );
      res.json({
        status: 'ok',
        db: 'ok',
        time: new Date().toISOString(),
        database: dbInfo.rows[0]?.current_database,
        user: dbInfo.rows[0]?.current_user,
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

  // En produccion sirve el frontend compilado
  // Desarrollo: ../../frontend/dist | Hostinger (root): ./public
  const candidates = [
    path.resolve(__dirname, '../../frontend/dist'),  // dev local
    path.resolve(__dirname, '../../../public'),      // Hostinger (dist/index.js -> root/public)
    path.resolve(process.cwd(), 'public'),           // Hostinger (cwd = root)
  ];
  const distDir = candidates.find((d) => fs.existsSync(d));
  if (config.isProd && distDir) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use(errorHandler);

  return app;
}
