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
                        (Dashboard, Faenas, CycleDetail, Workers, Transports, Payroll, Advances)
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

## Faenas / Ciclos / Cycles

- Jerarquía: Faena → Subfaena → Ciclo → Labors → Workdays.
- Label de ciclo = prefijo bloqueado `Faena/Subfaena/` + sufijo editable.
- Estados: `open` | `closed`. Solo un ciclo abierto por (faena, subfaena).
- `CycleRow` permite **✏ Renombrar**, abrir, cerrar y eliminar.

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

## Transports / Transporte

- Pantalla: `src/screens/Transports.jsx` — 4 pestañas:
  1. **Transportistas** — gestión de carriers.
  2. **Vueltas** — listado y CRUD.
  3. **Pago por faena** — selecciona ciclos activos + rango de fechas → genera un `paymentSummary` por transportista con sus vueltas pendientes.
  4. **Resúmenes / Pagos** — historial; marcar pagado, revertir, imprimir.
- Modal: `src/Components/TransportsModal.jsx` — usado en `CycleDetail` para asignar viajes rápidos.
- Servicios: `services/transportsService.js` exporta `tripsService` (alias `transportsService`) y `paymentsService` (alias `transportPaymentsService`).
- Contexto: `CarriersContext` precarga transportistas; expone CRUD con soft-delete.
- Tipos de viaje: `regular` (Vuelta), `approach` (Acercamiento) — definidos en `TRIP_KINDS`.
- Tipos de transportista: `own` (Propio), `contracted` (Contratado) — definidos en `CARRIER_TYPES`.
- Trips: `{carrierId, vehicleAlias, cycleId, faenaId, subfaenaId, date, kind, qty, rate, amount, lugar, destino, personCount, notes, status, paymentId}`.
- Payments: `{carrierId, periodFrom, periodTo, tripIds[], total, status, paidAt, notes}`. Marcar como pagado pone los trips referenciados en `status: paid`.

## Trabajadores / Workers

- Pantalla: `src/screens/Workers.jsx` — carga **una vez** con cache persistente (TTL 5min) y filtra client-side.
- Búsqueda: substring sobre `id` y `name`, normalizando acentos y mayúsculas. Vacío = todos.
- Auto-detect badge **RUT** vs **Nombre** (basado en `detectQueryKind`: empieza con dígito → RUT).
- Acciones rápidas: 🆔 Cta. RUT (Banco Estado), 💵 Efec. (banco "EFE"), 📊 Resumen, Editar, ✕.
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

1. **Generar** — selector de ciclos activos agrupados por faena. Cada ciclo muestra `Pendiente` y `Pagado` calculados desde workdays.
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

### Historial

- Filtros: estado, mes, búsqueda. Totales (Pendiente / Pagado) en header.
- Acciones: re-descarga (sólo BChile / completo), marcar pagada, volver a pendiente, eliminar (con cascade que limpia workdays y restaura anticipos).

## Anticipos / Adelantos

- Pantalla: `src/screens/Advances.jsx`. Ruta `/advances`.
- Servicio: `services/advancesService.js` (colección `advances`).
- Una colección con discriminador `type: "anticipo" | "adelanto"`.
- Estados: `pending` | `applied` | `cancelled`.
- Documento: `{type, workerRut, workerName, amount, date, note, status, appliedPayrollId, appliedAt, appliedBy}`.
- Tabs visuales: 🪙 Anticipo / 💸 Adelanto.
- Modal de creación con `searchWorkers` para autocompletar trabajador.
- No editables/eliminables si están `applied` (cascade desde Payroll).

### Integración con Nómina

- Al construir preview, `listPendingForWorkers(ruts)` carga todos los anticipos `pending` de los trabajadores.
- Suma `anticiposTotal + adelantosTotal` se pre-llena en el campo Anticipo del item.
- Al crear nómina: `applyAdvancesToPayroll(advanceIds, payrollId)` cambia status a `applied`.
- Al eliminar nómina: `restoreAdvancesFromPayroll(advanceIds)` vuelven a `pending`.

## Bancos

- `src/utils/banks.js` define `BANKS`, `ACCOUNT_TYPES`, helpers (`bankName`, `isCashBank`, `defaultBankDetails`, `isCuentaRut`).
- Banco "Efectivo" tiene `code: "EFE"` (constante `CASH_BANK_CODE`). Filtrado del XLSX BChile.
- `bankDetails = [paymentRut, accountNumber, accountType, bankCode]`.
- `defaultBankDetails(rut)` → Cuenta RUT (Banco Estado).

## Resúmenes / Summary modals

- `Components/CycleSummaryModal.jsx` — modos **Pagar** y **Cobrar**, day-by-day por labor, persistencia localStorage (cobrar settings + títulos editables `summary_titles_${cycleId}`).
- `Components/WorkerSummaryModal.jsx` — multi-ciclo activo, day-by-day, títulos editables (`worker_summary_titles_${rut}`).
- Ambos: logo desde `${import.meta.env.BASE_URL}logo.png`, modo foto (copiar imagen, descargar PNG, imprimir con `print-color-adjust: exact`).

## Links útiles

- Pantalla: `src/screens/InterestLinks.jsx`. Ruta `/links`.
- Servicio: `interestLinksService` (colección `interestLinks`).
- CRUD simple con drag-and-drop nativo (HTML5) para reordenar. El orden se persiste en el campo `order` por documento.
- Helper `normalizeUrl` agrega `https://` si falta; `safeHost` extrae el host para mostrar como subtítulo.

## Layout

- **Sidebar colapsable** (`layout.sidebarOpen` en `localStorage`): un solo botón ☰ funciona como toggle en desktop y abre drawer en mobile (decidido por `matchMedia("(min-width: 768px)")`).
- Nav incluye: Dashboard, Faenas, Trabajadores, Transportes, Anticipos, Nómina, Links útiles. Items admin (Auditoría, Migrar CSV, Limpiar pagados) se ven solo con `isAdmin`.

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
/links                         Links útiles
/audit                         Auditoría (admin only)
/admin/migrate-workers         Importar trabajadores desde CSV (admin)
/admin/cleanup-paid-workdays   Limpieza de workdays ya pagados (admin)
```
