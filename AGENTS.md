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

React 19 · Vite 7 · Tailwind CSS 4 · Firebase (Firestore + Auth) · ag-grid · React Router 7 · ESLint flat config

- **Solo JavaScript** (no TypeScript).
- **React Compiler** habilitado via `babel-plugin-react-compiler`.
- Variables de entorno con prefijo `VITE_`.

## Arquitectura / Architecture

```
src/
  main.jsx              ← punto de entrada / entry point
  App.jsx               ← router (react-router-dom)
  firebase.js           ← Firebase init (Firestore db = "hpdatabase")
  Components/           ← UI compartida (Layout, Modal, ProtectedRoute, etc.)
  screens/              ← componentes de ruta / page-level route components
  contexts/             ← AuthContext, ThemeContext, CatalogsContext
  services/             ← capa de datos (Firestore CRUD + caché + auditoría)
  utils/                ← helpers de dominio (RUT, fórmulas, ag-grid locale, etc.)
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
- Nuevos servicios: agregar a `services/index.js` exports, luego importar donde se necesite.

### Contexts

- Orden en `App.jsx` importa: `ThemeProvider` → `AuthProvider` → `CatalogsProvider`.
- `CatalogsProvider` precarga tablas de lookup usadas en las pantallas.

## Convenciones / Conventions

- Componentes en PascalCase; archivos coinciden con nombre del componente.
- `Components/` usa C mayúscula (no estándar — seguirla).
- ESLint: variables sin usar empezando con `A-Z_` son ignoradas.
- `screens/` contiene lógica de rutas; data fetching en `services/`.

## Tipos de Labor / Labor Types

Definidos en `src/screens/CycleDetail.jsx` (`LABOR_TYPES`). Cada labor tiene un campo `type` que determina columnas del grid, entrada de datos y métricas:

| Tipo / Type | Etiqueta / Label | Comportamiento del grid / Grid behavior | Forma de datos / Data shape |
|------|-------|---------------|------------|
| `main` | Principal (a trato) | 1 columna/día, monto `$` directo | `workdays: { amount }` |
| `supervision` | Supervisión | Igual que main / Same as main | Igual / Same |
| `extra` | Adicional | Igual que main / Same as main | Igual / Same |
| `cosecha` | Cosecha | Multi-columnas por día (calidad × envase) | `workdays: { qualityX, containerY, qty, amount }` |
| `trato` | A trato | Multi-precio por día (`t0`, `t1`, ...) — como cosecha | `dayPrices: { t0: { price, mode }, t1: ... }`, `workdays: { qty, amount }` por tier |
| `tratoHE` | Jornadas con horas extras | Columnas: D (día), HE, M (manejo), S (supervisión), X (extras), `$` | `workdays: { qty, overtimeHours, hasManejo, hasSupervision, extras, amount }` |

### trato — multi-precio por día / multi-price per day

- Precios almacenados como `dayPrices[laborId][date]` = `{ t0: { price, mode }, t1: { price, mode }, ... }`
- Legacy `{ price, mode }` o `{ "0_0": { price, mode } }` se normaliza automáticamente al cargar
- Cada precio genera su propia columna editable en el grid
- Agregar/quitar tiers desde la barra de precios; las columnas aparecen/desaparecen automáticamente
- Registros de workday con claves `rut__fecha__t0`, `rut__fecha__t1`, etc.
- La tarjeta de métricas muestra desglose por precio cuando hay >1 tier

### tratoHE — jornadas con bonos / bonuses

- `baseDayDefault`, `bonusManejo`, `bonusSupervision`, `overtimeRate` en la definición de labor
- Config por día: `{ price, mode: "normal"\|"overtimeOnly", isHoliday }`
- Toggle entre "detalle" (6 sub-columnas) y "resumen" (1 columna `$`)
- Bonos editables por trabajador por día; líderes por defecto configurables

### cosecha

- Combos = calidad × envase, almacenados como `dayPrices[laborId][date]` con claves `${x}_${y}`
- Catálogos globales para `qualities`, `containers` — editables via ⚙ Catálogos

## Env

- `.env` ignorado en git pero necesita credenciales de Firebase.
- Copiar de un `.env` existente o desde Firebase console del proyecto.
