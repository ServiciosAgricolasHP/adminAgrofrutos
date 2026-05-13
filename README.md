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

**Pisos (trato / cosecha)**: opt-in por día. En el panel de Precios cada día tiene un botón **"+ piso"** discreto que solo aparece si no está configurado; al guardarlo se muestra inline con acciones editar/quitar. La grilla agrega una columna "P" 🪙 **solo** en los días que tienen piso (configurado o asignado a alguien) — el resto queda sin columna extra. Click marca/desmarca el piso del trabajador (se crea/borra un workday separado con flag `pisoOnly`). El monto se suma al pago de producción y se refleja como columna/total separado en resúmenes y nómina.

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

### Calendario
`/calendar` — vista mensual con barras de color por subfaena por día. Click en el día (zona blanca) abre un modal de zoom con todas las subfaenas del día; click en una barra abre un drawer con detalle (por labor + transportes) de esa subfaena. Carga workdays + trips del rango del mes con cache de sesión (5 min) — costo aprox. ~3k reads en mes pico. La función `fetchWorkdaysInRange` está aislada para migrar a snapshot por ciclo cerrado cuando el volumen lo justifique.

### Consola admin
`/admin/console` — solo admin. Permite contar workdays por mes/rango/ciclo y ver totales por colección usando `getCountFromServer` (1 read por cada 1000 docs vs N reads con `getDocs`).

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
/calendar                      Calendario mensual de producción
/audit                         Auditoría (admin)
/admin/migrate-workers         Importar trabajadores desde CSV (admin)
/admin/cleanup-paid-workdays   Limpieza de workdays ya pagados (admin)
/admin/console                 Consola: conteos de Firestore (admin)
*                              NotFound (404) — botones "Volver" + "Ir al Dashboard"
```

### Hosting de SPA en GitHub Pages

GitHub Pages no resuelve rutas client-side; usamos el truco de [rafgraph/spa-github-pages](https://github.com/rafgraph/spa-github-pages):
- `public/404.html` redirige cualquier ruta desconocida a `index.html?/<path>`.
- `index.html` lee ese query, hace `history.replaceState` para devolver la URL correcta, y React Router toma el control.

Resultado: `https://serviciosagricolashp.github.io/adminAgrofrutos/cycles/abc123` recargado en navegador navega bien en vez de devolver 404.

### PWA (instalable en mobile/desktop)

La app está configurada como **PWA** vía `vite-plugin-pwa`. Esto significa:
- Al abrir la URL en Chrome (Android) o Safari (iOS), el navegador ofrece **"Instalar app" / "Agregar a pantalla de inicio"**. Queda ícono en el escritorio del teléfono y abre en pantalla completa, sin barra del navegador.
- Service worker precachea los assets → la app abre instantáneamente y funciona aunque haya señal pobre (Firestore tiene su propio cache offline en IndexedDB).
- Auto-actualización: al hacer `npm run deploy`, la próxima vez que se abre la app, el SW detecta la versión nueva y la aplica sin que nadie tenga que reinstalar.

No es un APK ni se sube a Play Store / App Store — se distribuye con la **misma URL** del deploy.
