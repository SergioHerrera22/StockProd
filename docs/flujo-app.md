# Flujo general de la aplicación — Robles Stock

Documento para armar el diagrama: **tareas por hacer y decisiones que se toman según el resultado**.
Leyenda: 🔲 tarea a realizar · ◇ decisión según cómo salió la anterior · 🔔 aviso/salida automática del sistema · ⏱ lo hace el sistema solo, sin que nadie lo pida

---

## 1. Qué hace la aplicación en una frase

Cada sucursal maneja su propio stock; todos los movimientos (compras, transferencias, entregas al cliente, inventarios) modifican el stock central de manera controlada y quedan registrados con quién, cuándo y por qué.

**Cómo entra la gente:** hay tres niveles: vendedor (opera su sucursal), encargado (además corrige, anula, aprueba) y administrador (además configura usuarios, sucursales y ve todo el historial). Si a un usuario se le marca la casilla "restringir a su ubicación", solo puede operar su sucursal aunque vea el resto.

---

## 2. Entrar al sistema

1. 🔲 Escribir usuario y contraseña.
2. ◇ ¿Contraseña correcta y usuario habilitado?
   - **No** → se registra el intento fallido con el motivo y vuelve a la pantalla de login.
   - **Sí** → el sistema lo deja entrar y registra su sesión.
3. Mientras usa la app, cada mensaje al sistema lleva su "ticket" de sesión.
   ◇ ¿Pasó 30 minutos sin tocar nada? → la sesión se cierra sola por inactividad.
4. 🔲 Cerrar sesión manualmente, o el administrador puede cerrarle la sesión a alguien.
5. 🔲 Cambiar la contraseña propia (mínimo 6 caracteres).

---

## 3. Configurar el sistema — solo el administrador

1. 🔲 Crear o editar **sucursales/depósitos** (código, nombre, tipo, activa/inactiva).
2. 🔲 Crear o editar **usuarios**: nombre de usuario, rol, ubicación habitual, casilla "restringir a su ubicación".
3. 🔲 Resetear la contraseña de alguien si la olvidó.
4. 🔲 Dar **permisos especiales por sucursal**: a un usuario se le puede habilitar una funcionalidad puntual solo en una sucursal (con vencimiento opcional).
5. ◇ ¿El usuario intenta algo que su rol no permite o en una sucursal que no es la suya? → el sistema lo bloquea; el que consulta información la ve igual de global.

---

## 4. Productos

Actor: encargado o administrador cargan/editan; todos consultan.

**Dar de alta un producto:**
1. 🔲 Cargar código, nombre, categoría, unidad (unidad/litro/kilo/metro), costo, precio de venta y stock mínimo deseado.
2. ◇ ¿El código o el código de barras ya lo está usando otro producto activo? → **lo bloquea** y pide otro. Si solo el nombre se parece a otro → hace carga igual pero lo avisa.
3. ◇ ¿No tiene código de barras cargado? → el sistema **genera uno automáticamente** (formato de etiqueta EAN-13, único, para imprimir y escanear).
4. ◇ ¿Tiene una lista larga (carga en bloque)? → importa una planilla de hasta 5.000 productos, acomoda los datos raros de Excel, crea las categorías que falten y devuelve informe línea por línea.
5. **Dar de baja un producto:** nunca se borra físicamente; se marca inactivo y todo el historial queda (protección porque hay movimientos viejos que lo mencionan).

**Categorías:** se crean al cargar productos o a mano; ◇ una categoría con productos asignados no se puede eliminar.

---

## 5. Entradas de mercadería (compras, devoluciones a favor)

Actor: carga cualquier operador; confirmar puede cualquiera según reglas y jerarquía.

1. 🔲 **Cargar la entrada:** tipo (compra / devolución / otro), sucursal que recibe, productos y cantidades. Queda en **BORRADOR** con su número correlativo.
2. ◇ **Chequeo de regla configurable:** ¿la operación es grande (monto/cantidad) o la carga un rol menor?
   - **Sí** → el sistema pide **aprobación de un encargado**: queda en borrador y aparece en la lista de pendientes de aprobación. 🔔 El sistema avisa.
   - **No** → se confirma directo.
