# AGENTS.md

## Comandos / Commands

| Comando / Command | Propósito / Purpose |
|---------|---------|
| `npm run dev` | Iniciar servidor de desarrollo (HMR) / Start Vite dev server (HMR) |
| `npm run build` | Compilar para producción → `dist/` / Production build → `dist/` |
| `npm run lint` | ESLint (flat config, `.jsx` only) |
| `npm run preview` | Vista previa del build / Preview production build locally |
| `npm run deploy` | Compilar y desplegar en GitHub Pages / Build + push to GitHub Pages |

**No hay framework de tests configurado.** No inventes uno sin preguntar.
**No test framework is configured.** Do not invent one without asking.

## Despliegue / Deploy

- Desplegado en GitHub Pages en: `https://serviciosagricolashp.github.io/adminAgrofrutos/`
- El path base `/adminAgrofrutos/` está en **dos archivos** — ambos deben coincidir:
  - `vite.config.js` → `base`
  - `src/App.jsx` → `<BrowserRouter basename="/adminAgrofrutos">`

## Stack

React 19 · Vite 7 · Tailwind CSS 4 · Firebase (Firestore + Auth) · ag-grid · React Router 7 · ExcelJS (lazy) · html-to-image · ESLint flat config

- **Solo JavaScript** (no TypeScript).
- **React Compiler** habilitado via `babel-plugin-react-compiler`.
- Variables de entorno con prefijo `VITE_`.
- `exceljs` se importa **lazy** (`await import("exceljs")`) solo al exportar — chunk separado de ~937 KB.

## Arquitectura / Architecture

```
src/
  main.jsx              ← punto de entrada / entry point
  App.jsx               ← router (react-router-dom)
  firebase.js           ← Firebase init (Firestore db = "hpdatabase")
  Components/           ← UI compartida (Layout, Modal, ProtectedRoute, TransportsModal, WorkerEditModal, WorkerSummaryModal, CycleSummaryModal, etc.)
  screens/              ← componentes de ruta / page-level route components
                        (Dashboard, Faenas, CycleDetail, Workers, Transports, Payroll, Advances,
                         InterestLinks, Calendar, AdminConsole, MigrateWorkers, CleanupPaidWorkdays)
  contexts/             ← AuthContext, ThemeContext, CatalogsContext, CarriersContext
  services/             ← capa de datos (Firestore CRUD + caché + auditoría)
                        firestoreBase, transportsService, carriersService,
                        workersService, payrollsService, advancesService, logger
  utils/                ← helpers de dominio (rutUtils, banks, payroll, cosechaCombos,
                        agGridLocale, similarity, etc.)
```

### Auth

- Firebase Email/Password.
- Perfiles en colección `users` de Firestore (doc id = Firebase uid).
- Roles: `admin`, `supervisor` (por defecto si no hay perfil).
- `ProtectedRoute` envuelve rutas autenticadas; prop `adminOnly` restringe a admins.

### Servicios / Services

- `services/firestoreBase.js` exporta `createService(entityName, collectionName)` — factory CRUD.
- Servicios invalidan caché en memoria y escriben logs de auditoría via `services/logger.js`.
- `list()` soporta `cache: true` con TTL (60s default); `persist: true` guarda en `localStorage`.
- Para batched updates usar `writeBatch(db)` directo (chunks de 450 — el límite Firestore es 500).
- Nuevos servicios: agregar a `services/index.js` exports si son consumidos transversalmente.

### Caché aditiva

- `firestoreBase` soporta `additive: true` en `create`/`update`/`upsert`/`remove` — en vez de invalidar la entrada de caché correspondiente, la **muta in-place** (append / patch / filter). Útil cuando una colección se lista entera (sin `wheres`) y la queremos mantener fresca sin pagar el costo de re-leer todos los docs.
- `workersService` (en `services/index.js`) está envuelto para usar `additive: true` por defecto en todas las mutaciones — alta de trabajador no invalida la lista en caché.
- Helpers internos: `mergeListItem`, `removeListItem` (sólo tocan claves de caché con `wheres` vacío).

### Contexts

- Orden en `App.jsx`: `ThemeProvider` → `AuthProvider` → `CatalogsProvider` → `CarriersProvider` → `BrowserRouter`.
- `CarriersProvider` precarga transportistas; expone `carriers`, `activeCarriers`, `addCarrier`, `updateCarrier`, `softDeleteCarrier`, `restoreCarrier`.
- `CatalogsProvider` precarga tablas de lookup usadas en las pantallas.

## Convenciones / Conventions

- Componentes en PascalCase; archivos coinciden con nombre del componente.
- `Components/` usa C mayúscula (no estándar — seguirla).
- ESLint: variables sin usar empezando con `A-Z_` son ignoradas.
- `screens/` contiene lógica de rutas; data fetching en `services/`.
- Strings UI en español; identificadores en código en inglés.

## Tipos de Labor / Labor Types

Definidos en `src/screens/CycleDetail.jsx` (`LABOR_TYPES`). Cada labor tiene un campo `type` que determina columnas del grid, entrada de datos y métricas:

| Tipo / Type | Etiqueta / Label | Comportamiento del grid / Grid behavior | Forma de datos / Data shape |
|------|-------|---------------|------------|
| `main` | Pago al día | 1 columna/día, monto `$` directo | `workdays: { amount }` |
| `supervision` | Supervisión | Igual que main / Same as main | Igual / Same |
| `extra` | Adicional | Igual que main / Same as main | Igual / Same |
| `cosecha` | Cosecha | Multi-columnas por día (calidad × envase); toggle detalle/resumen | `workdays: { qualityX, containerY, qty, amount }` |
| `trato` | A trato | Multi-precio por día (`t0`, `t1`, ...); toggle `/unid` vs `/día` por tier; toggle detalle/resumen | `dayPrices: { t0: { price, mode }, t1: ... }`, `workdays: { qty, amount, tiers? }` |
| `tratoHE` | Jornadas con horas extras | Columnas: D, HE, M, S, X, `$`; toggle detalle/resumen | `workdays: { qty, overtimeHours, hasManejo, hasSupervision, extras, amount }` |

El tag `main` se renderiza como **"al día"** en métricas y tabs.

### trato — multi-precio por día

- Precios almacenados como `dayPrices[laborId][date]` = `{ t0: { price, mode }, t1: ... }`.
- Legacy `{ price, mode }` o `{ "0_0": { price, mode } }` se normaliza automáticamente al cargar.
- Workdays con tiers: `wd.tiers = { t0: { qty, amount }, t1: ... }`. Helper `getTratoTierTotals(wd)` suma todos los tiers.
- Toggle `/unid` (qty × precio) vs `/día` (precio fijo) por tier — botones segmentados.

### tratoHE

- `baseDayDefault`, `bonusManejo`, `bonusSupervision`, `overtimeRate` en la definición de labor.
- Config por día: `{ price, mode: "normal"|"overtimeOnly", isHoliday }`.
- `effectiveDayPrice` usa `||` (no `??`) para que `price: 0` herede del `baseDayDefault`.

