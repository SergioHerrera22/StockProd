# Plan técnico integral — StockProd

**Rama:** `hardening/stockprod-next-level`  
**Base:** `main` en `b39fe5dd1a6e84db9c016273a22dcb254b812df7`  
**Estrategia:** implementación integrada, por etapas verificables.  
**Regla principal:** preservar `main`, el esquema y todos los datos de negocio existentes.

## 1. Objetivo y límites

Llevar StockProd a un nivel de robustez operativa para depósito central y sucursales, priorizando integridad de stock, trazabilidad, seguridad, continuidad ante fallos y rendimiento medido.

Se conserva la arquitectura actual React + TypeScript + Vite, Express + TypeScript y PostgreSQL. PostgreSQL continúa siendo la única fuente de verdad. La aplicación permanece online-first: IndexedDB, si se usa, será caché de lectura y nunca autoridad para confirmar movimientos. No se incorporan microservicios ni una cola de escrituras offline.

## 2. Salvaguardas de datos y despliegue

- No ejecutar migraciones contra producción durante desarrollo o CI.
- No borrar, truncar, recrear ni recalcular masivamente tablas de negocio.
- Las migraciones serán aditivas, con valores por defecto compatibles y estrategia de rollback documentada cuando sea viable.
- Antes de cualquier migración productiva: backup verificable, ensayo sobre copia reciente, revisión del SQL y ventana de despliegue.
- Los tests usarán bases aisladas y datos sintéticos.
- No desplegar desde esta rama. El despliegue productivo seguirá restringido a `main`.
- No fusionar hasta pasar typecheck, build, tests de integración, pruebas de concurrencia y revisión del diff.

## 3. Etapas técnicas

### Etapa A — Integridad transaccional y seguridad (máxima prioridad)

1. **Idempotencia durable**
   - Vincular clave a usuario, método, ruta y hash canónico del payload.
   - Evitar que una operación confirmada quede sin respuesta idempotente persistida.
   - Definir estados PENDING/COMPLETED/RETRYABLE con expiración y recuperación de pendientes abandonadas.
   - La reserva de clave y la operación de negocio deben tener garantías transaccionales compatibles; no simular atomicidad con escrituras asíncronas `void query`.
   - Reintentos simultáneos: esperar/pollear de forma acotada o devolver conflicto recuperable con Retry-After; nunca ejecutar dos veces.

2. **Secretos y autenticación**
   - Rechazar arranque en producción si JWT_SECRET falta, es débil o coincide con el secreto de desarrollo.
   - Revisar cookies/tokens, expiración, revocación de sesiones y rate limiting de login.
   - CORS por allowlist explícita en producción.
   - No imprimir secretos ni credenciales.
   - Verificar credenciales iniciales documentadas y exigir cambio antes de operar.

3. **Migraciones**
   - Ejecutar cada migración con un único PoolClient: BEGIN, SQL, registro en schema_migrations y COMMIT en la misma conexión.
   - ROLLBACK y release garantizados en finally.
   - Advisory lock para impedir dos migradores simultáneos.
   - Validar nombres/orden y checksum de migraciones ya aplicadas; nunca reejecutar SQL alterado silenciosamente.

4. **Segregación de funciones**
   - Revisar cada flujo de alta+confirmación, aprobación, recepción, ajustes, devoluciones y anulaciones.
   - No permitir bypass de reglas por flags internos que puedan activarse desde rutas normales.
   - Excepciones administrativas explícitas, con permiso, motivo y auditoría.

### Etapa B — Flujos de inventario

1. **Transferencias y recepción parcial**
   - Permitir recepciones acumulativas por artículo y múltiples eventos de recepción.
   - Registrar actor, timestamp, cantidad, observaciones y evidencia por evento.
   - Nunca volver a contabilizar cantidades ya recibidas.
   - Separar recepción física de conciliación de diferencias.
   - Estados explícitos: EN_TRANSITO, RECEPCION_PARCIAL, RECIBIDO, DIFERENCIA_PENDIENTE y DIFERENCIA_RESUELTA (ajustar a compatibilidad del modelo actual).
   - Resolver faltantes/sobrantes solo mediante el flujo autorizado y auditado.

2. **Entradas y costos**
   - Mantener el registro histórico de costos por entrada/proveedor.
   - Definir explícitamente costo último, costo promedio ponderado y costo de reposición; no cambiar la valorización actual sin decisión contable.
   - Validar cantidades, proveedor, ubicación, duplicados e importes antes de confirmar.
   - Evitar que una entrada duplicada incremente stock ante reintentos.