3. ◇ **Confirmar (o aprobar):** re-chequea reglas.
   - ◇ ¿Quiere confirmar un vendedor pero la operación exigía encargado? → lo bloquea.
   - **OK:** mercadería suma al stock de esa sucursal; si un ítem trae costo y el producto no tenía, le fija ese costo.
   - Se marca CONFIRMADO (significa "recibido") y la aprobación queda registrada como resuelta.
4. ◇ **Anular:**
   - ◇ ¿Estaba confirmada? → **necesita doble autorización**: el encargado/administrador que la anula debe ser OTRA persona distinta. La anulación saca del stock la mercadería que había entrado, ítem por ítem, y avisa al administrador como alerta.
   - ◇ ¿Estaba solo en borrador? → anula sin tocar nada (nunca entró).

---

## 6. Transferencias entre sucursales

Actor: cualquiera puede crear si involucra su sucursal (origen o destino); recibe solo el personal de la sucursal destino.

1. 🔲 **Crear:** origen, destino, productos y cantidades.
2. ◇ **Chequeo de reglas (grande / rol vendedor):**
   - Pide aprobación → queda en borrador sin descontar nada y espera al encargado. Si no → despacha directo.
3. 🔲 **Despachar:** la mercadería sale de la sucursal origen (se reserva y descuenta al mismo tiempo, para que nadie la use mientras va en viaje). Estado **EN TRÁNSITO** (aún no suma al destino).
4. 🔲 **Recibir (el personal de destino):**
   - Informa cuánto llegó de cada producto (puede ser menos).
   - ◇ ¿Llegó todo? → estado **RECIBIDO** y suma todo al destino.
   - ◇ ¿Llegó de menos? → estado **RECIBIDO CON DIFERENCIA**, suma lo que llegó, el faltante queda pendiente de llegar más tarde.
   - 🔲 Opcional: otra persona **verifica** la recepción desde el detalle.
5. ◇ **Anular:**
   - ◇ ¿Estaba despachada o recibida? → doble autorización + devuelve al origen lo que no llegó (`enviado − recibido` por ítem) + deja en alerta al administrador.
   - ◇ ¿Estaba solo en borrador/rechazada? → se anula limpia.

---

## 7. Entregas al cliente

Actor: cualquier vendedor de la sucursal (incluso el que cargó el pedido puede confirmarlo).

1. 🔲 **Cargar borrador:** sucursal de salida, productos con cantidad a entregar (y opcionalmente la cantidad facturada, que puede ser mayor). Número correlativo.
2. ◇ **Confirmar → ¿el stock disponible de la sucursal alcanza para todo el pedido?** (El sistema considera reservado lo de otros pendientes, no el stock total "en papel").
   - **SÍ — alcanza todo:** entrega todo de una vez → estado **CONFIRMADO**. Se descuenta el stock y se imprime el **comprobante con código de barras** del número de entrega y firmas de quien entrega/recibe.
   - **NO — falta algo:**
     1. ◇ ¿Existe el faltante en **otras sucursales**?
        - Está en alguna → el vendedor decide **de qué sucursal sale y cuánto** (el sistema propone la que tiene más, pero se puede elegir). Entonces:
          a. 🔲 Se entrega lo que hay acá (se descuenta).
          b. 🔲 **El resto se reserva automáticamente en cada sucursal destino** — el stock queda comprometido para este cliente; nadie más lo puede usar durante 48 horas.
          c. 🔲 Se genera **una orden de retiro por cada sucursal**, cada una con su número y código de barras para que el cliente retire.
          d. Estado **PARCIAL** — el comprobante imprime: facturado / entregado aquí / ⏳ pendientes por sucursal con su código de barras / y, si quedó algo imposible de derivar, la deuda pendiente visible.
        - No está en ningún lado → lo faltante queda como **"pendiente sin derivar"**: el sistema lo muestra en el comprobante y 🔔 crea un aviso para encargados. La entrega se hace con lo que había; después se recupera (paso 4).
   - ◇ ¿Un pedido completo sin stock en ninguna sucursal? → el sistema **no deja confirmar**: dice que hay que ajustar o quitar ese ítem del borrador.
