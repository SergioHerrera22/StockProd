# 🚀 Guía de Despliegue en Hostinger - Robles Stock Pro

## 📦 Archivo de Despliegue
**`robles-stock-pro-deploy.zip`** (387 KB) - Contiene:
- `backend/dist/` - API Node.js compilada (TypeScript → JS)
- `frontend/dist/` - React + Vite compilado (HTML, CSS, JS)
- `backend/package.json` + `package-lock.json` - Dependencias
- `backend/.env.production` - Variables de entorno para producción

---

## 📋 Pasos para Desplegar en Hostinger

### 1. **Preparar Base de Datos (Supabase) ✅ YA HECHO**
- Las migraciones ya se ejecutaron en tu Supabase
- Tablas creadas: `pending_deliveries`, `stock_reservations`, etc.
- Usuario admin: `admin` / `robles2026` (cambiar al primer login)

### 2. **Subir Archivos a Hostinger**

#### Opción A: Panel de Archivos (File Manager)
1. Entra a **Hostinger Panel → Files → File Manager**
2. Navega a `public_html` (o tu carpeta de dominio)
3. Sube `robles-stock-pro-deploy.zip`
4. Click derecho → **Extract**
5. Verifica que quede:
   ```
   public_html/
   ├── index.html          ← Frontend
   ├── assets/             ← CSS/JS del frontend
   ├── index.js            ← Backend entry point
   ├── package.json
   ├── package-lock.json
   ├── .env.production
   ├── config/
   ├── db/
   ├── lib/
   ├── middleware/
   ├── modules/
   └── services/
   ```

#### Opción B: Git (si usas GitHub)
1. Sube el zip a tu repo o clona directo
2. En Hostinger: **Git → Deploy**

### 3. **Configurar App Node.js en Hostinger**

1. Ve a **Hostinger Panel → Advanced → Node.js**
2. Click **Create Application**
3. Configuración:
   ```
   Node.js version: 20.x (o 18.x)
   Application mode: Production
   Application root: /home/tuusuario/public_html  (o tu carpeta)
   Application URL: tudominio.hostinger.com
   Application startup file: index.js
   ```
4. Click **Create**

### 4. **Configurar Variables de Entorno**

En la misma pantalla de Node.js, sección **Environment Variables**:

| Variable | Valor |
|----------|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` (Hostinger lo asigna automáticamente) |
| `DATABASE_URL` | `postgresql://postgres.axoaagdgygpynxbvpnit:Dni29165947@aws-1-us-west-2.pooler.supabase.com:5432/postgres` |
| `JWT_SECRET` | `x7Kp9mQ2vT4wZ8nB5rY1cE6hJ3fD0aS7Kp9mQ2vT4wZ8nB5rY1cE6h` |
| `JWT_EXPIRES` | `12h` |
| `SESSION_IDLE_MINUTES` | `30` |
| `CORS_ORIGIN` | `https://tudominio.hostinger.com` (cambia por tu dominio real) |
| `LOG_LEVEL` | `info` |

⚠️ **IMPORTANTE**: Cambia `CORS_ORIGIN` por tu dominio real (ej: `https://mipintureria.hostinger.com`)

### 5. **Instalar Dependencias**

En la consola de Node.js de Hostinger (o via SSH):
```bash
npm ci --production
```

### 6. **Reiniciar Aplicación**

Click **Restart** en el panel de Node.js.

### 7. **Verificar Funcionamiento**

1. Abre `https://tudominio.hostinger.com` → Debe cargar el frontend React
2. Prueba login: `admin` / `robles2026`
3. Verifica health check: `https://tudominio.hostinger.com/api/health`
   ```json
   {"status":"ok","db":"ok","time":"2026-10-21T..."}
   ```
4. Prueba endpoint de stock: `https://tudominio.hostinger.com/api/pending-deliveries/stock-available`

---

## 🔧 Estructura de Carpetas en Servidor

```
public_html/                    ← Document Root (apache/nginx sirve frontend)
├── index.html                  ← React app entry
├── assets/                     ← CSS/JS bundles
├── index.js                    ← Node.js entry point (backend)
├── package.json
├── .env.production             ← Variables de entorno
├── config/
│   └── env.js
├── db/
│   └── pool.js                 ← Pool PG con SSL
├── lib/
├── middleware/
├── modules/
│   ├── pending-deliveries/     ← NUEVO: Órdenes pendientes + códigos barras
│   ├── deliveries/             ← Entregas (usa reservas)
│   ├── transfers/              ← Traslados (usa reservas)
│   └── ...
└── services/
    ├── reservation.service.js  ← NUEVO: Sistema reservas genérico
    ├── stockEngine.js
    └── ...
```

---

## 🌐 Configuración de Dominio/SSL

1. **SSL**: Hostinger lo activa automático (Let's Encrypt)
2. **Dominio personalizado**: En **Domains → Manage → DNS**, apunta A record a tu IP
3. **Subdominio API** (opcional): `api.tudominio.com` → mismo Document Root

---

## 📝 Variables Críticas a Personalizar

Edita `.env.production` ANTES de subir o en el panel Node.js:

```env
# CAMBIA ESTO POR TU DOMINIO REAL
CORS_ORIGIN=https://mipintureria.hostinger.com

# Si usas subdominio para API:
# CORS_ORIGIN=https://mipintureria.hostinger.com,https://api.mipintureria.hostinger.com
```

---

## 🔍 Logs y Debug

- **Logs**: Hostinger Panel → Node.js → Logs
- **Health check**: `GET /api/health`
- **Errores comunes**:
  - `ECONNREFUSED` → Puerto incorrecto (usa `process.env.PORT`)
  - `CORS error` → `CORS_ORIGIN` mal configurado
  - `SSL error` → Verifica `DATABASE_URL` usa pooler Supabase

---

## 📱 Funcionalidades Nuevas Disponibles

1. **Órdenes de Entrega Pendientes** (`/api/pending-deliveries`)
   - Venta multi-sucursal con reserva automática
   - Código de barras EAN-13 único por orden
   - Escaneo en sucursal de retiro
   - Confirmación de retiro con descuento de stock real

2. **Sistema de Reservas Genérico** (protege TODOS los movimientos)
   - Entregas, traslados, entradas, ajustes, conteos
   - Anti-concurrencia: imposible vender mismo stock 2 veces

3. **Stock Disponible Real** (total - reservado)
   - Vista `v_stock_availability`
   - Endpoint `/api/pending-deliveries/stock-available`

---

## 🆘 Soporte

Si algo falla:
1. Revisa logs en Hostinger Panel → Node.js → Logs
2. Verifica health check: `curl https://tudominio.com/api/health`
3. Confirma variables de entorno en panel Node.js
4. Asegúrate que `npm ci --production` completó sin errores

---

**¡Listo! Tu Robles Stock Pro con reservas multi-sucursal y códigos de barras está listo para producción.** 🎉