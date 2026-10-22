# 🚀 Guía de Despliegue en Hostinger + Supabase (via GitHub Actions)

## 📋 Requisitos previos

1. **Cuenta en Hostinger** con plan que soporte Node.js (Business o superior, o VPS)
2. **Cuenta en Supabase** (proyecto creado)
3. **Repositorio en GitHub** con este código

---

## 1️⃣ CONFIGURAR SUPABASE (Base de datos)

### Crear proyecto en Supabase
1. Ve a [supabase.com](https://supabase.com) → New Project
2. Organización: tu organización
3. Nombre: `robles-stock-pro` (o el que prefieras)
4. Contraseña de BD: **guárdala bien** (la necesitarás para `DATABASE_URL`)
5. Región: la más cercana a tu Hostinger (ej: South America - São Paulo)

### Obtener connection string
1. En Supabase Dashboard → Settings → Database
2. Copia **Connection string** (URI format)
3. Se ve así:
   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   ```
4. Reemplaza `[YOUR-PASSWORD]` con la contraseña que definiste

### Ejecutar migraciones en Supabase
**Opción A: Desde tu máquina local (recomendado)**
```bash
# Instala psql si no lo tienes
# En Supabase Dashboard → Settings → Database → Connection pooling → usa el puerto 6543

export PGPASSWORD="tu_password_supabase"
psql "postgresql://postgres:tu_password@db.tu_proyecto.supabase.co:5432/postgres" -f backend/migrations/001_init.sql
psql "postgresql://postgres:tu_password@db.tu_proyecto.supabase.co:5432/postgres" -f backend/migrations/002_sessions_and_restrictions.sql

# Ejecutar seed (datos iniciales)
node backend/scripts/seed.mjs
```

**Opción B: Desde GitHub Actions (después del primer deploy)**
Las migraciones se ejecutan automáticamente via SSH en el workflow.

### Configurar Supabase para conexiones externas
- Supabase **requiere SSL** → la connection string ya incluye `?sslmode=require`
- No necesitas configurar IP allowlist (Supabase acepta conexiones desde cualquier IP con credenciales correctas)
- **Connection pooling**: Si usas el pooler (puerto 6543), usa `?pgbouncer=true` en la URL

---

## 2️⃣ CONFIGURAR HOSTINGER

### Opción A: Hosting compartido con Node.js (Business/Cloud)
1. Panel Hostinger → **Sitios web** → **Añadir sitio web**
2. Selecciona tu dominio o usa subdominio gratis
3. En **Configuración avanzada** → **Node.js** → Activa **Node.js**
4. Versión Node.js: **20.x** (o la más reciente disponible)
5. **Directorio raíz**: `public_html` (o el que configure)
6. **Archivo de inicio**: `backend/dist/index.js`

### Opción B: VPS (recomendado para producción real)
1. Contrata VPS en Hostinger (KVM 1 o 2)
2. Ubuntu 22.04/24.04
3. Sigue la guía de `docs/DESPLIEGUE.md` sección "Despliegue en VPS Linux"

### Obtener credenciales FTP/SSH
**FTP (para GitHub Actions):**
- Panel → **Archivos** → **Acceso FTP**
- Host: `ftp.tu-dominio.com` (o IP del servidor)
- Usuario: `u1234567` (tu usuario FTP)
- Contraseña: la que definiste
- Directorio: `/public_html` (o `/home/u1234567/domains/tu-dominio.com/public_html`)

**SSH (para migraciones y reinicios):**
- Panel → **Avanzado** → **Acceso SSH**
- Activa SSH
- Host: IP de tu VPS/servidor
- Usuario: `root` (VPS) o tu usuario FTP
- Puerto: `22` (o `65002` en hosting compartido)
- Clave SSH: genera una y añade la pública en Hostinger

---

## 3️⃣ CONFIGURAR GITHUB SECRETS

Ve a tu repositorio en GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

### Secrets OBLIGATORIOS:

| Secret | Valor | Ejemplo |
|--------|-------|---------|
| `HOSTINGER_FTP_HOST` | Host FTP de Hostinger | `ftp.tu-dominio.com` |
| `HOSTINGER_FTP_USER` | Usuario FTP | `u1234567` |
| `HOSTINGER_FTP_PASSWORD` | Contraseña FTP | `tu_password_ftp` |
| `HOSTINGER_FTP_DIR` | Directorio remoto | `/public_html` |

### Variables de entorno BACKEND (como UN solo secret):
**Nombre:** `HOSTINGER_BACKEND_ENV`
**Valor:** (copia y pega completo, reemplaza los valores)

```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://postgres:TU_PASSWORD_SUPABASE@db.TU_PROJECT_REF.supabase.co:5432/postgres?sslmode=require
JWT_SECRET=TU_JWT_SECRET_SUPER_SEGURO_AQUI_MINIMO_48_CARACTERES
JWT_EXPIRES=12h
SESSION_IDLE_MINUTES=30
CORS_ORIGIN=*
LOG_LEVEL=info
```

### Variables de entorno FRONTEND (como UN solo secret):
**Nombre:** `HOSTINGER_FRONTEND_ENV`
**Valor:**

```env
VITE_API_URL=/api
```

### Secrets OPCIONALES (para migraciones automáticas via SSH):

| Secret | Valor |
|--------|-------|
| `HOSTINGER_SSH_HOST` | IP o host SSH del servidor |
| `HOSTINGER_SSH_USER` | Usuario SSH (root o tu usuario) |
| `HOSTINGER_SSH_KEY` | Clave SSH PRIVADA (contenido completo del archivo `id_rsa` o `id_ed25519`) |
| `HOSTINGER_SSH_PORT` | Puerto SSH (22 o 65002) |
| `HOSTINGER_SSH_DIR` | Directorio del proyecto en el servidor (ej: `/home/u1234567/domains/tu-dominio.com/public_html`) |

---

## 4️⃣ PRIMER DESPLIEGUE MANUAL (antes de GitHub Actions)

Como las migraciones de BD necesitan correrse una vez, haz esto **una sola vez**:

```bash
# 1. Clona el repo en tu máquina
git clone https://github.com/TU_USUARIO/robles-stock-pro.git
cd robles-stock-pro

# 2. Instala dependencias
npm run setup

# 3. Configura .env.local con tu DATABASE_URL de Supabase
# Edita backend/.env con la URL de Supabase

# 4. Ejecuta migraciones contra Supabase
cd backend
node scripts/migrate.mjs
node scripts/seed.mjs

# 5. Build local
cd ..
npm run build

# 6. Sube manualmente por FTP la primera vez (backend/dist + frontend/dist + package.json)
# O usa: npx ftp-deploy con las credenciales
```

---

## 5️⃣ DESPLIEGUE AUTOMÁTICO CON GITHUB ACTIONS

Una vez configurados los secrets:

1. Haz push a `main` o `master`:
   ```bash
   git add .
   git commit -m "config: add deployment workflow"
   git push origin main
   ```

2. Ve a **Actions** en GitHub → verás el workflow "Deploy to Hostinger" corriendo

3. Espera a que termine (≈ 3-5 min)

4. ¡Listo! Tu app está en `https://tu-dominio.hostinger.com` (o tu dominio personalizado)

---

## 6️⃣ CONFIGURACIÓN DE DOMINIO PERSONALIZADO (Opcional)

### En Hostinger:
1. Panel → **Dominios** → **Añadir dominio**
2. Apunta los DNS a Hostinger (nameservers o A record)

### En Supabase (para auth callbacks si usaras Supabase Auth):
- No aplica, usamos JWT propio

### En la app (CORS):
- Si usas subdominio para API: `CORS_ORIGIN=https://api.tu-dominio.com`
- Si todo en mismo dominio: `CORS_ORIGIN=*` (actual config)

---

## 7️⃣ COMANDOS ÚTILES POST-DESPLIEGUE

### Ver logs en Hostinger (hosting compartido):
```bash
# Via SSH
tail -f ~/domains/tu-dominio.com/public_html/app.log
# O en el panel: Archivos → logs
```

### Reiniciar app manualmente:
```bash
# Via SSH en el directorio del proyecto
pkill -f "node backend/dist/index.js"
nohup node backend/dist/index.js > app.log 2>&1 &
```

### Ejecutar migraciones nuevas:
```bash
cd /ruta/del/proyecto/backend
node scripts/migrate.mjs
```

### Backup de BD (Supabase):
- Supabase tiene backups automáticos (Point-in-time recovery)
- Para backup manual: Dashboard → Database → Backups → Create backup

---

## 8️⃣ CHECKLIST DE PRODUCCIÓN

- [ ] `NODE_ENV=production` en backend
- [ ] `JWT_SECRET` único, aleatorio, >48 chars (genera con: `openssl rand -base64 48`)
- [ ] `DATABASE_URL` apunta a Supabase con `?sslmode=require`
- [ ] `CORS_ORIGIN` configurado correctamente (dominio exacto o `*`)
- [ ] Migraciones ejecutadas en Supabase (001_init.sql + 002_sessions_and_restrictions.sql)
- [ ] Seed ejecutado (usuario admin / robles2026)
- [ ] Contraseña de admin cambiada al primer login
- [ ] Backups automáticos verificados en Supabase
- [ ] HTTPS funcionando (Hostinger lo da gratis con Let's Encrypt)
- [ ] Logs accesibles

---

## 🔧 SOLUCIÓN DE PROBLEMAS COMUNES

| Error | Solución |
|-------|----------|
| `ECONNREFUSED` a BD | Verifica `DATABASE_URL`, password, y que Supabase acepte conexiones |
| `JWT_SECRET` error | Debe tener >32 chars, genera uno nuevo |
| `CORS` error en frontend | Verifica `CORS_ORIGIN` en backend coincida con tu dominio |
| Build falla en GitHub | Revisa que `package-lock.json` esté commiteado |
| FTP deploy falla | Verifica credenciales, directorio remoto, y cuota de disco |
| App no inicia en Hostinger | Revisa logs, puerto `PORT` (Hostinger lo asigna via env var), archivo de inicio |

---

## 📞 SOPORTE

- Documentación del proyecto: `docs/`
- Issues: GitHub Issues del repo
- Hostinger Support: Chat 24/7 en panel
- Supabase Support: Dashboard → Help

---

**¡Éxito con el despliegue! 🎉**