3. 🔒 **¿Quién entrega el resto?** solo el personal de la sucursal de retiro puede recibir/concluir la orden de retiro. **No existe el rechazo en destino**: cuando se confirmó la entrega, la reserva ya se hizo automática.
4. ◇ **¿Hay deuda pendiente sin derivar y LLEGA stock nuevo a otra sucursal?** → el encargado usa **🔄 Re-derivar faltantes**: el sistema recalcula lo que realmente queda debiendo y, si ya hay donde derivarlo, genera las nuevas órdenes de retiro.
5. ◇ **Anular entrega** (encargado/administrador, obligatorio motivo): se cancelan también las órdenes de retiro pendientes y se devuelve al stock **exactamente lo que salió de verdad** (anular una entrega a medias NO devuelve lo que nunca salió).

---

## 8. Retiros en sucursal (para el cliente que debe regresar por lo faltante)

Actor: personal de la sucursal de retiro.

1. Llega el cliente con la **orden de retiro** (código de barras) o se busca por lista.
2. 🔲 **Escaneo:** el estado pasa a EN PREPARACIÓN → el staff arma → LISTA PARA RETIRO.
3. ◇ **Entrega final (personal de esa sucursal):** registra cuánto retira el cliente.
   - ◇ ¿Retira todo? → orden **ENTREGADA** y se descuenta esa mercadería del stock de la sucursal.
   - ◇ ¿Retira solo parte? → orden **PARCIAL** — descuenta lo retirado y el resto sigue esperando otro día.
4. ◇ **Cancelar** (cliente nunca viene / se arrepiente): el stock reservado **vuelve a estar disponible** para todos.
5. ⏱ **Vencimiento automático:** a las 40 horas de sin retiro el sistema avisa; a las **48 horas se cancela sola** y libera el stock (queda en historial).

---

## 9. Inventarios (conteos y corrección de stock)

Actor: encargado crea y aplica; vendedor solo si las reglas lo permiten.

1. 🔲 **Crear conteo:** el sistema **toma una foto del stock** (estado actual, protegida con firma digital), lista todos los productos con su cantidad "según sistema", estado **ABIERTO**.
2. 🔲 **Contar:** se anota lo contado por producto. Se puede guardar progresivamente y contar solo una lista filtrada.
3. ◇ **Aplicar** (pide motivo; el que aplica no puede ser quien creó el conteo):
   - ◇ **Reglas de negocio:** ¿el conteo toca muchas líneas/muchos ajustes o lo aplica un vendedor? → sin aplicar nada, lo manda a **aprobación**. Si no → aplica.
   - 🔲 Por cada producto con diferencia: ajusta el stock al valor real contado (suma si sobró, resta si faltó) y deja movimientos de ajuste con el motivo.
   - El sistema saca otra **foto del stock final** (firma el estado post-ajuste) → estado **APLICADO**.
4. ◇ **Anular:** si era solo ABIERTO, tranquilo; si ya estaba APLICADO, exige doble autorización y avisa al administrador. **Ojo:** anular un inventario ya aplicado NO deshace los ajustes (ese stock ya cambió con su historia).

---

## 10. Reglas de negocio y aprobaciones (el "control central")

Este bloque en la prioridad del diagrama: todos los flujos anteriores pasan por acá antes de ejecutar.

1. El administrador **define reglas** del tipo: "si la cantidad supera X / el valor supera Y / lo cargó un vendedor" → **exigir aprobación**. Aplican por módulo (compras, transferencias, entregas, inventarios, anulaciones).
2. ◇ Cada vez que alguien intenta hacer una operación, el sistema evalúa:
   - **Pasa** → se ejecuta normal.
   - **Pide aprobación:** el documento queda parado (borrador/abierto, sin tocar stock) y entra a la cola de **pendientes de aprobación** con vencimiento de 48 horas.
