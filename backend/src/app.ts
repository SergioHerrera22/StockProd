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
      res.json({ status: 'ok', db: 'ok', time: new Date().toISOString() });
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
  app.use('/api/counts', countRoutes);
  app.use('/api/movements', movementRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/audit', auditRoutes);

  // En produccion sirve el frontend compilado (frontend/dist)
  const distDir = path.resolve(__dirname, '../../frontend/dist');
  if (config.isProd && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use(errorHandler);

  return app;
}