### cosecha

- Combos = calidad × envase, almacenados como `dayPrices[laborId][date]` con claves `${x}_${y}`.
- Catálogos globales para `qualities`, `containers` — editables via ⚙ Catálogos.
- **Unidad mostrada en métricas** sale del envase del catálogo, no de un literal "kg". Helper `cosechaUnit(catalogs, containersSet)` en `utils/cosechaCombos.js`: si todos los workdays del scope usan el mismo envase (`Saco`, `Kilo`, `Caja`…) devuelve su label; si hay mezcla cae a `"Unid."`. Aplica en Calendar, CycleSummaryModal, WorkerSummaryModal y los comprobantes de Payroll.
- **Unidad mostrada para trato** sale de `catalogs.tratoTypes` via `tratoTypeLabel(catalogs, labor.tratoType)` — ej. una labor a trato configurada como "Poda" muestra `4.737 poda` en vez de `4.737 trato`. Si una grilla mezcla varios `tratoType` en el mismo ciclo cae al genérico "Trato".

### Piso (bono para trato/cosecha)

Bono adicional configurable por día para trato y cosecha. Pensado para compensar a los trabajadores cuando la producción del día fue baja. Siempre **suma** al monto de producción, no lo reemplaza (no es un floor en sentido estricto).

- **Opt-in por día, sin default a nivel labor.** En el panel de Precios cada día tiene un botón discreto **"+ piso"** que solo está visible si el día no tiene piso configurado. Al click pasa a modo edición; al guardar muestra inline el monto con acciones ✎ editar / ✕ quitar. Mantiene la UI limpia: días sin piso no tienen ruido.
- **Persistencia del default por día**: `dayPrices[laborId][date].piso: number`. Helper: `getDayPiso(dayPrices, laborId, date)`, `effectivePiso(labor, dayPrices, date)` (este último solo lee el día — no hay fallback a labor).
- **Persistencia del workday**: workday separado con `comboKey: "_piso"` y `pisoOnly: true`. `qty: 0`, `amount: pisoAmount`. Un doc por (worker × date × labor). Hereda el `payrollId` como cualquier otro workday — al borrar la nómina, queda disponible nuevamente.
- **UI grilla**: la columna "P" 🪙 al final del día solo se renderiza cuando ese día tiene piso configurado en `dayPrices` **o** algún trabajador tiene un workday `pisoOnly` para ese día (computado en `daysWithPiso`). Días sin piso quedan sin columna extra. Click en el toggle crea/borra el workday `_piso` con el monto efectivo. El toggle está deshabilitado si no hay workday de producción todavía para ese (worker, date).
- **Cálculo**: total del trabajador = producción + suma de pisoAmount. Reflejado en row.total del grid, métricas de la labor, CycleSummaryModal, WorkerSummaryModal, drawer del Calendar, comprobantes de Payroll.
- **En Cobrar (CycleSummaryModal mode=cobrar)**: el piso NO se factura al cliente (es bono al trabajador). Se muestra en la tabla pero no entra al subtotal a cobrar.
- **En `aggregateWorkerAmounts`**: el monto del piso fluye naturalmente porque `wd.amount` ya carga el valor; no requiere lógica especial.

## Faenas / Ciclos / Cycles

- Jerarquía: Faena → Subfaena → Ciclo → Labors → Workdays.
- Label de ciclo = prefijo bloqueado `Faena/Subfaena/` + sufijo editable.
- Estados: `open` | `closed`. Se permiten **múltiples ciclos abiertos** por (faena, subfaena) — útil para correr varios frentes en paralelo o para "carve off" temporales.
- `CycleRow` permite **✏ Renombrar**, abrir, cerrar y eliminar.

### Importar desde otro ciclo abierto

Al crear un ciclo nuevo, si en la misma subfaena hay al menos un ciclo abierto, el form muestra una sección **"Importar desde un ciclo abierto"**. Es opt-in:

- **Ciclo origen**: select con los ciclos abiertos del ámbito (más reciente primero).
- **Labores a clonar**: checkboxes — copia config completa de cada labor seleccionada (incluyendo tratoType, modos, baseDayDefault, overtimeRate, etc.) con un nuevo `id`.
- **Días a importar**: chips toggleables con las fechas de `cycle.days[]` del origen (default todos). Definen tanto la `days[]` del nuevo ciclo como el filtro de fechas para mover workdays / copiar precios.
- **Copiar precios por día** (opcional): copia las entradas de `dayPrices` re-keadas por el nuevo `laborId` y filtradas por días seleccionados.
- **Mover workdays** (opcional, destructivo): para cada (labor seleccionada × día seleccionado), lee los workdays del origen y los re-crea en el nuevo ciclo con el nuevo `docId` (que encodea cycleId+laborId), luego borra los originales. Workdays con `payrollId` se saltan para no romper snapshots de nómina ya generadas — el usuario recibe un alert con el count de skipped.

Implementación en `submitCycle` (Faenas.jsx). El mapeo `oldLaborId → newLaborId` vive en un `Map` que sirve para re-keear tanto `dayPrices` como los `docId` de workdays movidos.

### CycleDetail — grid

- **Undo (Ctrl+Z)**: stack en memoria (`undoStackRef`), pushea cada edición de celda, revierte y re-graba en Firestore.
- **Navegación tipo Excel**: `singleClickEdit: false`. Flechas mueven el foco entre celdas; **Enter** entra a editar; al confirmar, salta a la fila siguiente (`enterNavigatesVertically*: true`).
- **Resize del grid**: barra arrastrable (`useResizableHeight` + `<ResizeHandle>`) persistida en `localStorage`. Implementado con **Pointer Events + `setPointerCapture`** sobre el handle (no listeners en window — sino ag-grid se traga los eventos). Hijos decorativos usan `pointer-events-none`.
- **Secciones colapsables** persistidas en `localStorage` para liberar espacio vertical: métricas (`cycleDetail.metricsCollapsed`), precios (`cycleDetail.pricesCollapsed`), sidebar global (`layout.sidebarOpen`).
- **Anotación por día**: click sobre el header de la fecha → modal que edita `cycle.dayNotes[date]`. Hover sobre el header muestra el texto. Compartida entre todas las labores del ciclo.
- **Trabajadores temporales**: alta sin RUT (`isTemp: true` dentro de `labor.workers`). Aparecen con badge "T" y botón "Asignar RUT" que los reemplaza por el RUT real preservando los workdays.
- **Sueldo mensual por trabajador-ciclo**: toggle "M" en la fila de la labor → guarda `monthly: true` en `labor.workers[i]`. Las celdas pasan a checkbox de asistencia (`amount: 0`, `attendanceOnly: true`); excluidos de la nómina; badge verde "M".
- **`rutToName`**: las celdas del grid muestran el nombre desde un map derivado del cache de workers, no desde el snapshot del ciclo — editar el nombre en `/workers` se refleja sin recargar.
- **Loader de workdays trato**: `ck` se deriva del docId, no del payload. 5 segmentos → `ck = parts.slice(4).join("__")`; 4 segmentos + labor trato → `"t0"`; resto → `makeComboKey(qualityX, qualityY)`.
- **Diálogos**: nunca usar `window.prompt/confirm/alert` dentro del grid — usar `<Modal>` + `<ConfirmDialog>` para mantener el estilo.
- **Trabajadores huérfanos**: un workday cuyo `workerRut` no está en `labor.workers[]` (porque el trabajador fue removido de la labor pero el workday quedó vivo) se inyecta en la grilla con badge "Huérfano" en la celda del nombre, para que se vea y se pueda corregir desde la misma vista en lugar de quedar invisible pero contando en métricas/payroll.
- **Doble click sobre la celda del RUT** abre `WorkerEditModal` para editar los datos del trabajador sin salir del ciclo. Filas temporales (`_isTemp`) y de header se ignoran.

