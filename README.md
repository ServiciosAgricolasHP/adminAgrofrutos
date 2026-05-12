# Admin Agrofrutos

Panel de administración para la gestión de operaciones agrícolas de Agrofrutos: faenas, ciclos, jornadas, transporte, anticipos y nómina bancaria.

## Tecnologías

- **React 19** con **React Router 7**
- **Vite 7** como bundler y servidor de desarrollo
- **Tailwind CSS 4**
- **Firebase** (Firestore + Auth)
- **ag-grid** para tablas
- **ExcelJS** (lazy) para generación de XLSX con estilos
- **html-to-image** para exportar resúmenes a PNG / portapapeles
- **React Compiler** (`babel-plugin-react-compiler`) para optimización de renders
- **ESLint** flat config

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Iniciar servidor de desarrollo (HMR) |
| `npm run build` | Compilar para producción → `dist/` |
| `npm run lint` | Ejecutar ESLint |
| `npm run preview` | Vista previa del build de producción |
| `npm run deploy` | Compilar y desplegar en GitHub Pages |

## Despliegue

GitHub Pages → `https://serviciosagricolashp.github.io/adminAgrofrutos/`

> El path base `/adminAgrofrutos/` debe coincidir en dos archivos:
> - `vite.config.js` → `base`
> - `src/App.jsx` → `<BrowserRouter basename="/adminAgrofrutos">`

## Configuración del entorno

`.env` (ignorado en git):

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

## Estructura

```
src/
  main.jsx              ← Punto de entrada
  App.jsx               ← Router
  firebase.js           ← Firebase init (Firestore db = "hpdatabase")
  Components/           ← UI compartida
  screens/              ← Pantallas de cada ruta
  contexts/             ← Auth, Theme, Catalogs, Carriers
  services/             ← CRUD Firestore + caché + auditoría
  utils/                ← Helpers de dominio
public/
  logo.png              ← Usado en resúmenes y comprobantes
```

## Autenticación

- Firebase Email/Password.
- Roles: `admin`, `supervisor` (por defecto si no hay perfil).
- Perfiles en colección `users` (id = uid de Firebase).
- `/audit` requiere rol admin.

## Módulos

### Faenas / Ciclos
Jerarquía Faena → Subfaena → Ciclo → Labors → Workdays. El nombre del ciclo se compone de un prefijo bloqueado `Faena/Subfaena/` + sufijo editable. Cada ciclo se puede renombrar, abrir, cerrar y eliminar.

### Trabajadores
Carga única con cache persistente (5 min). Búsqueda client-side con substring (acentos y mayúsculas insensitive) sobre RUT y nombre. Auto-detect del tipo de búsqueda. Acciones rápidas para asignar Cuenta RUT (Banco Estado) o marcar como Efectivo.

El **líder de grupo** es estricto: dropdown con líderes ya existentes; crear nuevos requiere acción explícita.

### Transportes
Cuatro pestañas: Transportistas, Vueltas, **Pago por faena** (selecciona ciclos + rango de fechas, genera un resumen de pago por transportista), y Resúmenes / Pagos.

### Anticipos y Adelantos
Módulo separado para registrar adelantos (anticipo = vale chico; adelanto = mayor). Estados: pendiente / aplicado / cancelado. Se descuentan automáticamente en la nómina siguiente.

### Nómina
Selector de ciclos activos con monto pendiente por ciclo. Preview con anticipos pre-aplicados, validación de cuentas, filtros y bulk actions. Genera XLSX con cuatro hojas:

1. **Nomina** — formato Banco de Chile (subir al portal del banco).
2. **Resumen** — Transferencias / Efectivo / Total por ciclo.
3. **Transferencias** — desglose por trabajador y ciclo.
4. **Efectivo** — agrupado por líder con paletas de color y subtotales.

Hay descarga **sólo Nómina** (la hoja BChile pura) o XLSX completo. Comprobantes imprimibles del efectivo (uno por líder, con líneas de firma) e incluyen una columna **Anticipo** explícita cuando algún trabajador del grupo trae descuento.

Anti doble pago: cada workday se etiqueta con `payrollId`. Al eliminar una nómina, los workdays y anticipos vuelven a estar disponibles.

Cada generación de nómina escribe además un **snapshot JSON** inmutable (colección `payrollSnapshots`, 1:1 con `payrolls`) que se autodescarga y queda disponible para re-bajar desde el historial. Es la fuente que va a consumir el **portal de trabajadores** (read-only).

### Links útiles
`/links` — listado de atajos a herramientas externas frecuentes. CRUD simple con reordenamiento drag-and-drop persistido en la colección `interestLinks`.

## Servicios de datos

- `services/firestoreBase.js` exporta `createService(entityName, collectionName)` — factory CRUD.
- Caché en memoria con invalidación automática y logs de auditoría (`services/logger.js`).
- `list()` soporta `cache: true` con TTL (60s default) y `persist: true` (localStorage).
- Batched updates con `writeBatch(db)` directo en chunks de 450.

## Rutas

```
/                              Dashboard
/login                         Login
/faenas                        Faenas / Subfaenas / Ciclos
/cycles/:id                    Detalle de ciclo
/workers                       Trabajadores
/transports                    Transportes
/advances                      Anticipos y Adelantos
/payroll                       Nómina
/links                         Links útiles
/audit                         Auditoría (admin)
/admin/migrate-workers         Importar trabajadores desde CSV (admin)
/admin/cleanup-paid-workdays   Limpieza de workdays ya pagados (admin)
```
