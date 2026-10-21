# Instalación — Sistema Integral de Stock (Robles Pinturerías)

Guía para dejar el sistema funcionando en una computadora nueva (modo desarrollo o producción local).

## 1. Requisitos previos

| Componente | Versión recomendada | Notas |
|---|---|---|
| Node.js | 20 o 22 LTS | [nodejs.org](https://nodejs.org) |
| PostgreSQL | 14 o superior | Probado con PostgreSQL 18 |
| Navegador | Chrome / Edge actual | Para el escáner por cámara en tablets/celulares |

## 2. Instalar dependencias

Abrí una terminal en la carpeta raíz del proyecto (`robles-stock-pro`) y ejecutá:

```bash
npm run setup
```

Este comando instala dependencias de `backend/` y `frontend/` y luego crea la base de datos.

## 3. Crear la base de datos

```bash
npm run db:setup
```

El script:
1. Localiza `psql` (busca en `C:\Program Files\PostgreSQL\*\bin`).
2. Crea el rol `robles_app` y la base `robles_stock` (si no existen) usando la conexión local.
3. Escribe las credenciales en `backend/.env` (incluye un `JWT_SECRET` aleatorio).
4. Aplica las migraciones (`migrations/001_init.sql`).
5. Carga datos iniciales: 3 sucursales + depósito, roles, categorías y el usuario **admin**.

> **Usuario inicial:** `admin` / `robles2026` → **cambiá la contraseña al primer ingreso** (menú → Cambiar clave).

Si tu PostgreSQL requiere contraseña para el usuario `postgres`, ejecutá antes:

```powershell
$env:PGPASSWORD = "tu_clave_postgres"
npm run db:setup
```

## 4. Estructura de la base

```
robles_stock
├── roles, users, locations          ← seguridad y ubicaciones
├── categories, products             ← catálogo
├── stock_balances                   ← saldo por (producto, ubicación), jamás negativo
├── stock_movements                  ← historial inmutable con saldo anterior/posterior
├── deliveries, delivery_items       ← entregas de mercadería
├── stock_entries, stock_entry_items ← entradas
├── transfers, transfer_items        ← transferencias con tránsito
├── stock_counts, stock_count_items  ← inventarios físicos
└── audit_logs                       ← auditoría de operaciones sensibles
```

Migraciones aplicadas de forma idempotente (tabla `schema_migrations`).

## 5. Modo desarrollo

```bash
npm run dev
```

- API: http://localhost:4000 (logs en consola)
- Frontend con recarga: http://localhost:5173

## 6. Modo producción local

```bash
npm run build     # compila backend (tsc) y frontend (vite)
npm start         # sirve TODO en http://localhost:4000
```

O simplemente doble clic en **`Iniciar Robles Stock PRO.bat`**.

Desde otro equipo de la red: `http://<IP-de-la-PC>:4000` (verificá el firewall de Windows).

## 7. Pruebas

```bash
npm test
```

41 verificaciones end-to-end sobre la API real: login, permisos, alta de productos,
entradas, entregas (borrador → confirmación → doble confirmación bloqueada),
transferencias (tránsito → recepción parcial), inventario físico, historial,
dashboard y reportes.

## 8. Variables de entorno (`backend/.env`)

| Variable | Descripción |
|---|---|
| `NODE_ENV` | `development` o `production` |
| `PORT` | Puerto de la API (4000) |
| `DATABASE_URL` | `postgresql://usuario:clave@host:5432/robles_stock` |
| `JWT_SECRET` | Secreto de firmado de tokens (≥32 caracteres) |
| `JWT_EXPIRES` | Vigencia del token (ej. `12h`) |
| `CORS_ORIGIN` | Origen del frontend en desarrollo (`http://localhost:5173`) |
| `SEED_ADMIN_PASSWORD` | Contraseña inicial del admin (solo seed) |
| `PG_DUMP` | Ruta de `pg_dump.exe` para backups |

> Nunca commitees el `.env`: ya está en `.gitignore`.

## 9. Problemas frecuentes

| Problema | Solución |
|---|---|
| `No se pudo conectar a PostgreSQL` | Verificá que el servicio `postgresql-x64-*` esté iniciado y que `DATABASE_URL` sea correcta. |
| `la contraseña del usuario postgres` | Usá `PGPASSWORD` como en el punto 3, o creá el rol manualmente. |
| Otro equipo no accede | Firewall de Windows → regla de entrada TCP 4000 (o 5432 no necesita exponerse). |
| Olvidé la clave del admin | Conectate a la BD y ejecutá el `db:seed` con una nueva `SEED_ADMIN_PASSWORD`, o que otro admin la restablezca desde *Usuarios*. |