## Transports / Transporte

- Pantalla: `src/screens/Transports.jsx` — 5 pestañas:
  1. **Transportistas** — gestión de carriers. Click en una tarjeta abre `CarrierTripsModal` con todas las vueltas del transportista (cualquier ciclo) y permite editarlas/eliminarlas via `TripEditModal` reutilizado (con input de fecha libre cuando se invoca sin lista `days`). Filtros: estado (pendiente/pagada) y rango de fechas. Las vueltas pagadas no permiten editar/eliminar (consistente con `tripsService.update`/`remove`).
  2. **Vueltas** — listado y CRUD.
  3. **Pago por faena** — selecciona ciclos activos + rango de fechas → genera un `paymentSummary` por transportista con sus vueltas pendientes.
  4. **Resúmenes / Pagos** — historial; marcar pagado, revertir, imprimir uno a uno **y también imprimir varios en lote** (botón `🖨 Imprimir varios` → modal `PrintMultipleModal` con filtros estado/fechas/transportistas/faena-subfaena y dos acciones: 🖨 imprimir todos en una ventana con `page-break-after`, o 📦 descargar ZIP con un PNG por resumen vía `jszip` + `html-to-image`). En `PaymentDetailModal` el botón **✏️ Editar precios** activa edición inline del `amount` por vuelta (optimista: actualiza state, escribe `tripsService.update` + `paymentsService.updateTotal`, rollback re-fetch en caso de error). La columna **Vehículo** está incluida en el `PrintableSummary`.
  5. **Quincenas** — agrupan varios resúmenes (`transportPayments`) en un payroll (`transportPayrolls`) para pagar en bloque. Modal **+ Nueva quincena** (`PayrollCreateModal`): elegís fechas + chips de faenas, auto-lista los transportistas que tienen vueltas sueltas (sin `paymentId`, status `pending`) en el rango — todos vienen tildados por default y se puede destildar individualmente; sección aparte para **importar resúmenes existentes sueltos** (status no pagado, sin `payrollId`) que se superpongan con el rango. Al confirmar crea un `payment` por cada carrier nuevo y llama a `transportPayrollsService.create({ paymentIds: [...nuevos, ...importados] })` que tagea cada resumen con `payrollId`. **Vista tabla** en `PayrollDetailModal`: `PrintablePayrollTable` (off-screen) renderiza `# | Transportista | Vueltas | Período | Estado | Total` + fila de totales en verde estilo Excel — capturada por `html-to-image` para los botones 📋 Copiar / 📥 PNG / 🖨 Imprimir. La tabla visible incluye columna `Acciones` (💰 Pagar / ✕ Quitar / ↶ Revertir) ocultable según el estado de la quincena.
- **Balance general** — sección en la cabecera de la pantalla: rango de fechas + filas por transportista (viajes − pagos). Bumpea `balanceVersion` al pagar/revertir para refrescar. Botón **🖨 Imprimir balance** abre ventana de impresión.
- Modal: `src/Components/TransportsModal.jsx` — usado en `CycleDetail` para asignar viajes rápidos. Incluye un sub-modal **+ Nuevo transportista** que crea un carrier inline y lo auto-selecciona junto con su primer vehículo (sin salir del modal de viajes). El selector de transportista del `TripEditModal` es un **combobox searchable** (`CarrierCombobox`) con typeahead sobre alias/nombre/aliases-de-vehículo, sección "RECIENTES" arriba (últimos 6 carriers usados en este ciclo, persistido en `localStorage` `transports.recentCarriers.{cycleId}`), navegación con flechas + Enter, y auto-select del primer (o único) vehículo del carrier elegido.
- Servicios: `services/transportsService.js` exporta `tripsService` (alias `transportsService`) y `paymentsService` (alias `transportPaymentsService`).
- Contexto: `CarriersContext` precarga transportistas; expone CRUD con soft-delete.
- Tipos de viaje: `regular` (Vuelta), `approach` (Acercamiento) — definidos en `TRIP_KINDS`.
- Tipos de transportista: `own` (Propio), `contracted` (Contratado) — definidos en `CARRIER_TYPES`.
- Trips: `{carrierId, vehicleAlias, cycleId, faenaId, subfaenaId, date, kind, qty, rate, amount, lugar, destino, personCount, notes, status, paymentId}`.
- Payments: `{carrierId, periodFrom, periodTo, tripIds[], total, status, paidAt, notes}`. Marcar como pagado pone los trips referenciados en `status: paid`.

## Trabajadores / Workers

- Pantalla: `src/screens/Workers.jsx`.
- **Búsqueda client-side sobre la lista cacheada** (única fuente de datos). Al montar la pantalla, `ensureAllForModal()` trae la lista completa via `workersService.list({ cache: true, persist: true, ttl: 2h })` — primera carga ~500-2000 reads, después gratis hasta que vence el TTL. El filtro es substring acentos-insensitive sobre nombre y RUT (sin puntos/guiones), gated por `MIN_SEARCH = 2`. Permite buscar por apellido o dígitos del RUT en cualquier posición. Antes había un flujo paralelo server-side (`searchWorkers` por prefijo ≥4 chars, debounced 250ms) — se eliminó por redundante: con la lista en memoria, el filtro client-side gana en flexibilidad sin reads extra. `searchWorkers` sigue exportado en `workersService` para autocompletes pequeños (`Advances`, `GroupSummaryModal`).
- Auto-detect badge **RUT** vs **Nombre** (basado en `detectQueryKind`: empieza con dígito → RUT).
- **Filtros opcionales** (componibles con la búsqueda): dropdown 👥 Líder (con opción "— Sin líder —" + lista única extraída del dataset completo) y chips toggle 💵 Efectivo / 🏦 Transferencia. Los filtros ignoran el gate de `MIN_SEARCH` — activar cualquiera muestra resultados aunque la query esté vacía. Al editar/eliminar/togglear banco desde la grilla, `refreshCache()` re-trae la lista para reflejar el cambio.
- Acciones por fila: 📊 Resumen, Editar, ✕. La forma de pago se muestra como **indicador informativo** (`💵 Efectivo` / `🏦 Transferencia`) — no es toggle. El cambio de banco se hace adentro de `WorkerEditModal`, que tiene un botón **🆔 Asignar Cuenta RUT** que setea Banco Estado + Cuenta RUT en un click usando el RUT del trabajador.
- Doc id = RUT. No hay campo `rut` separado en el doc.
- Bank details = `[paymentRut, accountNumber, accountType, bankCode]` (orden importante).
- `services/workersService.js` expone `findWorkerByRut`, `createWorker`, `deleteWorkerSafe`, `searchWorkers` (server-side prefix), `detectQueryKind`.

