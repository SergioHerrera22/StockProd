# Despliegue en producción

## 1. Recomendación de arquitectura para Robles

El sistema se usa **en la red interna de las sucursales**, con ventas en Tiempo Gestión.
Se recomienda:

- **Servidor local (PC o mini-PC del depósito/local central) con PostgreSQL + API + frontend.**
  - Ventajas: latencia mínima, funciona aunque falte Internet, datos físicamente bajo control.
  - Acceso desde las 3 sucursales por la red (VPN o red privada si las sucursales no comparten LAN).
- **Hosting remoto (VPS)** solo si quieren acceso desde Internet o desde sucursales sin red propia.
  - En ese caso: HTTPS obligatorio (Caddy o Nginx + Let's Encrypt), PostgreSQL solo en localhost,
    firewall cerrado salvo 80/443.

## 2. Despliegue en servidor Windows local

1. Instalá Node.js 20+ y PostgreSQL 14+.
2. Copiá la carpeta del proyecto (sin `node_modules`).
3. `npm run setup` → crea base, migraciones, seed y `.env`.
4. `npm run build` → compila backend y frontend.
5. `npm start` (o el `.bat`) → la app queda en `http://0.0.0.0:4000`.

### Arranque automático con Windows

Creá una tarea en el Programador de tareas que ejecute, al iniciar sesión:

```
"C:\ruta\robles-stock-pro\Iniciar Robles Stock PRO.bat"
```

O mejor, instalá **NSSM** (https://nssm.cc) para correrlo como servicio de Windows:

```
nssm install RoblesStock "C:\Program Files\nodejs\node.exe" "C:\ruta\robles-stock-pro\backend\dist\index.js"
nssm set RoblesStock AppDirectory C:\ruta\robles-stock-pro\backend
nssm set RoblesStock AppEnvironmentExtra NODE_ENV=production
nssm start RoblesStock
```

### Firewall

```
netsh advfirewall firewall add rule name="Robles Stock" dir=in action=allow protocol=TCP localport=4000
```

## 3. Despliegue en VPS Linux (opcional)

```bash
# Requisitos: node 20+, postgresql, nginx o caddy
git clone <repo> /opt/robles-stock && cd /opt/robles-stock
npm run setup                 # crea BD local y .env (edita JWT_SECRET)
npm run build
NODE_ENV=production node backend/dist/index.js
```

Sistema de servicio (systemd) — `/etc/systemd/system/robles-stock.service`:

```ini
[Unit]
Description=Robles Stock
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/robles-stock/backend
Environment=NODE_ENV=production
EnvironmentFile=/opt/robles-stock/backend/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=robles

[Install]
WantedBy=multi-user.target
```

Con **Caddy** (HTTPS automático):

```
stock.tudominio.com {
    reverse_proxy localhost:4000
}
```

## 4. Checklist de seguridad en producción

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` aleatorio y único (lo genera `db:setup`)
- [ ] Contraseña del admin cambiada (y claves iniciales de cada usuario)
- [ ] PostgreSQL **sin** `trust` en conexiones remotas: usar `scram-sha-256`
- [ ] El usuario `robles_app` solo accede desde localhost
- [ ] HTTPS si la app se publica fuera de la red local (Caddy/Nginx)
- [ ] Backups programados (ver `docs/BACKUPS.md`)
- [ ] `CORS_ORIGIN` con el dominio exacto si el frontend se sirve aparte

## 5. Actualización de versiones

```bash
git pull            # o copiar los archivos nuevos
npm run build       # recompila backend + frontend
npm run db:migrate  # aplica migraciones nuevas (idempotente)
# reiniciar el servicio / proceso
```

Los datos nunca se pierden: las migraciones solo agregan estructura.
