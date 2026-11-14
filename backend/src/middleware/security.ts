import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * =============================================================================
 * CAPA DE SEGURIDAD PERIMETRAL (aplicada por app.ts)
 * =============================================================================
 * Objetivo: que la web NO sirva como vector de ataque hacia las PCs de la
 * oficina. Se aplican tres barreras, todas estandar:
 *
 *   1. securityHeaders  -> Helmet: cabeceras que el navegador respeta SIEMPRE
 *      (independiente de problemas futuros en el codigo). Bloquea:
 *      - XSS (CSP: solo scripts/estilos propios, sin inline ni dominios raros)
 *      - Clickjacking (frame-ancestors 'none' + X-Frame-Options DENY)
 *      - HSTS (fuerza HTTPS), MIME sniffing, origen noreferrer, etc.
 *
 *   2. apiLimiter       -> Freno general contra DoS/abuso por IP.
 *
 *   3. authLimiter      -> Freno anti fuerza bruta para login y cambio de
 *      contrasena. SOLO cuenta intentos fallidos: los aciertos no consumen la
 *      cuota (varias personas detras del NAT de la tienda no se bloquean).
 * =============================================================================
 */

// Helmet 8 ya no trae Permissions-Policy: cabecera manual que permite usar
// SOLO geolocalizacion y camara (a futuro: gps de reparto y escaneo de
// codigos). Todo lo demas del navegador queda bloqueado.
const permissionsPolicy: RequestHandler = (_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(self), camera=(self), microphone=(), payment=(), usb=()'
  );
  next();
};

/** Cabeceras estrictas para un SPA de Vite servido por este mismo Express. */
export const securityHeaders: RequestHandler[] = [
  helmet({
  // CSP restrictiva: scripts propios y una excepción puntual para el motor OCR
  // Tesseract.js. No se habilitan scripts inline ni eval general.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // Tesseract.js 5 carga su worker y los recursos WebAssembly desde jsDelivr.
      // Se autoriza únicamente ese CDN; no se habilita unsafe-eval ni scripts inline.
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"],
      workerSrc: ["'self'", 'blob:', 'https://cdn.jsdelivr.net'],
      // React pinta estilos en atributos style: requiere 'unsafe-inline' de
      // estilos (no habilita ejecucion de scripts).
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Tiles de OpenStreetMap para el mapa de reparto (/api/tracking).
      imgSrc: ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org', 'https://*.tile.openstreetmap.org'],
      fontSrc: ["'self'", 'data:'],
      // Descarga del worker, core WASM y modelos de idioma de Tesseract.
      connectSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://tessdata.projectnaptha.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // HSTS: si alguien entra por http, el navegador remarca a https.
  hsts: { maxAge: 15552000, includeSubDomains: true },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  }),
  permissionsPolicy,
];

/** Limite global de la API: abuso/DoS, no usuarios legítimos. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  limit: 600, // ~1 pedido/seg sostenido por IP: cualquier uso real entra holgado
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados pedidos desde esta conexión. Esperá unos minutos.' },
});

/** Anti fuerza bruta en login / cambio de contrasena. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  // Los logins correctos no cuentan: behind-NAT la sucursal sigue funcionando.
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Esperá 15 minutos e intentá de nuevo.' },
});
