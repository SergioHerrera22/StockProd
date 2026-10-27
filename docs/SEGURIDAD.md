# 🔒 Seguridad — Robles Stock Pro

**Objetivo:** que la web no sirva de puerta de entrada hacia las PCs de la empresa.
Toda barrera aplicada aquí funciona aunque el navegador de una sucursal no esté
actualizado o un empleado caiga en un phishing.

---

## 1. Protección ya aplicada dentro de la app (automática)

| Barrera | Qué bloquea | Dónde |
|---|---|---|
| CSP estricta | Scripts/estilos que no vienen de la propia página (el tipo de ataque XSS que roba la sesión del TPV desde la web) | `backend/src/middleware/security.ts` |
| `frame-ancestors none` + `X-Frame-Options: DENY` | Que otra web "viste" nuestra página encima de la suya para robar clics (clickjacking) | idem |
| HSTS | Conexiones HTTP sin cifrar (fuerza HTTPS siempre) | idem |
| `Permissions-Policy` | La página solo puede usar geolocalización y cámara; micro, pago, USB bloqueados | idem |
| `Referrer-Policy` | No le pasa URLs (con tokens) a sitios externos | idem |
| Rate limiting API | 600 pedidos / 15 min por IP — freno contra abuso/DoS | idem |
| Rate limiting login | **10 intentos FALLIDOS / 15 min por IP** → `429`. Los logins correctos no consumen cuota (el NAT de la sucursal no se bloquea) | `auth.routes.ts` |
| Límite de JSON | 1 MB por pedido — payloads gigantes no agotan memoria | `app.ts` |
| zod 4 + body-parser 1.20.9 | `npm audit` limpio (0 vulnerabilidades; antes había 2 high: DoS por trailing bytes y agotamiento de memoria) | `backend/package.json` |
| Sesiones server-side | JWT revocable (logout real), expira, timeout por inactividad + cada pedido revalida el rol/estado del usuario | `auth.ts`, `sessions` |
| Auditoría | Cada login fallido queda registrado con usuario, IP y motivo | `audit.service` |

**Server ya desplegado necesita `npm ci` + Restart** luego de subir el nuevo ZIP.

> ℹ️ La sesión se guarda en `localStorage` del navegador (estándar de SPAs).
> El CSP bloquea el vector típico de robo; no confíes la cuenta admin en PCs
> compartidas con el público: usá usuarios propios por empleado.

---

## 2. Qué hacer en el panel de Hostinger (5 minutos, lo tenés que hacer vos)

1. **WAF del hosting**: hPanel → *Advanced → Security (o "Malware/WAF")* → activar
   **Web Application Firewall**. Intercepta explots antes de llegar a Node.
2. **TLS**: verificar SSL está activo en el dominio (Let's Encrypt, gratis).
3. **Backups de BD**: Supabase ya hace backups automáticos; revisá que el plan
   tenga la retención que esperás. `backups/` local con `scripts/backup.ps1`.
4. **(Opcional, potente)** poner **Cloudflare (plan gratis)** delante del dominio:
   WAF + DDoS + cache en todos los static. DNS del subdominio apuntaría a
   Cloudflare con proxy naranja.

---

## 3. Checklist para las PCs de las sucursales (medida importante en Windows)

La app no puede proteger una PC que est Windows desactualizado o el empleado
instala lo que sea. Estas acciones son de la oficional, no del código:

**Windows**
- [ ] Corta: actualizar Windows en automático (Settings → Update)
- [ ] Defender **activado** con Fire Office activo (por defecto lo está)
- [ ] Cuentas de trabajo **sin permisos de administrador** (admin separado solo
       para instalaciones)
- [ ] Bloqueo de pantalla a los 5 min (esto también protege la sesión del
       sistema logueado si se van y alguien se sienta en la PC)

**Navegador (Chrome/Edge)**
- [ ] Actualizar navegador automático (viene por defecto)
- [ ] Añadir la página a favoritos y **no** descargar/instalar extensiones raras
- [ ] SmartScreen habilitado (avisa al descargar ejecutables)

**Contraseñas (URGENTE — ya estuvieron en textos de guías)**
- [ ] Cambiar la contraseña del usuario **admin** (`robles2026` era el default
       documentado — si alguien la lee, tiene acceso a todo el stock)
- [ ] Los usuarios que NO son admin reciben su cuenta con contraseña propia
- [ ] Google/FB/etc con "Gemelo" cada vez que se pidan cambios de rol en la app

---

## 4. Credenciales expuestas y rotación plan

`GUIA_DESPLIEGUE_HOSTINGER.md` tuvo **contraseña de Supabase y JWT Secret
publicados** en el repo, y ese default de admin hecho y derecho. Ruta:

1. Cambiar contraseña admin desde ya (Settings de usuario en la app)
2. En Supabase: *Settings → Database → Reset password* (genera token nuevo,
   se actualiza `DATABASE_URL` en `backend/.env` y en panel de Hostinger → Restart)
3. Rotar después JWT_SECRET: en panel de Hostinger cambiar el valor → **todas
   las sesiones se invalidan de golpe** (los empleados tienen que volver a
   loguear; es lo único que se rompe).

---

## 5. Vulnerabilidades restantes conocidas (moderada / dev)

| Paquete Severidad Impacto Acción |
|---|---|
| `vite`/`esbuild` | moderada | solo entorno **dev** (servidor local), no llega al servidor embebido | actualizar cuando toque un upgrade de build |
| `react-router-dom` 6.x | moderada | open-redirect; esta app **no usa SSR ni redirects externos** | saltar a v7 al hacer upgrade de React/servidor |

No bloquean la producción ni exponen nada en producción; queda anotado para una
próxima actualización de dependencias.

---

## 6. Cómo probar la defensa (ya validado localmente)

```
HEALTH       200  {"status":"ok","db":"ok","time":"..."}  ← sin datos internos
CSP          default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
             img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'
             object-src 'none'; base-uri 'self'; form-action 'self';
             frame-ancestors 'none'; upgrade-insecure-requests
X-Frame      DENY
HSTS         max-age=15552000; includeSubDomains
Perm-Policy  geolocation=(self), camera=(self), microphone=(), payment=(), usb=()
LOGIN OK     admin → token normal (zod4 no rompió el flujo)
BRUTE FORCE  10×401 → 429 desde el intento 11  ✅ bloqueado
```

**Sobre la carpeta de test:** el comando que corrió el smoke test de fuerza
bruta dejó ~10 entradas `LOGIN_FAILED` ("usuario inexistente") en la tabla
`audit_log` de Supabase con el usuario ficticio `xuser_fuerzabruta_test`.
No son un incidente: se puede filtrar/borrar de la vista de auditoría.
