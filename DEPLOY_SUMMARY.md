# 📦 Resumen de Configuración para Despliegue en Hostinger + Supabase

## ✅ Archivos Creados

| Archivo | Propósito |
|---------|-----------|
| `backend/.env.example` | Template de variables de entorno del backend |
| `frontend/.env.example` | Template de variables de entorno del frontend |
| `.github/workflows/deploy.yml` | Pipeline CI/CD de GitHub Actions |
| `docs/DESPLIEGUE_HOSTINGER.md` | Guía completa paso a paso |
| `.gitignore` | Ignora node_modules, .env, builds, etc. |
| `scripts/deploy-hostinger.mjs` | Script manual de deploy via FTP |
| `package.json` (actualizado) | Agregado script `deploy:hostinger` y dependencia `basic-ftp` |

---

## 🔑 Variables de Entorno Necesarias

### Backend (`backend/.env`)
```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://postgres:TU_PASSWORD@db.TU_PROYECTO.supabase.co:5432/postgres?sslmode=require
JWT_SECRET=GENERA_UNO_CON: openssl rand -base64 48
JWT_EXPIRES=12h
SESSION_IDLE_MINUTES=30
CORS_ORIGIN=*
LOG_LEVEL=info
```

### Frontend (`frontend/.env`)
```env
VITE_API_URL=/api
```

---

## 🔐 GitHub Secrets a Configurar

### Obligatorios (FTP Deploy)
| Secret | Descripción |
|--------|-------------|
| `HOSTINGER_FTP_HOST` | Host FTP (ej: `ftp.tu-dominio.com`) |
| `HOSTINGER_FTP_USER` | Usuario FTP |
| `HOSTINGER_FTP_PASSWORD` | Contraseña FTP |
| `HOSTINGER_FTP_DIR` | Directorio remoto (ej: `/public_html`) |

### Variables de Entorno (como secrets únicos)
| Secret | Contenido |
|--------|-----------|
| `HOSTINGER_BACKEND_ENV` | Todo el `.env` del backend (ver arriba) |
| `HOSTINGER_FRONTEND_ENV` | Todo el `.env` del frontend (ver arriba) |

### Opcionales (SSH para migraciones auto)
| Secret | Descripción |
|--------|-------------|
| `HOSTINGER_SSH_HOST` | IP/host SSH |
| `HOSTINGER_SSH_USER` | Usuario SSH |
| `HOSTINGER_SSH_KEY` | Clave privada SSH completa |
| `HOSTINGER_SSH_PORT` | Puerto SSH (22 o 65002) |
| `HOSTINGER_SSH_DIR` | Directorio del proyecto en servidor |

---

## 🚀 Pasos Rápidos

### 1. Preparar Supabase
```bash
# En Supabase Dashboard → Settings → Database → Connection string
# Copia y reemplaza [YOUR-PASSWORD] con tu password real
DATABASE_URL=postgresql://postgres:TU_PASSWORD@db.TU_REF.supabase.co:5432/postgres?sslmode=require
```

### 2. Ejecutar migraciones en Supabase (una sola vez)
```bash
# Desde tu máquina local
export PGPASSWORD="tu_password_supabase"
psql "postgresql://postgres:tu_password@db.tu_ref.supabase.co:5432/postgres" -f backend/migrations/001_init.sql
psql "postgresql://postgres:tu_password@db.tu_ref.supabase.co:5432/postgres" -f backend/migrations/002_sessions_and_restrictions.sql
node backend/scripts/seed.mjs
```

### 3. Configurar GitHub Secrets
- Ve a: `https://github.com/TU_USUARIO/robles-stock-pro/settings/secrets/actions`
- Añade todos los secrets de la tabla de arriba

### 4. Primer push a main
```bash
git add .
git commit -m "feat: add Hostinger + Supabase deployment config"
git push origin main
```

### 5. Verificar deploy
- GitHub → Actions → "Deploy to Hostinger" → debe pasar en verde
- Tu app en: `https://tu-dominio.hostinger.com` (o dominio personalizado)

---

## 🔄 Flujo de Trabajo Diario

```bash
# Haces cambios
git add .
git commit -m "fix: corrección en entregas"
git push origin main

# GitHub Actions automáticamente:
# 1. Lint + TypeCheck
# 2. Tests
# 3. Build (backend + frontend)
# 4. Deploy FTP a Hostinger
# 5. Migraciones via SSH (si configurado)
# 6. Reinicio app
```

---

## 📁 Estructura en Hostinger (post-deploy)

```
/public_html/ (o tu HOSTINGER_FTP_DIR)
├── backend/
│   ├── dist/           # Código compilado JS
│   ├── package.json
│   ├── package-lock.json
│   └── .env            # Variables de producción
├── frontend/
│   ├── dist/           # Build estático (HTML, JS, CSS)
│   └── .env            # VITE_API_URL=/api
└── (otros archivos del proyecto)
```

---

## ⚠️ Notas Importantes

1. **Puerto en Hostinger**: Hostinger asigna el puerto via variable de entorno `PORT`. El código ya lo lee (`config.port` en `backend/src/config/env.ts`).

2. **Archivo de inicio**: En panel Hostinger Node.js, configura:
   - **Startup file**: `backend/dist/index.js`
   - **Node version**: 20.x

3. **HTTPS**: Hostinger maneja SSL automáticamente (Let's Encrypt). No necesitas configurar nada extra.

4. **CORS**: Si frontend y backend están en el mismo dominio, `CORS_ORIGIN=*` funciona. Si usas subdominios, pon el dominio exacto.

5. **Base de datos**: Supabase maneja backups automáticos, connection pooling, y SSL. No necesitas gestionar PostgreSQL.

6. **Logs**: En hosting compartido, revisa logs en panel Hostinger o via SSH en `~/domains/tu-dominio/logs/`.

---

## 🆘 Troubleshooting Rápido

| Problema | Solución |
|----------|----------|
| "Cannot find module" en Hostinger | Verifica que `package-lock.json` se subió y haz `npm ci` en servidor |
| Error de BD (ECONNREFUSED) | Verifica `DATABASE_URL`, password, y SSL mode |
| CORS error | Ajusta `CORS_ORIGIN` en backend a tu dominio exacto |
| App no inicia | Revisa logs, asegúrate que `PORT` se lee del env, archivo inicio correcto |
| FTP timeout | Aumenta timeout en workflow o usa SSH/rsync |

---

## 📚 Documentación Relacionada

- `docs/DESPLIEGUE_HOSTINGER.md` — Guía completa detallada
- `docs/DESPLIEGUE.md` — Despliegue local/VPS tradicional
- `docs/INSTALACION.md` — Instalación local
- `docs/BACKUPS.md` — Estrategia de backups

---

**¿Listo para desplegar? 🚀**

Sigue la guía en `docs/DESPLIEGUE_HOSTINGER.md` para el paso a paso completo.