3. **Reservas y entregas**
   - Pruebas de doble consumo, doble confirmación, expiración, concurrencia y disponibilidad cambiante.
   - Mantener bloqueos deterministas y transacciones actuales donde sean correctos.
   - Una reserva consumida/liberada no puede volver a consumirse.
   - Las operaciones confirmadas se corrigen mediante movimientos compensatorios auditados, no edición o borrado.

4. **Conteos**
   - Preservar snapshot, bloqueo por movimientos posteriores y control de reservas activas.
   - Probar carreras entre conteo, ventas, transferencias y reservas.
   - Verificar que diferencias se apliquen solo con aprobación válida y sin autoaprobación.

### Etapa C — Datos, permisos y rendimiento

- Constraints e índices únicos en base para códigos/barcodes normalizados, después de detectar y resolver duplicados existentes con informe; nunca borrar duplicados automáticamente.
- Índices compuestos basados en filtros reales y EXPLAIN (ANALYZE, BUFFERS).
- Medir latencia y consultas de autenticación; reducir round-trips sin quitar revocación ni autorización.
- Dashboard: paginar movimientos, revisar consultas paralelas/agregaciones y cachear solo indicadores no críticos con TTL corto.
- Permisos backend como autoridad; matriz de pruebas por rol, acción y ubicación.
- Validar límites de ubicación en cada endpoint y evitar filtraciones entre sucursales.
- Observabilidad estructurada: request ID, actor, operación, entidad, duración y resultado; no registrar secretos ni datos sensibles innecesarios.

### Etapa D — UX operativa y capacidades avanzadas

- Búsqueda rápida por código, EAN, descripción y proveedor, con normalización consistente.
- Alertas accionables de stock disponible, reservado, en tránsito, bajo mínimo y sin stock.
- Reposición sugerida basada en consumo histórico, plazo de proveedor y stock de seguridad; mostrar supuestos y permitir revisión humana.
- Trazabilidad por producto y ubicación: movimientos, reservas, entradas, transferencias, conteos y ajustes.
- Escaneo de códigos y captura asistida.
- IA para identificar productos desde foto solo como asistente: devolver candidatos y fuentes, requerir confirmación humana, no crear productos ni alterar stock automáticamente.
- Métricas de operación: quiebres, diferencias, rotación, exactitud de inventario, tiempos de recepción y cumplimiento de reposición.

## 4. Matriz de pruebas obligatoria

- Idempotencia: misma clave/mismo body, misma clave/body distinto, usuarios distintos, dos requests simultáneos, caída después del commit, clave PENDING abandonada.
- Transferencias: recepción total, parcial en varias tandas, sobrante, faltante, reintento, dos receptores concurrentes, conciliación autorizada.
- Entradas: alta, aprobación, confirmación, reintento de confirmación, proveedor inactivo, costos y rollback.
- Reservas/entregas: doble consumo, vencimiento, stock insuficiente, dos entregas concurrentes, reintentos.
- Conteos: movimiento concurrente, reserva activa, aprobación cruzada, aplicación repetida.
- Seguridad: JWT default en producción, CORS no autorizado, login abusivo, sesión revocada, permisos y scope por ubicación.
- Migraciones: base vacía, base con esquema/datos actuales, ejecución repetida, dos procesos migrando, fallo intermedio y rollback.
- Frontend: build, rutas críticas, manejo de 401/403/409/500 y reintentos de red.

## 5. Criterios de aceptación

- Ningún movimiento de stock se duplica por reintento.
- No se pierde una recepción parcial ni se bloquea su continuación.
- Toda modificación de stock deja movimiento y auditoría correlacionables.
- No hay autoaprobación fuera de excepciones explícitas y auditadas.
- Los roles no pueden operar fuera de sus ubicaciones autorizadas.
- Las migraciones no ejecutan escrituras parciales ni alteran datos existentes inesperadamente.
- CI compila frontend/backend y ejecuta suites aisladas de regresión y concurrencia.
- La rama no despliega a producción y `main` permanece intacta hasta aprobación expresa.

## 6. Orden de ejecución

1. Estabilizar CI, migrador y configuración de seguridad.
2. Corregir idempotencia con pruebas de caída/concurrencia.
3. Rediseñar recepción parcial acumulativa y migración compatible.
4. Completar pruebas de entradas, reservas, entregas y conteos.
5. Endurecer constraints, permisos, consultas y observabilidad.
6. Implementar mejoras UX/analítica/IA detrás de controles y feature flags.
7. Ejecutar regresión integral, revisar diff y abrir PR draft hacia `main`.