### Líder de grupo — estricto

- `worker.groupLeader` es un array (historial); `groupLeader[0]` es el líder actual.
- Lista curada en la colección **`groupLeader`** (`groupLeadersService`) — `{ name, habilitado }`. La idea es no dejar que la lista crezca con valores ad-hoc.
- Edición del trabajador: el campo es **dropdown** con líderes existentes (filtrados por `habilitado: true`) + opción "+ Crear nuevo líder" que requiere acción explícita.
- Al guardar: si el valor no está en la lista de líderes existentes y no se eligió "crear nuevo", error.
- En Payroll preview el líder es **read-only** (estrictamente lo del worker).

## Nómina / Payroll

- Pantalla: `src/screens/Payroll.jsx`. Ruta `/payroll`.
- Servicio: `services/payrollsService.js` (colección `payrolls`).
- Helpers: `utils/payroll.js` — `aggregateWorkerAmounts`, `splitBankAndCash`, `groupCashByLeader`, `validateAccountNumber`, `downloadBchileXlsx`, `downloadNominaOnlyXlsx`.

### Flujo

1. **Generar** — selector de ciclos activos agrupados por faena. Cada ciclo muestra `Pendiente` y `Pagado` calculados desde workdays. Al chequear un ciclo, debajo aparecen sus labores como chips toggleables: click excluye/incluye esa labor de la nómina. Default: todas seleccionadas. Workdays de labores excluidas quedan disponibles para una nómina futura (no se taggean). Si el usuario destilda todas las labores, el ciclo se marca con "⚠ Sin labores seleccionadas" y no aporta workdays al preview.
2. **Preview** — agrega por trabajador, cruza con `worker.bankDetails`, busca anticipos pendientes y los aplica.
   - Filtros: 🏦 Banco, 💵 Efectivo, ⚠ Datos faltantes, ⚠ Cuenta sospechosa, 👥 \<líder\>.
   - Bulk actions sobre el subset visible: incluir/excluir, → Efectivo / → Banco.
   - Columnas: Bruto (read-only), Anticipo (editable), A pagar (= bruto − anticipo, override manual), Pago (toggle banco/efectivo).
3. **Generar y guardar** — crea la nómina, etiqueta workdays con `payrollId`, marca anticipos como `applied`, y escribe un **snapshot JSON** inmutable en `payrollSnapshots/{payrollId}` que se auto-descarga.

### Snapshot JSON (`payrollSnapshots`)

- Colección separada de `payrolls` para no inflar los docs del historial.
- Lo escribe `payrollSnapshotsService` en el mismo flujo de "Generar y guardar".
- Botón **📥 JSON** en la fila del historial vuelve a bajar el archivo.
- Es la fuente que va a consumir el **portal público de trabajadores** (otra app, monorepo futuro). El schema debe considerarse contrato externo — cambiarlo coordinadamente.

### Anticipos en comprobantes

- En el resumen **individual** del comprobante (no en el resumen por grupo), si **algún** trabajador del grupo trae `advance > 0`, se renderiza una columna **Anticipo** entre los ciclos y el TOTAL.
- Filas: monto en color tierra `#b45309` con signo "−" o "—" cuando es 0.
- Subtotal: suma de anticipos del grupo, mismo formato.
- Gate: `groupHasAdvance = g.items.some((it) => Number(it.advance) > 0)` — si nadie del grupo descontó, la columna no se renderiza.
- Aplica tanto en modo "cash" (`rows`) como en modo "detail" (`rowsNoSign`).

### Anti doble pago

- Workday lleva `payrollId`, `payrollTaggedAt`, `payrollTaggedBy`, `paidAt`, `paidBy`.
- Workdays con `payrollId` se filtran del preview (ya no entran a otra nómina).
- Eliminar nómina → `untagWorkdaysFromPayroll` + `restoreAdvancesFromPayroll`. Workdays vuelven a estar disponibles.
- Marcar pagada → sello `paidAt` en los workdays. Revertir → quita `paidAt`.

### XLSX (BChile)

Generado con ExcelJS (lazy import). Cuatro hojas:

1. **Nomina** — formato BChile (RUT con DV pegado, nombre limpio sin acentos, cuenta, código banco, monto, JUV/CTD/AHB). Es la **primera hoja** porque es la que el portal del banco ingiere.
2. **Resumen** — Transferencias / Efectivo / Total general por ciclo.
3. **Transferencias** — `RUT | NOMBRE | <Ciclo1> | ... | TOTAL` con totales por ciclo.
4. **Efectivo** — agrupado por líder con paletas de color por grupo (8 paletas alternadas) y subtotales.

Botones de descarga:
- **🏦 Sólo Nómina** → `downloadNominaOnlyXlsx` (1 hoja, para subir al banco).
- **📥 XLSX completo** → 4 hojas.
- **🖨 Comprobantes efectivo** → ventana de impresión, una página por líder con tabla firmable (RUT, Nombre, Monto, Firma) + líneas de firma final.
- **🖨 Detalle de pago** → ventana de impresión más completa. Abre con un **Resumen por subfaena** (filas = subfaena, columnas `Faena | Subfaena | Con cuenta RUT | Efectivo | TOTAL`, la faena se imprime sólo en la primera fila del bloque); luego el **resumen por grupo** estructurado como 2 tablas grandes (`Con cuenta RUT` y `Otros grupos`) con columnas `Líder | Faena | TOTAL` y subtotal al pie de cada una; finalmente la tabla por líder con el detalle de producción por ciclo. En el header de cada grupo se incluye el nombre del líder con un `h1` más grande para que el inicio de cada grupo se vea claramente al imprimir.
- **Catálogos en el detalle imprimible**: los precios bajo el día y los breakdowns de celda usan labels del catálogo (no `Q1/E2` ni `/jorn.`). Para cosecha: `Premium / Saco: $1000` (o `$1000/saco` en single-combo). Para trato: `$10000/poda` (la unidad = `tratoTypeLabel`). Para `tratoHE` no se muestra precio sugerido en el header del día (el monto del día lo define la planilla). `byCombo` se indexa por clave estructural `"x_y"` y el label visible se computa al render con `comboLabel(catalogs, x, y)`.
- **paymentRut vs RUT del trabajador**: la hoja `Nomina` BChile usa **`it.paymentRut`** (de `bankDetails[0]`), no el RUT de la persona. `paymentRut` puede diferir cuando el pago va a una cuenta de un familiar; el portal del banco lo valida contra la titularidad. Preservado en `cleanItems` y en el snapshot.
- **Email default BChile**: si el trabajador no tiene email se completa con `remuneracionesis@gmail.com` (constante `BCHILE_DEFAULT_EMAIL` en `utils/payroll.js`). El banco rechaza filas sin email.
- **Identificador alfa-numérico**: la columna identificador del BChile usa `A001..A999` (zero-padded) y los nombres se ordenan alfabéticamente con `localeCompare("es", { sensitivity: "base" })`. Filas con `amount === 0` se filtran (el banco rechaza transferencias de $0).

