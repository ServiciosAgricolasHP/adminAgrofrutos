import { createService } from "./firestoreBase";

export const faenasService = createService("faena", "faenas");
export const subfaenasService = createService("subfaena", "subfaenas");
export const cyclesService = createService("cycle", "cycles");

// Workers: high write/read ratio (new workers, edits to bank details, etc.)
// Every mutation defaults to additive cache updates so the persisted 2h list
// cache stays warm and the picker doesn't trigger a full re-fetch after each
// new worker is added.
const _workers = createService("worker", "worker");
export const workersService = {
  ..._workers,
  create: (data, opts = {}) => _workers.create(data, { additive: true, ...opts }),
  update: (id, data, opts = {}) => _workers.update(id, data, { additive: true, ...opts }),
  upsert: (id, data, opts = {}) => _workers.upsert(id, data, { additive: true, ...opts }),
  remove: (id, opts = {}) => _workers.remove(id, { additive: true, ...opts }),
};

export const workdaysService = createService("workday", "workdays");
export const groupLeadersService = createService("groupLeader", "groupLeader");
export const payrollSnapshotsService = createService("payrollSnapshot", "payrollSnapshots");
export const interestLinksService = createService("interestLink", "interestLinks");
// Empresas emisoras / receptoras — el sistema soporta múltiples empresas
// (al menos 3) cada una con su RUT, razón social y alias para display.
// Los DTE quedan namespaceados por `companyId` así no se colisionan folios
// entre empresas (mismo proveedor puede facturar a varias empresas con el
// mismo folio).
export const companiesService = createService("company", "companies");

// Documentos tributarios electrónicos (DTE) importados desde el SII.
// Por ahora `source: "sii_import"` es el único origen; cuando se sume emisión
// directa, se agregará `source: "self_emitted"`. El doc id es determinístico
// (`{companyId}_V_{tipo}_{folio}` para ventas; `{companyId}_C_{rutProveedorSinDV}_{tipo}_{folio}`
// para compras) para que reimportar el mismo período sea idempotente — escribe
// encima del existente sin duplicar.
export const dteDocumentsService = createService("dteDocument", "dteDocuments");
export { tripsService as transportsService, paymentsService as transportPaymentsService } from "./transportsService";
export const logsService = createService("log", "logs");

// Fichas de "Información y Cuentas" — libreta compartida de contactos (persona
// o empresa) con datos bancarios de fácil acceso para copiar/pegar. Modelo
// independiente: no se vincula a `worker` ni `companies`; el usuario crea sus
// propias fichas. Ver `src/screens/InfoAccounts.jsx`.
export const contactCardsService = createService("contactCard", "contactCards");

// Indicadores del banner (sueldo base, valor día, valor hora extra). Se editan
// manualmente desde el header y se muestran tipo ticker del dólar. Un único doc
// `indicators/main` con los 3 valores — no hace falta más para valores fijos.
export const indicatorsService = createService("indicator", "indicators");

// Pesajes de cosecha escaneados por QR (app scan_IS) — colección plana,
// log de eventos (N por trabajador por día). Fuente de verdad; nunca se edita
// desde acá, solo se lee para sincronizar hacia `workdays`. Ver HarvestQr.jsx.
export const harvestWeightsService = createService("harvestWeight", "harvestWeights");

// Config/puente entre un prefijo de QR físico y el (faena, ciclo, labor)
// vigente al que debe sincronizarse. Doc id = el prefijo (ej. "HP"). El
// ciclo/labor vigente se reapunta a mano cada vez que se abre un ciclo nuevo
// — deliberadamente semi-manual, ver HarvestQr.jsx.
export const qrPrefixesService = createService("qrPrefix", "qrPrefixes");

// Libro de precios — registro contable independiente de faenas/labores y sus
// precios (histórico, incluye faenas "dummy" que no viven en `faenas`). No
// alimenta ni depende de cycles/workdays. Ver PriceBook.jsx.
export const priceBookService = createService("priceBookEntry", "priceBookEntries");
// Config chica y compartida del libro de precios (ej. qué faenas reales se
// esconden del selector porque su nombre no es legible). Un único doc `main`,
// mismo patrón que `indicators/main`.
export const priceBookConfigService = createService("priceBookConfig", "priceBookConfig");

// Centros de costo ficticios para el Libro de Facturación — catálogo global
// (compartido entre empresas) para etiquetar manualmente documentos que no
// calzan con la agrupación por proveedor (ej. "Arriendo", "Mantención").
// "Combustibles" es aparte: sigue siendo 100% automático por código SII de
// "otro impuesto", no vive en esta colección. Ver Facturacion.jsx.
export const costCentersService = createService("costCenter", "costCenters");

export { logAction } from "./logger";
