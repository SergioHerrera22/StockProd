# 📦 Robles Stock PRO

**Sistema Integral de Stock — Robles Pinturerías**

Aplicación web profesional para administrar el stock de las **3 sucursales + depósito general**.
Construida desde cero, **independiente de Tiempo Gestión** (las ventas siguen allá; las salidas se
registran aquí al momento de verificar y entregar la mercadería).

---

## ⚡ Inicio rápido

```bash
npm run setup      # instala dependencias + crea base de datos + datos iniciales
npm run dev        # modo desarrollo: API :4000 + frontend :5173
# — o en producción —
npm run build && npm start   # todo en http://localhost:4000
```

También: doble clic en **`Iniciar Robles Stock PRO.bat`**.

> **Usuario inicial:** `admin` / `robles2026` → **cambiala al primer ingreso**.

📚 Documentación: [Instalación](docs/INSTALACION.md) · [Despliegue](docs/DESPLIEGUE.md) · [Backups](docs/BACKUPS.md)

---

## 🧱 Tecnología

| Capa | stack |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS |
| Backend | Node.js + Express + TypeScript, API REST por módulos |
| Base de datos | PostgreSQL (migraciones idempotentes) |
| Seguridad | JWT + bcrypt, permisos por rol validados en el backend |
| Integridad | Transacciones + row locks: ningún descuento parcial ni saldos negativos |

### Estructura

```
robles-stock-pro/
├── backend/
│   ├── migrations/           SQL de esquema
│   ├── scripts/              setup-db / migrate / seed
│   ├── tests/smoke.mjs       41 pruebas end-to-end
│   └── src/
│       ├── config/ db/ lib/ middleware/   infraestructura
│       ├── services/         motor de stock transaccional, numeración, auditoría
│       └── modules/          auth, users, locations, products, stock,
│                             deliveries, entries, transfers, counts,
│                             movements, dashboard, reports, audit
├── frontend/src/
│   ├── components/           UI reutilizable, DataTable, gráficos, escáner
│   ├── pages/                una página por módulo
│   ├── lib/                  cliente API, formato, permisos
│   └── store/                sesión (zustand)
└── docs/                     instalación, despliegue y backups
```

---

## 👥 Roles

| Rol | Puede |
|---|---|
| **Administrador** | Todo: usuarios, ubicaciones, auditoría, anular documentos |
| **Encargado** | Productos, entradas, transferencias, inventarios, reportes, ajustes |
| **Empleado** | **Entregas de mercadería**, consulta de stock/productos/movimientos |

Cada usuario puede tener una **ubicación habitual** (precarga sus operaciones).

---

## 🔄 Módulos y reglas de negocio

### Entregas de mercadería (módulo central)
1. La venta se hace en **Tiempo Gestión** (no se toca, no se integra, no descuenta nada).
2. El empleado abre *Entregas → Nueva*, elige la ubicación de salida, **escanea** (lector USB o
   cámara del teléfono) o busca los productos y carga **solo las cantidades realmente entregadas**
   (si la factura trae 8 y se entregan 5, se descuentan 5).
3. El stock **no cambia en el borrador**; al **confirmar**, una transacción única descuenta todo,
   valida disponibilidad y escribe el historial. Si algo falla, no se descuenta nada.
4. **La doble confirmación está bloqueada** (409), aun si dos usuarios confirman a la vez.
5. Número correlativo único (`E-000001`), factura de referencia opcional, comprobante imprimible.
6. Las confirmadas **no se eliminan**: anulación solo con permiso + motivo + movimientos compensatorios auditados.

### Resto de módulos
- **Productos**: alta/editar/desactivar, buscador, **detección de duplicados**, importación
  Excel/CSV con reporte de errores, exportación CSV.
- **Stock**: consulta por ubicación y consolidada, filtros *bajo stock* / *sin existencias*.
- **Entradas**: compras, devoluciones y otros ingresos; actualizan stock solo al confirmar (`I-000001`).
- **Transferencias**: origen → destino con **mercadería en tránsito**; recepción completa o **parcial
  con diferencias documentadas** (`T-000001`).
- **Inventarios físicos**: recuento por ubicación con snapshot del sistema, conteo parcial,
  aplicación de ajustes con **motivo obligatorio** y saldo anterior/posterior (`INV-000001`).
- **Movimientos**: historial central con filtros (producto, ubicación, tipo, usuario, fechas) y saldo antes/después.
- **Dashboard**: indicadores, entradas/salidas del día, comparación entre ubicaciones,
  transferencias pendientes y gráficos por período.
- **Reportes**: 9 reportes con filtros, exportación CSV e impresión.
- **Auditoría**: registro de operaciones sensibles (quién, qué, cuándo, IP).

---

## 🛡️ Seguridad

- Contraseñas con **bcrypt** (nunca en claro, nunca en el frontend).
- Permisos evaluados **en el backend en cada endpoint**; el frontend solo los refleja.
- La sesión se revalida contra la BD en cada pedido: desactivar un usuario lo expulsa al instante.
- Consultas **parametrizadas** (protección contra inyección SQL).
- `audit_logs` para logins, confirmaciones, anulaciones, ajustes y gestión de usuarios.

---

## 🧪 Verificación

```bash
npm test   # 41 checks end-to-end contra la API real
```

Cubre: permisos, entregas (borrador/confirmación/doble confirmación/stock insuficiente),
transferencias (tránsito/recepción parcial/doble recepción), inventario físico con ajustes,
consistencia del historial y dashboard/reportes.