### Historial

- Filtros: estado, mes, búsqueda. Totales (Pendiente / Pagado) en header.
- Acciones: re-descarga (sólo BChile / completo), marcar pagada, volver a pendiente, eliminar (con cascade que limpia workdays y restaura anticipos).

## Anticipos / Bonos

- Pantalla: `src/screens/Advances.jsx`. Ruta `/advances`. Nav label: "Anticipos / Bonos".
- Servicio: `services/advancesService.js` (colección `advances`).
- Una colección con discriminador `type: "anticipo" | "bono"`. **Legacy** `"adelanto"` se normaliza a `"anticipo"` al leer (vía `LEGACY_TYPE_MAP`) — no hay tipo separado. Helpers: `ADVANCE_TYPES`, `normalizeAdvanceType`, `advanceSign`, `isBono`, `advanceTypeMeta`.
- **Signo**: anticipo = `-1` (descuenta del bruto), bono = `+1` (suma al bruto). Mismo flow / lifecycle, distinto signo.
- Estados: `pending` | `partial` | `applied` | `cancelled`. `partial` = `amountPaid > 0 && amountPaid < amount` (la siguiente nómina sigue aplicando contra el saldo pendiente).
- Documento: `{type, workerRut, workerName, amount, date, note, status, amountPaid, payments[], appliedPayrollId, appliedAt, appliedBy}`.
- UI: filtros por tipo (todos / anticipo / bono), búsqueda, status. Dos botones de creación (🪙 + Anticipo, 🎁 + Bono). Cada fila muestra el badge de signo correspondiente.
- Modal de creación con `searchWorkers` para autocompletar trabajador.
- **Lock de Editar/Eliminar**: `applied` (totalmente aplicado) → ambos bloqueados. `partial` → Editar habilitado, Eliminar bloqueado.
- **"Perdonazo" de saldo en parciales**: editar un `partial` permite bajar `amount` hasta `amountPaid` para cerrar la cuenta — el status se recalcula al guardar (`newAmount ≤ amountPaid` → `applied`; `>` → sigue `partial`). El modal muestra banner con Pagado/Resta, bloquea `type` y `worker` (no se pueden reasignar pagos existentes), y valida que `newAmount ≥ amountPaid`. El doc + `payments[]` quedan intactos para auditoría.

### Integración con Nómina

- Al construir preview, `listPendingForWorkers(ruts)` carga anticipos y bonos `pending` de los trabajadores.
- Anticipos se aplican oldest-first y se cappean al bruto (no pueden dejarlo negativo); bonos se aplican siempre completos (suman al bruto).
- Fórmula del item: `amount = grossInt − anticiposTotal + bonosTotal`.
- Preview muestra columnas separadas **Bruto**, **Anticipo**, **Bono**, **A pagar**. Hint visual `↩ liquidado por anticipo` cuando `amount = 0 && advance > 0` (caso retiro con anticipo del valor total — el worker pasa a nómina como cero-neto pero los workdays/anticipos se marcan como pagados).
- Al crear nómina: `applyAdvancesToPayroll(advanceIds, payrollId)` cambia status a `applied` (para ambos tipos).
- Al eliminar nómina: `restoreAdvancesFromPayroll(advanceIds)` vuelven a `pending`.

## Bancos

- `src/utils/banks.js` define `BANKS`, `ACCOUNT_TYPES`, helpers (`bankName`, `isCashBank`, `defaultBankDetails`, `isCuentaRut`).
- Banco "Efectivo" tiene `code: "EFE"` (constante `CASH_BANK_CODE`). Filtrado del XLSX BChile.
- `bankDetails = [paymentRut, accountNumber, accountType, bankCode]`.
- `defaultBankDetails(rut)` → Cuenta RUT (Banco Estado).

## Resúmenes / Summary modals

- `Components/CycleSummaryModal.jsx` — modos **Pagar** y **Cobrar**, day-by-day por labor, persistencia localStorage (cobrar settings + títulos editables `summary_titles_${cycleId}`). Después del resumen general agrega una **infografía por labor con grilla `Trabajador × Días`** (`LaborWorkerGrid`): nombre+RUT, una columna por fecha con qty grande + monto chico, totales `Total qty` y `Total $` por trabajador, fila `Total día` al pie. Cada labor tiene sus propios botones `📋 / 📥 / 🖨` (capturan solo esa sección via `ref` propio); los botones globales del modal capturan todo (general + grillas). El CSS de impresión incluye `thead { display: table-header-group }` para que el encabezado se repita en cada hoja nueva cuando la tabla excede una página. Sólo se rinden las grillas en modo `pagar` (cobrar es por tarifa pactada).
  - **Columnas del `LaborTable` (resumen por faena)**: además de Detalle/Fecha/Métrica/Valor/Valor total/Transporte/Total, al final se agrega `Personas` (cantidad de trabajadores únicos del día) para todas las labores. Para **tratoHE** la columna "Valor" se reemplaza por **`Total HE`** = `HE_hrs × labor.overtimeRate` (informativa, no editable), y al final se agrega **`Bonos`** = `amount − base − HE×tarifa` (derivado, incluye manejo + supervisión + extras agregados de todos los trabajadores del día). Sat/Dom + feriados del labor en rojo + bold en la columna Fecha (sólo tratoHE; usa `isRedDay` + `getDaySingle(dayPrices, ...)`).
  - **Modo Cobrar editable inline**: cada fila de `LaborTable`/`TransportTable` muestra inputs editables (`<input type=number>`) en las celdas de Cantidad/HE/Valor/Valor total. El `Total HE` y `Bonos` no son editables (son derivados). Los overrides se persisten por ciclo en `cobrar.labors[laborId].rowOverrides[date] = { qty?, overtimeHours?, rate?, amount? }`. Vaciar un input vuelve al valor base. También se pueden **agregar filas manuales** ("+ Agregar día / ajuste manual") que se guardan en `cobrar.labors[laborId].extraRows[]` con un `id` único; arrancan con `qty/rate/amount = ""` (no `0`) para que el `computedAmount = qty × rate` se aplique en cuanto el usuario tipea — si arrancaran en `0`, el override `amount=0` bloquea la multiplicación y la fila queda en `$0`. Aparecen mezcladas en la tabla con badge `(ajuste)` y botón `✕` para eliminar. Para labores `trato`, las filas extra **heredan la `unit` dominante** del labor (la más frecuente entre las filas regulares) para que `formatRowMetric` muestre "X saco" en vez de solo "X". Mismo modelo para transportistas (`cobrar.carriers[carrierId].rowOverrides/extraRows`). El `grandTotalCobrar` usa `chargedTotals.amount` (overrides aplicados) en lugar del `qty × chargeRate` viejo.
  - **Total a facturar + IVA**: en el printable de cobrar el grand total se rotula **TOTAL A FACTURAR** y debajo se muestran dos filas: **Valor IVA (19%)** = `round(total × 0.19)` e **IVA incluido** = `round(total × 1.19)`. La hoja `Total` del XLSX las reproduce con fórmulas vivas (`ROUND(C*0.19,0)` y `=C+C`).
  - **XLSX consolidado** (botón **📊 Excel** del footer): genera un workbook con **una hoja por labor** (cosecha/trato con desglose multi-combo, tratoHE con tarifa HE editable + fórmulas, main/sup/extra plano) + **una hoja por transportista** + una hoja **`Total`** que referencia los subtotales con fórmulas `='<sheet>'!$X$N`. Layout obligatorio: col A vacía width 6, fila 1 vacía, datos desde B2 (ver `memory/project_xlsx_layout_constraints.md`). En modo cobrar refleja los overrides (escribe valores literales en lugar de fórmulas que apuntan a una tarifa única).
