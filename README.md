# Admin Agrofrutos

Panel de administración para la gestión de operaciones agrícolas de Agrofrutos.

## Tecnologías

- **React 19** con **React Router 7** para el enrutamiento
- **Vite 7** como bundler y servidor de desarrollo
- **Tailwind CSS 4** para los estilos
- **Firebase** (Firestore + Auth) como backend
- **ag-grid** para tablas de datos avanzadas
- **React Compiler** (`babel-plugin-react-compiler`) para optimización automática de renders
- **ESLint** (flat config) para linting

## Comandos

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Iniciar servidor de desarrollo (HMR) |
| `npm run build` | Compilar para producción → `dist/` |
| `npm run lint` | Ejecutar ESLint |
| `npm run preview` | Vista previa del build de producción |
| `npm run deploy` | Compilar y desplegar en GitHub Pages |

## Despliegue

El proyecto se despliega en **GitHub Pages** en:
`https://serviciosagricolashp.github.io/adminAgrofrutos/`

> **Importante:** El path base `/adminAgrofrutos/` debe coincidir en dos archivos:
> - `vite.config.js` → `base`
> - `src/App.jsx` → `<BrowserRouter basename="/adminAgrofrutos">`

## Configuración del entorno

Se requiere un archivo `.env` con las credenciales de Firebase (ignorado en git):

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

## Estructura del proyecto

```
src/
  main.jsx              ← Punto de entrada
  App.jsx               ← Router principal
  firebase.js           ← Configuración de Firebase (BD: "hpdatabase")
  Components/           ← Componentes reutilizables (Layout, Modal, etc.)
  screens/              ← Pantallas de cada ruta
  contexts/             ← AuthContext, ThemeContext, CatalogsContext
  services/             ← Capa de datos (CRUD Firestore + caché + auditoría)
  utils/                ← Helpers de dominio (RUT, fórmulas, ag-grid, etc.)
```

## Autenticación

- Email/Password con Firebase Auth
- Roles: `admin` y `supervisor` (por defecto si no existe perfil)
- Los perfiles se almacenan en la colección `users` de Firestore (id = uid de Firebase)
- La ruta `/audit` requiere rol de administrador

## Servicios de datos

- `services/firestoreBase.js` exporta `createService(entityName, collectionName)` — una factory CRUD
- Caché automática en memoria con invalidación y logs de auditoría
- Soporte para `cache: true` con TTL (60s por defecto) y `persist: true` (almacena en `localStorage`)
