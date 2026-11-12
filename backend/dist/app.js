"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const env_1 = require("./config/env");
const errorHandler_1 = require("./middleware/errorHandler");
const security_1 = require("./middleware/security");
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const sessions_routes_1 = __importDefault(require("./modules/sessions/sessions.routes"));
const users_routes_1 = __importDefault(require("./modules/users/users.routes"));
const locations_routes_1 = __importDefault(require("./modules/locations/locations.routes"));
const categories_routes_1 = __importDefault(require("./modules/categories/categories.routes"));
const suppliers_routes_1 = __importDefault(require("./modules/suppliers/suppliers.routes"));
const products_routes_1 = __importDefault(require("./modules/products/products.routes"));
const stock_routes_1 = __importDefault(require("./modules/stock/stock.routes"));
const deliveries_routes_1 = __importDefault(require("./modules/deliveries/deliveries.routes"));
const entries_routes_1 = __importDefault(require("./modules/entries/entries.routes"));
const transfers_routes_1 = __importDefault(require("./modules/transfers/transfers.routes"));
const merchandise_requests_routes_1 = __importDefault(require("./modules/merchandise-requests/merchandise-requests.routes"));
const counts_routes_1 = __importDefault(require("./modules/counts/counts.routes"));
const movements_routes_1 = __importDefault(require("./modules/movements/movements.routes"));
const dashboard_routes_1 = __importDefault(require("./modules/dashboard/dashboard.routes"));
const reports_routes_1 = __importDefault(require("./modules/reports/reports.routes"));
const audit_routes_1 = __importDefault(require("./modules/audit/audit.routes"));
const pending_deliveries_routes_1 = __importDefault(require("./modules/pending-deliveries/pending-deliveries.routes"));
// Nuevos módulos de control y seguridad
const approvals_routes_1 = __importDefault(require("./modules/approvals/approvals.routes"));
const alerts_routes_1 = __importDefault(require("./modules/alerts/alerts.routes"));
const location_permissions_routes_1 = __importDefault(require("./modules/location-permissions/location-permissions.routes"));
const business_rules_routes_1 = __importDefault(require("./modules/business-rules/business-rules.routes"));
const reconciliation_routes_1 = __importDefault(require("./modules/reconciliation/reconciliation.routes"));
const snapshots_routes_1 = __importDefault(require("./modules/snapshots/snapshots.routes"));
const confirmation_routes_1 = __importDefault(require("./modules/settings/confirmation.routes"));
const tracking_routes_1 = __importDefault(require("./modules/tracking/tracking.routes"));
const drivers_routes_1 = __importDefault(require("./modules/drivers/drivers.routes"));
const pool_1 = require("./db/pool");
function createApp() {
    const app = (0, express_1.default)();
    // Hostinger termina TLS y hace proxy: sin esto req.ip = IP del proxy y el
    // rate limiting / auditoria de IPs no distinguiria a los clientes.
    app.set('trust proxy', 1);
    // ===== Barrera 1: cabeceras de seguridad en TODAS las respuestas =====
    app.use(security_1.securityHeaders);
    app.disable('x-powered-by');
    app.use((0, cors_1.default)({ origin: env_1.config.corsOrigin === '*' ? true : env_1.config.corsOrigin.split(','), credentials: false }));
    // El Centro de Carga envía lotes acotados; 2 MB cubren descripciones completas
    // sin permitir cuerpos arbitrariamente grandes.
    app.use(express_1.default.json({ limit: '2mb' }));
    // ===== Barrera 2: freno general por IP contra abuso/DoS =====
    app.use('/api', security_1.apiLimiter);
    // Health check
    app.get('/api/health', async (_req, res) => {
        try {
            await pool_1.pool.query('SELECT 1');
            res.json({
                status: 'ok',
                db: 'ok',
                time: new Date().toISOString(),
            });
        }
        catch {
            res.status(500).json({ status: 'ok', db: 'error' });
        }
    });
    app.use('/api/auth', auth_routes_1.default);
    app.use('/api/sessions', sessions_routes_1.default);
    app.use('/api/users', users_routes_1.default);
    app.use('/api/locations', locations_routes_1.default);
    app.use('/api/categories', categories_routes_1.default);
    app.use('/api/suppliers', suppliers_routes_1.default);
    app.use('/api/products', products_routes_1.default);
    app.use('/api/stock', stock_routes_1.default);
    app.use('/api/deliveries', deliveries_routes_1.default);
    app.use('/api/entries', entries_routes_1.default);
    app.use('/api/transfers', transfers_routes_1.default);
    app.use('/api/merchandise-requests', merchandise_requests_routes_1.default);
    app.use('/api/pending-deliveries', pending_deliveries_routes_1.default);
    app.use('/api/counts', counts_routes_1.default);
    app.use('/api/movements', movements_routes_1.default);
    app.use('/api/dashboard', dashboard_routes_1.default);
    app.use('/api/reports', reports_routes_1.default);
    app.use('/api/audit', audit_routes_1.default);
    // Nuevos módulos de control y seguridad
    app.use('/api/approvals', approvals_routes_1.default);
    app.use('/api/alerts', alerts_routes_1.default);
    app.use('/api/location-permissions', location_permissions_routes_1.default);
    app.use('/api/business-rules', business_rules_routes_1.default);
    app.use('/api/reconciliation', reconciliation_routes_1.default);
    app.use('/api/snapshots', snapshots_routes_1.default);
    app.use('/api/settings/confirmations', confirmation_routes_1.default);
    app.use('/api/tracking', tracking_routes_1.default);
    app.use('/api/drivers', drivers_routes_1.default);
    // En produccion sirve el frontend compilado
    // Desarrollo: ../../frontend/dist | Hostinger (root): ./public
    const candidates = [
        path_1.default.resolve(__dirname, '../../frontend/dist'), // dev local
        path_1.default.resolve(__dirname, '../../../public'), // Hostinger (dist/index.js -> root/public)
        path_1.default.resolve(process.cwd(), 'public'), // Hostinger (cwd = root)
    ];
    const distDir = candidates.find((d) => fs_1.default.existsSync(d));
    if (env_1.config.isProd && distDir) {
        // Assets de Vite con hash inmutable y el index.html siempre fresco
        // (Cache-Control equivocado tendria a todos con la version vieja).
        app.use(express_1.default.static(distDir, {
            setHeaders: (res, filePath) => {
                if (filePath.includes(`${path_1.default.sep}assets${path_1.default.sep}`)) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                }
            },
        }));
        app.get('*', (_req, res) => {
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(path_1.default.join(distDir, 'index.html'));
        });
    }
    app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
    app.use(errorHandler_1.errorHandler);
    return app;
}