- `Components/WorkerSummaryModal.jsx` — multi-ciclo activo, day-by-day, títulos editables (`worker_summary_titles_${rut}`). Carga **anticipos pendientes** via `listPendingForWorkers([rut])` y renderiza una sección "Anticipos / Adelantos pendientes" con tipo, fecha, monto, aplicado, saldo y nota. Cuando hay saldo, el bloque de totales muestra `Total producción − Saldo anticipos = NETO ESTIMADO` (en lugar del simple `TOTAL GENERAL`). Toggle de vista **📂 Por ciclo / 📜 Lineal**: el modo Lineal aplana todos los días de todos los ciclos en una sola tabla cronológica con columna `Ciclo`, con sus propios botones 📋 Copiar / 📥 PNG / 🖨 Imprimir y título editable (`linear: { main, subtitle }` dentro del localStorage de títulos). Soporta rango de fechas e incluye ciclos cerrados en el filtro.
- Ambos: logo desde `${import.meta.env.BASE_URL}logo.png`, modo foto (copiar imagen, descargar PNG, imprimir con `print-color-adjust: exact`).
- **Headers/totales reflejan el catálogo, no literales**: la columna principal y los "Total" se etiquetan con `cosechaUnit(catalogs, containersDelCiclo)` para cosecha y `tratoTypeLabel(catalogs, labor.tratoType)` para trato. Si un ciclo mezcla varios tipos cae al genérico ("Trato", "Unid.").

## Calendario / Calendar

- Pantalla: `src/screens/Calendar.jsx`. Ruta `/calendar`.
- Vista mensual. Cada celda lista las subfaenas que trabajaron ese día como barras de color (color estable derivado de un hash del nombre + paleta).
- Dos interacciones:
  1. Click en una **barra** → `DayDetailDrawer` con detalle por labor + transportistas del día/subfaena. Métricas heterogéneas (kilos solo de cosecha, jornadas solo de los tipos que aportan jornada, trato/HE solo donde aplica). Las tarjetas con valor 0 se ocultan.
  2. Click en la **celda** (zona blanca) → `DayExpandedModal` con todas las subfaenas del día. Click en una subfaena dentro de este modal pasa a `DayDetailDrawer` con `from: "all"` para que al cerrar el drawer se vuelva al modal del día (cadena de modales).
- **Cache de sesión por mes**: `sessionStorage` con TTL 5 min, key `af.calendar.{year}.{month}`. Reduce reads al navegar atrás/adelante.
- **Estrategia de lecturas**: hoy lee todos los workdays del rango del mes (~3k reads en mes pico, ~US$0.02). La función `fetchWorkdaysInRange(start, end)` está aislada como el punto de migración: cuando el volumen crezca consistentemente >5k workdays/mes o la carga supere 2s, mover ciclos cerrados a un snapshot agregado y combinar abierto+cerrado en esa misma función — el resto de la UI no cambia.
- **Workers**: además de workdays/trips, el Calendar pre-carga la lista completa de trabajadores con `workersService.list({ cache: true, persist: true, ttl: 2h })`. Mismo cache que usa la pantalla Trabajadores → 0 reads extra si ya está vivo. Necesario para mostrar nombres (no solo RUT) en los breakdowns por trabajador del drawer. TTL bajado a 2h (antes 24h) para que las ediciones de bancos/datos de un colaborador aparezcan al otro en una jornada.
- **DayDetailDrawer — fila expandible por labor**: cada fila de la tabla "Por labor" es clickeable (▸/▾). Al expandir se muestra:
  - Para **cosecha**: cards con `qualityLabel / containerLabel · kg · %` por combo (calidad×envase) — sale del catálogo, no `Q1/E2`.
  - **Trabajadores** que participaron: nombre + RUT + producción (kilos / tratoQty / jornadas / HE / piso) + monto, ordenados por monto desc. Estado expandido en memoria (no persistido).
- **Métricas tratoHE separadas**: en la tabla "Por labor" del drawer y en el breakdown de trabajadores, jornadas y HE se renderizan apilados (`{n} jorn.` arriba, `{h} HE` abajo) en lugar del string mezclado `"100 j + 17,5 HE"`. Misma convención que `LaborTable` y `LaborWorkerGrid`.
- **Sat/Dom en rojo**: el número del día en la grilla del mes y el título de la fecha en `DayDetailDrawer` / `DayExpandedModal` se muestran en `#dc2626` cuando es finde. El título usa formato humano `"vie 16-may-2026"` (helpers `humanDate`, `isWeekendDate` en el mismo archivo). Feriados a nivel labor no se cubren acá — están en `dayPrices` y el calendar no los carga.

## Consola admin / AdminConsole

- Pantalla: `src/screens/AdminConsole.jsx`. Ruta `/admin/console` (solo admin).
- Cuatro secciones para inspección barata: conteos por colección, workdays por mes (12 reads para todo un año), workdays por rango, workdays por ciclo.
- Usa `getCountFromServer` de Firestore — 1 read por cada 1000 docs vs N con `getDocs`. Permite estimar costos sin descargar la colección.

## Facturación / Billing

- Pantalla: `src/screens/Facturacion.jsx`. Ruta `/facturacion`. Nav label: "Facturación" (icono 🧾). Acceso para admin y supervisor.
- Servicios: `companiesService` (colección `companies`) + `dteDocumentsService` (colección `dteDocuments`) en `services/index.js`. TTL del list = **10 min** (`ttl: 600_000`) — las mutaciones locales (status, notas, pagos, import) actualizan el state en memoria, así que el TTL solo afecta al re-entrar a la pantalla.
- **Multi-empresa**: el sistema soporta N empresas (probado con 3). Cada empresa tiene `{ rut, razonSocial, alias, enabled }`. CRUD inline desde el modal **🏢 Empresas**. Los DTE quedan namespaceados por `companyId` así no se colisionan folios entre empresas (mismo proveedor puede facturar a varias empresas con el mismo folio).
- **Empresa elegida persiste en localStorage** (`facturacion.selectedCompanyId`). Si la empresa guardada fue borrada, cae a la primera.
- **V1: solo lectura/import**. La emisión sigue siendo manual en el portal SII — no hay integración con LibreDTE/OpenFactura. Cuando se sume emisión se distingue por `source: "self_emitted"` (hoy todos son `"sii_import"`).
- **Flujo de import**: el usuario exporta CSV del **Registro de Compras y Ventas (RCV)** desde el portal SII. En la app: 📥 Importar → elegir empresa + **uno o varios archivos** (Ctrl/Cmd+click) → preview multi-file con stats, warnings de RUT mismatch, exclusiones togglables → Confirmar → escribe a Firestore.

