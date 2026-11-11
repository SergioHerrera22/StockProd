"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
function required(name, fallback) {
    const value = process.env[name] ?? fallback;
    if (!value)
        throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
    return value;
}
const nodeEnv = process.env.NODE_ENV ?? 'development';
const jwtSecret = required('JWT_SECRET', 'dev-secret-no-usar-en-produccion');
if (nodeEnv === 'production') {
    if (jwtSecret === 'dev-secret-no-usar-en-produccion' || jwtSecret.length < 32) {
        throw new Error('JWT_SECRET debe configurarse en producción con al menos 32 caracteres y no puede usar el secreto de desarrollo.');
    }
    if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN.trim() === '*') {
        throw new Error('CORS_ORIGIN debe definir explícitamente los orígenes permitidos en producción.');
    }
}
exports.config = {
    env: nodeEnv,
    port: parseInt(process.env.PORT ?? '4000', 10),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret,
    jwtExpires: process.env.JWT_EXPIRES ?? '12h',
    // Minutos de inactividad antes de cerrar la sesión automáticamente (0 = desactivado)
    sessionIdleMinutes: parseFloat(process.env.SESSION_IDLE_MINUTES ?? '30'),
    corsOrigin: process.env.CORS_ORIGIN ?? '*',
    isProd: nodeEnv === 'production',
};