3. ◇ El encargado/administrador la revisa:
   - **Aprueba** → se ejecuta la operación completa (en ese momento sí se mueve el stock).
   - **Rechaza** → el documento queda anulado, sin efectos.
4. ◇ Si un vendedor intenta lo que requiere jerarquía → lo bloquea y advierte.
5. ⏱ Vencimiento: la solicitud que nadie aprueba en 48 horas se marca EXPIRADA.
6. 🔔 **Anomalías a vigilar:** el sistema levanta alertas cuando pasa umbrales: transferencias más de 24 h en viaje, pedidos en tránsito, anulación de muchos documentos por el mismo usuario en un día.

---

## 11. Avisos automáticos (alertas y rutinas)

⏱ El sistema solo, cada **15 minutos**:

1. **Libera stock reservado vencido** (el stock no queda retenido para siempre).
2. **Cancela órdenes de retiro vencidas** (48 h) y libera su mercadería.
3. **Revisa y avisa:**
   - Transferencias varadas más de 24 h en tránsito → aviso a encargados (48 h = crítico).
   - Retiros a punto de vencer (40 h).
   - Productos bajo su stock mínimo.
   - Anomalias de anulaciones → solo administrador.
4. ◇ Ciclo de cada aviso: **pendiente → revisado (visto) → resuelto / descartado**. El mismo aviso no se duplica hasta resolverse.

---

## 12. Control de integridad (conciliación)

Actor: administrador/encargado lo corren cuando quieren revisar.

1. 🔲 "Ejecutar conciliación" — el sistema revisa 5 cosas y guarda el resultado:
   - ◇ ¿El stock real del sistema coincide con la suma de todos los movimientos? → No = posible error crítico.
   - ◇ ¿Toda transferencia en tránsito tiene su salida registrada? → No = error crítico.
   - ¿Hay stock negativo? → error crítico.
   - ¿Hay movimientos que no corresponden a ningún documento? → advertencia.
   - ¿Hay retiros olvidados de más de 48 h? → advertencia.
2. 🔲 Paralelo: cada cambio de estado de documentos guarda una **versión histórica** del documento (qué miraba exactamente en ese momento).

---

## 13. Consultar (todo solo lectura)

- **Dashboard:** tarjetas con valor del inventario, productos bajo mínimo, sin stock, entradas/salidas del día, transferencias en tránsito y gráfico de los últimos 7–90 días.
- **Stock:** saldo total y por sucursal de cada producto, con filtros bajo/sin stock.
- **Movimientos:** libro histórico completo: cada producto, de dónde salió/llegó, antes y después de cantidad, quien lo hizo y por qué.
- **Reportes:** stock valorizado, entregas por sucursal, movimientos por usuario, diferencias de inventarios, transferencias en tránsito, productos sin costo cargado.
- **Auditoría (solo admin):** todo lo que pasó, acción por acción, usuario, IP y datos del momento.

---

## 14. El hilo que une todo (para el diagrama central)

```
                 PRODUCTOS (con categoría y código de barras)
                                  │
        sucursal A                │                sucursal B
      stock actual ───────────────┼────────────── stock actual
            │                     │                    │
  COMPRAS: entra mercadería      │                    │
            │                     │                    │
  TRANSFERENCIAS: sale de A  ─────┼─── viaja ─────►    │ entra en B
            │                                          │
  ENTREGAS: sale de A ── falta? ──► se reserva en B ───┼─► orden de retiro ──► sale de B
            │                                          │
  INVENTARIOS: se corrigen diferencias en cualquier sucursal
            │
            ▼
   Todo el stock termina en el "libro mayor" de movimientos
   (cada cambio: cuánto, quién, cuándo, motivo) — nada se puede perder
```

**Regla de oro para el diagrama:** el stock solo cambia si el movimiento viene de uno de los 4 negocios (compra / transferencia / entrega / inventario) y pasó el control de reglas + quedó escrito en la auditoría. Nada toca el stock por fuera de esa puerta.