### Parser CSV (`src/utils/siiCsvParser.js`)

Exporta: `parseSiiRcvCsv(buffer, { companyRut })`, `dteTypeLabel(tipo)`, `normalizeRut(raw)`, `rutNumeric(raw)`, `extractRutFromFilename(name)`, `buildDteDocId({ companyId, kind, tipo, folio, rutEmisor, rutReceptor })`.

- Auto-detecta **kind** (ventas vs compras) por headers (`Rut cliente` vs `Rut Proveedor`).
- Encoding **UTF-8 con BOM o ISO-8859-1** — intenta UTF-8, fallback a latin-1 si detecta U+FFFD.
- Fechas en YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY → normalizadas a ISO.
- Montos con miles `.` y decimal `,` o sin separadores.
- RUTs con/sin guión y puntos, normalizados a `12345678-9`.
- `extractRutFromFilename` saca el RUT del nombre del archivo (el SII suele incluirlo en exports del RCV) para detectar mismatch con la empresa elegida → warning en el preview.

### Doc shape + replace por período

```
{
  id,                     // companyId_V_tipo_folio  (ventas)
                          // companyId_C_rutProvNumeric_tipo_folio  (compras)
  kind: "venta"|"compra",
  tipo: 33|34|39|56|61|112|...,
  tipoLabel, folio,
  rutEmisor, razonSocialEmisor,
  rutReceptor, razonSocialReceptor,
  fechaEmision, periodo: "YYYY-MM",
  exento, neto, iva, otrosImpuestos, total,
  companyId, companyAlias,
  source: "sii_import", sourceFile,
  importedAt, importedBy,
  paymentStatus: "unpaid"|"paid"|"net_only"|"factored"|"cancelled",
  paymentStatusSetAt, paymentStatusSetBy,
  notes,                  // glosa interna editable
  payments: [{ id, date, amount, kind, notes, recordedAt }],
  amountPaid,             // denormalizado: sum(payments.amount)
}
```

- **Doc id determinístico por `companyId`**: reimportar el mismo período es **idempotente** (setDoc + merge sobreescribe sin duplicar). El preview cuenta cuántos sobreescriben antes de confirmar.
- **Replace por período**: confirmar el import agrupa por `(companyId, kind, periodo)` y para cada scope (a) lee los existentes, (b) calcula **huérfanos** (existían antes, no vienen en el nuevo CSV) y los **elimina**, (c) escribe los nuevos/actualizados. Preserva `paymentStatus` existente al reimportar — solo setea `"unpaid"` para docs nuevos. Bulk write: `writeBatch(db)` con chunks de 450 (límite Firestore 500).

### UI

- Tabs **📤 Facturas** (kind=venta — antes "Ventas", renombrado a Facturas), **📥 Compras**, **📑 Retenciones**.
- **Vista default = mes actual**. Toggle **🔍 Auditoría** habilita navegar todos los períodos.
- Filtros: período, tipo de DTE, **estado de pago** (chips: Todos / No pagado / Pagado / Solo neto / Solo IVA / Anulada), búsqueda libre con `<datalist>` autocomplete de contrapartes únicas.
- Cards de totales: Documentos, Neto, IVA, Total. **NCs (tipos 61/112) restan con signo** en los totales y se cuentan aparte en una card específica. Para vista normal: cards adicionales de No pagado del período / Solo neto / Cedidas. Para Retenciones: Facturas con retención / IVA retenido / Total facturado.
- **Tabla principal sortable**: click en cualquier header (Fecha, Tipo, Folio, Cliente/Proveedor, RUT, Neto, IVA, Total, Abonos, Estado) alterna asc/desc con flecha ▲/▼. Default `fechaEmision desc`. Sort sobre "estado" empuja NCs al final (clave virtual `zz_anulada`).
- **Columna Abonos**: muestra el monto pagado + sub-text "Saldo $X" (warning) o "✓ N abonos" (success) cuando está totalmente pagada. NCs: "—".

### Estados de pago (`PAYMENT_STATUSES`)

5 estados manuales para facturas/boletas afectas, expuestos como `<select>` por fila. Las NCs (61/112) **no usan estos estados** — chip fijo "Anulada" rojo.

| Estado | Significado |
|---|---|
| `unpaid` | Pendiente de cobro/pago (default al importar) |
| `paid` | Completo |
| `net_only` | Cliente solo pagó NETO — retuvo IVA (típico de servicios). Aparece en tab Retenciones |
| `factored` | Factura cedida vía factoring (queda "solo IVA" en libros) |
| `cancelled` | Anulada por NC |

El select nativo lleva colores explícitos `var(--color-surface)` / `var(--color-text)` en sus `<option>` porque el dropdown nativo hereda el fondo del chip y en dark mode los soft colors hacen ilegibles los items.

### Autodetección de NC anulada (sugerencia)

- Helper `findCancellingNcs(dteDoc, allDocs)`: matchea NCs con misma `companyId + kind + RUT contraparte + total exacto`, con NC fecha ≥ factura. Memo `cancellingByDocId` precalcula el mapa.
- **No auto-cambia** el estado — solo sugiere. En la fila aparece un badge **⚠ NC?** al lado del select; click abre el `DocDetailModal` con un banner rojo listando las NCs candidatas + botón **"Marcar como Anulada"** que en un click setea `cancelled` y agrega `[Anulada por NC tipo-folio (fecha, monto)]` a las notas como auditoría.

### Pagos / abonos (`payments[]`)

- Sección dentro del `DocDetailModal` (oculta para NCs). Lista pagos con fecha/tipo/monto/notas + botón × por fila.
- Tipos (`PAYMENT_KINDS`): `abono` / `neto` / `iva` / `total` — categorización para auditoría.
- Indicador **Pagado** / **Saldo** con color (verde si cerrada, warning si queda saldo).
- Form inline para agregar: fecha (default hoy), tipo, monto, notas. Al cambiar tipo, el monto se autocompleta: `total` = saldo pendiente, `neto` = factura.neto, `iva` = factura.iva, `abono` = vacío.
- **Validación estricta**: `amountPaid + nuevo ≤ total` — si excede, alerta con desglose y bloquea. Monto > 0, fecha obligatoria. El botón "+ Registrar pago" se deshabilita cuando saldo ≤ 0.
- Persistencia: `saveDocPayments(dteDoc, payments)` escribe `payments` + `amountPaid` denormalizado.
- `paymentStatus` es independiente de los pagos — es la etiqueta de alto nivel; los pagos son el detalle/auditoría temporal.

