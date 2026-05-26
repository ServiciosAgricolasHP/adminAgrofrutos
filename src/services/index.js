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

export { logAction } from "./logger";
