# AGENTS.md

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Vite dev server (HMR) |
| `npm run build` | Production build → `dist/` |
| `npm run lint` | ESLint (flat config, `.jsx` only) |
| `npm run preview` | Preview production build locally |
| `npm run deploy` | Build + push to GitHub Pages |

**No test framework is configured.** Do not invent one without asking.

## Deploy / base path

- Deployed to GitHub Pages at `https://serviciosagricolashp.github.io/adminAgrofrutos/`
- The base path `/adminAgrofrutos/` is set in **two places** — both must match:
  - `vite.config.js` → `base`
  - `src/App.jsx` → `<BrowserRouter basename="/adminAgrofrutos">`

## Stack

React 19 · Vite 7 · Tailwind CSS 4 · Firebase (Firestore + Auth) · ag-grid · React Router 7 · ESLint flat config

- **JavaScript only** (no TypeScript).
- **React Compiler** is enabled via `babel-plugin-react-compiler`.
- All env vars must be prefixed with `VITE_` (Vite convention).

## Architecture

```
src/
  main.jsx              ← entry point
  App.jsx               ← router (react-router-dom)
  firebase.js           ← Firebase init (Firestore db = "hpdatabase")
  Components/           ← shared UI (Layout, Modal, ProtectedRoute, etc.)
  screens/              ← page-level route components
  contexts/             ← AuthContext, ThemeContext, CatalogsContext
  services/             ← data layer (Firestore CRUD + cache + audit log)
  utils/                ← domain helpers (RUT, formulas, ag-grid locale, etc.)
```

### Auth

- Firebase Email/Password auth.
- User profiles stored in Firestore `users` collection (doc id = Firebase uid).
- Roles: `admin`, `supervisor` (default if no profile found).
- `ProtectedRoute` wraps authenticated routes; `adminOnly` prop restricts to admins.

### Services

- `services/firestoreBase.js` exports `createService(entityName, collectionName)` — a CRUD factory.
- All services auto-invalidate a local in-memory cache and write audit logs via `services/logger.js`.
- `list()` supports `cache: true` with TTL (default 60s); `persist: true` also caches in `localStorage`.
- New services: add to `services/index.js` exports, then import where needed.

### Contexts

- Provider order in `App.jsx` matters: `ThemeProvider` → `AuthProvider` → `CatalogsProvider`.
- `CatalogsProvider` pre-fetches lookup tables used across screens.

## Conventions

- Components use PascalCase; files match component name (e.g. `WorkerEditModal.jsx`).
- `Components/` uses capital C (non-standard — follow it).
- ESLint rule: unused vars starting with `A-Z_` are ignored (React component pattern).
- `screens/` contain route-level logic; keep data fetching in `services/`.

## Env

- `.env` is gitignored but Firebase config values are needed to run the app.
- Copy from an existing working `.env` or use the project's Firebase console.