### Retenciones (tab + exports)

Tab **📑 Retenciones** muestra todas las facturas con `paymentStatus === "net_only"` agrupadas por contraparte (sin restricción de kind). `retencionesByContraparte` agrupa por RUT, suma neto/iva/total, ordena por IVA desc. Lista expandible (▸/▾) en `RetencionesView`.

**Exports** (4 botones en toolbar global, mismo set por contraparte individual):
- 📋 Copiar (toBlob al clipboard como PNG)
- 📥 PNG (toPng + download)
- 🖨 Imprimir (ventana print landscape con color-adjust: exact)
- 📊 XLSX (ExcelJS lazy, layout convención col A vacía width 6 + fila 1 vacía)

**`PrintableRetenciones`** (general): banner amarillo destacado con **IVA Retenido total del período** (font 22, weight 800), tabla resumen por contraparte, y sección **Detalle de facturas** agrupada por contraparte con subtotales por grupo + total general. Sin columna `Tipo` (solo `Documento` con el label) — el número de tipo es ruido visual.

**`PrintableRetencionesGroup`** (individual): un printable por contraparte renderizado off-screen, mismo estilo pero limitado a una sola contraparte. Cada grupo en la vista tiene su propia toolbar de 4 botones (📋📥🖨📊) con `stopPropagation` para que no expanda el grupo. Filename: `Retencion_{empresa}_{contraparte}_{periodo}`.

**XLSX por grupo**: una hoja con banner explícito de IVA retenido (fila 4 destacada amarilla con monto grande) + tabla de facturas + total con fórmulas SUM. Las celdas IVA llevan `bold: true`.

### Ver pendientes (modal global)

Botón **⏳ Ver pendientes** al lado de Auditoría, con badge contador. Abre `PendientesModal` con las **ventas** (kind=`venta` — no compras, son flujo distinto) de la empresa seleccionada **(cualquier período)** que tengan saldo pendiente, categorizadas:

| Categoría | Criterio |
|---|---|
| `full` (Factura completa) | status `unpaid` sin abonos → debe el total |
| `partial` (Abono parcial) | status `unpaid` con abonos → debe `total - amountPaid` |
| `iva` (IVA pendiente) | status `net_only` → debe `iva - max(0, paid - neto)` |

Skip: NCs, `paid`, `cancelled`, **`factored`** (Solo IVA / cedida — se considera pagada porque el factor ya pagó el neto al emisor; el IVA es una obligación tributaria separada que se gestiona en el F29, no acá). Helper: `pendingFor(d)` devuelve `{ category, amount }` o null.

UI: summary cards por categoría + tabla agrupada con sub-headers de color (`#ffd6d6`/`#fff2cc`/`#dde9ff`), subtotales por grupo, total general destacado al final. Cada fila tiene ℹ para abrir el detalle. Misma toolbar de 4 exports.

**`PrintablePendientes`** off-screen replica el layout para captura. **XLSX** baja workbook con secciones por categoría, subtotales con fórmulas y total general en verde.

## Links útiles

- Pantalla: `src/screens/InterestLinks.jsx`. Ruta `/links`.
- Servicio: `interestLinksService` (colección `interestLinks`).
- CRUD simple con drag-and-drop nativo (HTML5) para reordenar. El orden se persiste en el campo `order` por documento.
- Helper `normalizeUrl` agrega `https://` si falta; `safeHost` extrae el host para mostrar como subtítulo.

## Layout

- **Sidebar colapsable** (`layout.sidebarOpen` en `localStorage`): un solo botón ☰ funciona como toggle en desktop y abre drawer en mobile (decidido por `matchMedia("(min-width: 768px)")`).
- Nav incluye: Dashboard, Faenas, Calendario, Trabajadores, Transportes, Anticipos / Bonos, Nómina, Facturación, Links útiles. Items admin (Auditoría, Migrar CSV, Limpiar pagados, Consola) se ven solo con `isAdmin`.
- **Versión en el header** — `Agrofrutos v1.0.{commitCount}` autogenerado en build-time por `vite.config.js` (via `git rev-list --count HEAD` inyectado como `__APP_VERSION__`). Sirve para diagnosticar caché PWA viejo de un vistazo: si el header sigue mostrando una versión anterior tras un deploy, el SW tiene un bundle stale.

## Env

- `.env` ignorado en git pero necesita credenciales de Firebase.
- Copiar de un `.env` existente o desde Firebase console del proyecto.

## Rutas / Routes

```
/                              Dashboard
/login                         Login (Email/Password)
/faenas                        Faenas / Subfaenas / Ciclos
/cycles/:id                    CycleDetail
/workers                       Trabajadores
/transports                    Transportes
/advances                      Anticipos / Adelantos
/payroll                       Nómina
/facturacion                   Facturación (import RCV del SII)
/links                         Links útiles
/calendar                      Calendario mensual
/audit                         Auditoría (admin only)
/admin/migrate-workers         Importar trabajadores desde CSV (admin)
/admin/cleanup-paid-workdays   Limpieza de workdays ya pagados (admin)
/admin/console                 Consola admin: Firestore counts (admin only)
*                              NotFound (catch-all dentro y fuera del Layout)
```

### SPA en GitHub Pages

- `public/404.html` + script en `index.html` (truco rafgraph/spa-github-pages): cualquier ruta desconocida recarga `index.html?/<path>`, el script hace `history.replaceState` y React Router renderiza la ruta correcta. Sin esto, recargar `/cycles/abc` devuelve 404 de GitHub Pages.

### PWA

- Configurada via `vite-plugin-pwa` en `vite.config.js` con `registerType: 'autoUpdate'`. Genera `manifest.webmanifest`, `sw.js` y `registerSW.js` en `dist/` al build.
- **Instalación**: abrís la URL desplegada en Chrome (Android) o Safari (iOS) → el navegador ofrece "Instalar app" / "Agregar a pantalla de inicio" → queda ícono en el escritorio que abre la app en standalone (sin barra de URL).
- **Precache**: precachea todos los assets del build con `globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}']`. Límite subido a 5MB porque el chunk de exceljs excede el default de 2MB.
- **Cache de datos**: NO interceptamos las llamadas a Firestore — el SDK de Firebase ya maneja su propio cache offline en IndexedDB. Habilitar `enableIndexedDbPersistence` si queremos offline-first más agresivo.
- **navigateFallback: null** intencional. No queremos que el SW devuelva `index.html` para rutas desconocidas porque romperíamos el truco 404.html → `?/path` de GitHub Pages.
- **Auto-update**: cuando se hace `npm run deploy` de una versión nueva, el SW detecta el cambio en `sw.js` en la próxima navegación y se actualiza sin prompt al usuario (próximo reload toma la versión nueva).
- **Dev**: `devOptions.enabled: false` — el SW no corre en `npm run dev` para no pelearse con HMR.
