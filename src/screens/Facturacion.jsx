// Pantalla de facturación — v2: multi-empresa, vista por mes actual con
// toggle de auditoría histórica, estados de pago (unpaid/paid/factored), y
// reemplazo por período con borrado de huérfanos.
//
// La emisión sigue manual en el portal SII. Acá solo se importa el RCV
// mensual y se gestiona el estado de pago de cada factura.

import React, { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toPng, toBlob } from "html-to-image";
import { writeBatch, doc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import { companiesService, dteDocumentsService } from "../services";
import { parseSiiRcvCsv, dteTypeLabel, buildDteDocId, normalizeRut, extractRutFromFilename } from "../utils/siiCsvParser";
import { formatRutForDisplay } from "../utils/rutUtils";
import Modal from "../components/Modal";
import { useToast } from "../contexts/ToastContext";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );
const fmtNumber = (v) =>
  new Intl.NumberFormat("es-CL", { minimumFractionDigits: 0 }).format(Number(v) || 0);

// Tipos de DTE que en los totales se computan con signo negativo (notas de
// crédito — restan del neto/IVA/total del período).
const CREDIT_NOTE_TYPES = new Set([61, 112]);

// Mes actual en formato YYYY-MM. Se usa como filtro por default — la vista
// operativa muestra solo el mes en curso. Para ver otros períodos hay que
// activar el toggle de Auditoría.
function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Etiquetas + colores para los estados de pago. Los 5 estados aplicables a
// facturas/boletas afectas:
//   - unpaid: pendiente de cobro/pago.
//   - paid: completo.
//   - net_only: el cliente solo pagó el NETO (retuvo el IVA — caso típico de
//     servicios con retención al SII). Se trackea aparte en el tab "Retenciones".
//   - factored: factura cedida vía factoring (el cliente paga al factor; queda
//     "solo IVA" en libros).
//   - cancelled: factura anulada por una NC posterior. Se marca manualmente
//     (eventualmente con sugerencia auto cuando detectamos NC candidata).
// Las notas de crédito (tipos 61/112) no usan estos estados — se muestran con
// un chip fijo "Anulada" porque su naturaleza es justamente anular otra factura.
const PAYMENT_STATUSES = {
  unpaid: { label: "No pagado", chip: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]" },
  paid: { label: "Pagado", chip: "bg-[var(--color-success-soft)] text-[var(--color-success)]" },
  net_only: { label: "Solo neto", chip: "bg-[var(--color-warning-soft)] text-[var(--color-text)]" },
  factored: { label: "Solo IVA", chip: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" },
  cancelled: { label: "Anulada", chip: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]" },
};
const NC_STATE = { label: "Anulada", chip: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]" };

// Tipos de pago que el usuario puede registrar en una factura. Cada entrada
// del array `payments` tiene un `kind` que sirve para categorizar (auditoría)
// y para sugerir un monto al agregar. La suma de `amount` de todos los pagos
// no puede superar `factura.total` — validamos al guardar.
const PAYMENT_KINDS = {
  abono: { label: "Abono" },
  neto: { label: "Solo neto" },
  iva: { label: "Solo IVA" },
  total: { label: "Total" },
};

function paymentsSummary(dteDoc) {
  const payments = Array.isArray(dteDoc?.payments) ? dteDoc.payments : [];
  const amountPaid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const balance = (Number(dteDoc?.total) || 0) - amountPaid;
  return { payments, amountPaid, balance };
}

function newPaymentId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Categorías de facturas pendientes que aparecen en el modal "Ver pendientes".
// Cada factura no-anulada / no-pagada cae en una sola categoría según su
// estado + sus pagos registrados:
//   - full:    estado "unpaid" sin abonos → debe el total completo.
//   - partial: estado "unpaid" con abonos pero saldo > 0.
//   - iva:     estado "net_only" o "factored" → IVA pendiente (saldo IVA - lo
//              que ya esté cubierto por pagos registrados sobre el neto).
const PENDIENTE_CATS = {
  full:    { key: "full",    label: "Factura completa pendiente", order: 1, hex: "#ffd6d6" },
  partial: { key: "partial", label: "Abono parcial",              order: 2, hex: "#fff2cc" },
  iva:     { key: "iva",     label: "IVA pendiente",              order: 3, hex: "#dde9ff" },
};

// Devuelve `{ category, amount }` para una factura pendiente, o null si no
// tiene nada pendiente (pagada, anulada, NC, factura cerrada, etc.).
// `factored` (Solo IVA — cedida vía factoring) se considera **pagada** para
// efectos de cobranza: el factor ya pagó el neto al emisor y el cliente queda
// debiéndole al factor, no a nosotros. El IVA es una obligación tributaria
// separada que se gestiona en el F29, no en este flujo.
function pendingFor(d) {
  if (CREDIT_NOTE_TYPES.has(Number(d.tipo))) return null;
  const st = d.paymentStatus || "unpaid";
  if (st === "cancelled" || st === "paid" || st === "factored") return null;
  const total = Number(d.total) || 0;
  const neto = Number(d.neto) || 0;
  const iva = Number(d.iva) || 0;
  const paid = Number(d.amountPaid) || 0;
  if (st === "unpaid") {
    const pending = total - paid;
    if (pending <= 0.5) return null;
    return { category: paid > 0 ? "partial" : "full", amount: pending };
  }
  if (st === "net_only") {
    // Lo que ya está cubierto por pagos por encima del neto se imputa al IVA.
    const ivaCovered = Math.max(0, paid - neto);
    const pending = Math.max(0, iva - ivaCovered);
    if (pending <= 0.5) return null;
    return { category: "iva", amount: pending };
  }
  return null;
}

// Heurística para sugerir que una factura está anulada por una NC.
// Match: misma empresa + kind + contraparte (RUT) + total exacto, con NC
// emitida en fecha >= factura. No es 100% confiable (un cliente con dos
// facturas del mismo monto + una NC dispara falso positivo en ambas), por eso
// es solo SUGERENCIA — el usuario decide marcarla como Anulada.
function findCancellingNcs(dteDoc, allDocs) {
  if (CREDIT_NOTE_TYPES.has(Number(dteDoc.tipo))) return [];
  const total = Number(dteDoc.total) || 0;
  if (total <= 0) return [];
  const contraparteRut = dteDoc.kind === "venta" ? dteDoc.rutReceptor : dteDoc.rutEmisor;
  if (!contraparteRut) return [];
  const out = [];
  for (const d of allDocs) {
    if (!CREDIT_NOTE_TYPES.has(Number(d.tipo))) continue;
    if (d.companyId !== dteDoc.companyId) continue;
    if (d.kind !== dteDoc.kind) continue;
    const dRut = d.kind === "venta" ? d.rutReceptor : d.rutEmisor;
    if (dRut !== contraparteRut) continue;
    if ((Number(d.total) || 0) !== total) continue;
    if (d.fechaEmision && dteDoc.fechaEmision && d.fechaEmision < dteDoc.fechaEmision) continue;
    out.push(d);
  }
  return out;
}

// Clave de localStorage para recordar la última empresa elegida por el usuario
// entre sesiones — UX típica: el usuario casi siempre trabaja con la misma
// empresa, no tiene sentido obligarlo a re-seleccionarla cada vez.
const LS_SELECTED_COMPANY = "facturacion.selectedCompanyId";

export default function Facturacion() {
  const toast = useToast();
  const [companies, setCompanies] = useState([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(() => {
    try { return localStorage.getItem(LS_SELECTED_COMPANY) || ""; } catch { return ""; }
  });
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kindTab, setKindTab] = useState("venta");
  // Vista por defecto = mes actual. Toggle "Auditoría" libera el filtro de
  // período (permite navegar todos los meses por empresa).
  const [auditMode, setAuditMode] = useState(false);
  const [periodoFilter, setPeriodoFilter] = useState(currentPeriod());
  const [tipoFilter, setTipoFilter] = useState("");
  const [paymentFilter, setPaymentFilter] = useState(""); // "" | "unpaid" | "paid" | "factored"
  const [search, setSearch] = useState("");
  // Sort de la tabla principal: click en un header alterna asc/desc; default
  // es fechaEmision desc para mantener el comportamiento histórico.
  const [sortBy, setSortBy] = useState({ key: "fechaEmision", dir: "desc" });
  // Modals
  const [importPreview, setImportPreview] = useState(null);
  const [importCompanyId, setImportCompanyId] = useState("");
  const [importing, setImporting] = useState(false);
  const [companiesModalOpen, setCompaniesModalOpen] = useState(false);
  const [pendientesModalOpen, setPendientesModalOpen] = useState(false);
  // Modal de detalle: muestra todos los campos del DTE + notas editables.
  // Se abre al click en el botón ℹ de cada fila.
  const [detailDoc, setDetailDoc] = useState(null);
  // Off-screen ref del printable de Retenciones (para html-to-image / print).
  const retencionesPrintRef = useRef(null);
  const [exportBusy, setExportBusy] = useState("");
  // Refs por contraparte (mapa rut→DOM node) + flag de busy por grupo. Cada
  // grupo se renderiza off-screen con su propio printable individual y los
  // handlers usan estos refs para exportar/copiar/imprimir ese grupo solo.
  const groupPrintRefs = useRef(new Map());
  const [groupBusy, setGroupBusy] = useState({}); // { [groupKey]: "copy"|"png"|... }
  const groupKey = (g) => g?.rut || "__sin_rut__";
  const setBusyFor = (key, action) =>
    setGroupBusy((prev) => {
      const next = { ...prev };
      if (action) next[key] = action; else delete next[key];
      return next;
    });

  const companiesById = useMemo(
    () => new Map(companies.map((c) => [c.id, c])),
    [companies],
  );

  const loadAll = async () => {
    setLoading(true);
    try {
      const [comps, list] = await Promise.all([
        companiesService.list({ order: ["razonSocial", "asc"], cache: true, ttl: 600_000 }),
        dteDocumentsService.list({ order: ["fechaEmision", "desc"], cache: true, ttl: 600_000 }),
      ]);
      setCompanies(comps);
      setDocs(list);
      // Si lo guardado en localStorage ya no existe (empresa borrada) o no hay
      // nada elegido, caemos al primero. Sino respetamos la última elección.
      if (comps.length > 0 && !comps.some((c) => c.id === selectedCompanyId)) {
        setSelectedCompanyId(comps[0].id);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Persiste la empresa elegida — la próxima vez que el usuario entre a la
  // pantalla, arranca con la misma seleccionada.
  useEffect(() => {
    try { localStorage.setItem(LS_SELECTED_COMPANY, selectedCompanyId || ""); } catch { /* noop */ }
  }, [selectedCompanyId]);

  // Cuando se entra en auditoría, dejamos que el usuario navegue períodos.
  // Cuando se sale, volvemos a fijar el mes actual.
  useEffect(() => {
    if (!auditMode) setPeriodoFilter(currentPeriod());
  }, [auditMode]);

  // Tab "Retenciones" muestra todos los DTE (ventas y compras) con estado
  // `net_only` agrupados por contraparte. Es ortogonal a kindTab pero lo
  // tratamos como un valor más de la misma variable para que el switch sea
  // limpio en la UI.
  const isRetencionesView = kindTab === "retenciones";

  // Filtros del listado.
  const filtered = useMemo(() => {
    let arr = docs;
    if (isRetencionesView) {
      // En retenciones: filtro implícito por estado, sin restringir kind.
      arr = arr.filter((d) => (d.paymentStatus || "unpaid") === "net_only");
    } else {
      arr = arr.filter((d) => d.kind === kindTab);
    }
    if (selectedCompanyId) arr = arr.filter((d) => d.companyId === selectedCompanyId);
    if (periodoFilter) arr = arr.filter((d) => d.periodo === periodoFilter);
    if (tipoFilter) arr = arr.filter((d) => String(d.tipo) === String(tipoFilter));
    if (!isRetencionesView && paymentFilter) {
      arr = arr.filter((d) => (d.paymentStatus || "unpaid") === paymentFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      arr = arr.filter((d) => {
        const razonV = (d.razonSocialReceptor || "").toLowerCase();
        const razonC = (d.razonSocialEmisor || "").toLowerCase();
        const rutV = (d.rutReceptor || "").toLowerCase();
        const rutC = (d.rutEmisor || "").toLowerCase();
        return (
          razonV.includes(q) || razonC.includes(q) ||
          rutV.includes(q) || rutC.includes(q) ||
          String(d.folio).includes(q)
        );
      });
    }
    return arr;
  }, [docs, kindTab, isRetencionesView, selectedCompanyId, periodoFilter, tipoFilter, paymentFilter, search]);

  // Sort. Aplicado solo en la tabla principal (ventas/facturas/compras) — la
  // vista de retenciones tiene su propio agrupador. NCs ordenan junto a las
  // demás aunque el "estado" sea fijo "Anulada".
  const sortGetter = (d, key) => {
    switch (key) {
      case "fechaEmision": return d.fechaEmision || "";
      case "tipo": return Number(d.tipo) || 0;
      case "folio": return Number(d.folio) || 0;
      case "razon": return (kindTab === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor) || "";
      case "rut": return (kindTab === "venta" ? d.rutReceptor : d.rutEmisor) || "";
      case "neto": return Number(d.neto) || 0;
      case "iva": return Number(d.iva) || 0;
      case "total": return Number(d.total) || 0;
      case "pagado": return Number(d.amountPaid) || 0;
      case "saldo": return (Number(d.total) || 0) - (Number(d.amountPaid) || 0);
      case "estado": return CREDIT_NOTE_TYPES.has(Number(d.tipo)) ? "zz_anulada" : (d.paymentStatus || "unpaid");
      default: return 0;
    }
  };
  const sortedFiltered = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = sortGetter(a, sortBy.key);
      const bv = sortGetter(b, sortBy.key);
      let cmp;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortBy.dir === "asc" ? cmp : -cmp;
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortBy, kindTab]);
  const toggleSort = (key) => {
    setSortBy((cur) => cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "fechaEmision" ? "desc" : "asc" });
  };

  // Lista de contrapartes únicas (razón social) para el datalist del buscador.
  // Saca de los docs filtrados por empresa y kind (sin aplicar el resto de
  // filtros para que el dropdown muestre todo el universo posible).
  const contrapartesAutocomplete = useMemo(() => {
    const set = new Set();
    for (const d of docs) {
      if (!isRetencionesView && d.kind !== kindTab) continue;
      if (selectedCompanyId && d.companyId !== selectedCompanyId) continue;
      const razon = d.kind === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor;
      if (razon) set.add(razon);
    }
    return [...set].sort();
  }, [docs, kindTab, isRetencionesView, selectedCompanyId]);

  // Retenciones agrupadas: por contraparte (rutContraparte) → suma neto/iva/total
  // + lista de docs. Para el tab Retenciones.
  const retencionesByContraparte = useMemo(() => {
    if (!isRetencionesView) return [];
    const map = new Map();
    for (const d of filtered) {
      const rutContra = d.kind === "venta" ? d.rutReceptor : d.rutEmisor;
      const razonContra = d.kind === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor;
      const key = rutContra || "__sin_rut__";
      if (!map.has(key)) {
        map.set(key, {
          rut: rutContra, razon: razonContra,
          neto: 0, iva: 0, total: 0, count: 0, docs: [],
        });
      }
      const g = map.get(key);
      g.neto += Number(d.neto) || 0;
      g.iva += Number(d.iva) || 0;
      g.total += Number(d.total) || 0;
      g.count++;
      g.docs.push(d);
    }
    return [...map.values()].sort((a, b) => b.iva - a.iva);
  }, [filtered, isRetencionesView]);

  const periodoOptions = useMemo(() => {
    const set = new Set();
    for (const d of docs) {
      if (d.kind === kindTab && d.periodo) {
        if (!selectedCompanyId || d.companyId === selectedCompanyId) set.add(d.periodo);
      }
    }
    set.add(currentPeriod());
    return [...set].sort().reverse();
  }, [docs, kindTab, selectedCompanyId]);

  const tipoOptions = useMemo(() => {
    const set = new Set();
    for (const d of docs) {
      if (d.kind === kindTab) {
        if (!selectedCompanyId || d.companyId === selectedCompanyId) set.add(d.tipo);
      }
    }
    return [...set].sort((a, b) => a - b);
  }, [docs, kindTab, selectedCompanyId]);

  // Totales con signo: NC restan en lugar de sumar. Además contamos los NCs
  // por separado para mostrar un card específico, y desglosamos por estado de
  // pago los montos (unpaid/net_only/factored) sumando solo positivos (facturas,
  // no NCs).
  const totals = useMemo(() => {
    const t = {
      neto: 0, iva: 0, total: 0, count: 0,
      ncTotal: 0, ncCount: 0,
      unpaidTotal: 0, netOnlyTotal: 0, netOnlyIva: 0, factoredTotal: 0,
    };
    for (const d of filtered) {
      const sign = CREDIT_NOTE_TYPES.has(Number(d.tipo)) ? -1 : 1;
      t.neto += sign * (Number(d.neto) || 0);
      t.iva += sign * (Number(d.iva) || 0);
      t.total += sign * (Number(d.total) || 0);
      t.count++;
      if (sign < 0) {
        t.ncTotal += Number(d.total) || 0;
        t.ncCount++;
      }
      const st = d.paymentStatus || "unpaid";
      if (sign > 0) {
        if (st === "unpaid") t.unpaidTotal += Number(d.total) || 0;
        if (st === "net_only") {
          t.netOnlyTotal += Number(d.total) || 0;
          t.netOnlyIva += Number(d.iva) || 0;
        }
        if (st === "factored") t.factoredTotal += Number(d.total) || 0;
      }
    }
    return t;
  }, [filtered]);

  // Mapa de docId → [NCs candidatas]. Se calcula sobre TODOS los docs (no solo
  // filtered) para que una NC del mismo período/empresa cuente aunque el
  // usuario esté filtrando por algo más. Excluye facturas ya marcadas como
  // anuladas — para esas la sugerencia ya no aplica.
  const cancellingByDocId = useMemo(() => {
    const m = new Map();
    for (const d of docs) {
      if (CREDIT_NOTE_TYPES.has(Number(d.tipo))) continue;
      if ((d.paymentStatus || "unpaid") === "cancelled") continue;
      const ncs = findCancellingNcs(d, docs);
      if (ncs.length > 0) m.set(d.id, ncs);
    }
    return m;
  }, [docs]);

  // Lista global de facturas pendientes (cualquier período) para la empresa
  // seleccionada — alimenta el modal "Ver pendientes". **Solo ventas** (kind
  // === "venta"): las compras tienen su propio flujo de seguimiento y no
  // mezclamos cuentas por cobrar con cuentas por pagar en la misma vista.
  // Cada item lleva `_category` y `_pending` calculados por `pendingFor`.
  // Ordenado por categoría (full → partial → iva) y luego por fecha ascendente.
  const pendientesList = useMemo(() => {
    const arr = [];
    for (const d of docs) {
      if (d.kind !== "venta") continue;
      if (selectedCompanyId && d.companyId !== selectedCompanyId) continue;
      const p = pendingFor(d);
      if (!p) continue;
      arr.push({ ...d, _category: p.category, _pending: p.amount });
    }
    arr.sort((a, b) => {
      const oa = PENDIENTE_CATS[a._category].order;
      const ob = PENDIENTE_CATS[b._category].order;
      if (oa !== ob) return oa - ob;
      return String(a.fechaEmision || "").localeCompare(String(b.fechaEmision || ""));
    });
    return arr;
  }, [docs, selectedCompanyId]);

  const pendientesTotals = useMemo(() => {
    const t = { full: 0, partial: 0, iva: 0, total: 0, count: { full: 0, partial: 0, iva: 0 } };
    for (const d of pendientesList) {
      t[d._category] += d._pending;
      t.total += d._pending;
      t.count[d._category]++;
    }
    return t;
  }, [pendientesList]);

  // --- IMPORT ---

  const openImport = () => {
    if (companies.length === 0) {
      toast.warning("Tenés que registrar al menos una empresa antes de importar. Usá el botón 🏢 Empresas.");
      return;
    }
    setImportCompanyId(selectedCompanyId || companies[0].id);
  };

  // Multi-file: parsea cada archivo independientemente. Cada uno trae su propia
  // kind (ventas/compras) detectada del header, sus stats, sus errores, y un
  // RUT extraído del filename para detectar mismatch con la empresa elegida.
  const onFilesPick = async (files) => {
    if (!files || files.length === 0) return;
    if (!importCompanyId) {
      toast.warning("Seleccioná una empresa antes de elegir los archivos.");
      return;
    }
    const company = companiesById.get(importCompanyId);
    const companyRutNormalized = company?.rut ? normalizeRut(company.rut) : "";
    const parsedFiles = [];
    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseSiiRcvCsv(buffer, { companyRut: company?.rut || "" });
        const detectedRut = extractRutFromFilename(file.name);
        const detectedRutNormalized = detectedRut ? normalizeRut(detectedRut) : "";
        const rutMismatch = !!(detectedRutNormalized && companyRutNormalized && detectedRutNormalized !== companyRutNormalized);
        const recordsWithId = parsed.records.map((r) => ({
          ...r,
          id: buildDteDocId({
            companyId: importCompanyId,
            kind: r.kind,
            tipo: r.tipo,
            folio: r.folio,
            rutEmisor: r.rutEmisor,
            rutReceptor: r.rutReceptor,
          }),
          companyId: importCompanyId,
          companyAlias: company?.alias || company?.razonSocial || "",
          sourceFile: file.name,
        }));
        parsedFiles.push({
          name: file.name,
          kind: parsed.kind,
          records: recordsWithId,
          errors: parsed.errors,
          stats: parsed.stats,
          detectedRut: detectedRutNormalized,
          rutMismatch,
          excluded: false, // el usuario puede excluir archivos sospechosos
        });
      } catch (err) {
        parsedFiles.push({
          name: file.name,
          kind: null,
          records: [],
          errors: [{ line: 0, message: err.message || String(err) }],
          stats: { count: 0, byTipo: {}, totalAmount: 0 },
          detectedRut: extractRutFromFilename(file.name),
          rutMismatch: false,
          excluded: true,
          parseFailed: true,
        });
      }
    }
    setImportPreview({ files: parsedFiles });
  };

  // Permite togglear si un archivo se incluye o no en el import desde el modal.
  const toggleFileExclusion = (fileName) => {
    setImportPreview((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        files: prev.files.map((f) =>
          f.name === fileName ? { ...f, excluded: !f.excluded } : f,
        ),
      };
    });
  };

  // Confirmar import: junta records de TODOS los files no excluidos, agrupa
  // por (companyId, kind, periodo) y para cada scope hace un "replace" —
  // borra los huérfanos (que estaban antes y ya no aparecen) y escribe los
  // nuevos/actualizados. Cada scope se procesa en una transacción separada.
  const confirmImport = async () => {
    if (!importPreview) return;
    setImporting(true);
    try {
      const allRecords = importPreview.files
        .filter((f) => !f.excluded && !f.parseFailed)
        .flatMap((f) => f.records);
      if (allRecords.length === 0) {
        toast.warning("No hay registros para importar (todos los archivos están excluidos o fallaron).");
        setImporting(false);
        return;
      }
      const companyId = importCompanyId;
      // Agrupar por (kind, periodo) — companyId es el mismo para todo el batch.
      const byScope = new Map();
      for (const r of allRecords) {
        const key = `${r.kind}__${r.periodo || "__no_period__"}`;
        if (!byScope.has(key)) byScope.set(key, { kind: r.kind, periodo: r.periodo, records: [] });
        byScope.get(key).records.push(r);
      }

      let totalNew = 0, totalOverwrite = 0, totalDeleted = 0;
      const uid = auth.currentUser?.uid || null;

      for (const { kind, periodo, records } of byScope.values()) {
        // Existentes en Firestore para (companyId, kind, periodo).
        const existing = await dteDocumentsService.list({
          wheres: [
            ["companyId", "==", companyId],
            ["kind", "==", kind],
            ["periodo", "==", periodo],
          ],
        });
        const newIds = new Set(records.map((r) => r.id));
        const orphans = existing.filter((e) => !newIds.has(e.id));
        const existingIds = new Set(existing.map((e) => e.id));

        // Bulk write en chunks (límite Firestore 500 ops/batch).
        const CHUNK = 450;
        const writes = [
          ...orphans.map((o) => ({ kind: "delete", id: o.id })),
          ...records.map((r) => ({ kind: "set", record: r })),
        ];
        for (let i = 0; i < writes.length; i += CHUNK) {
          const slice = writes.slice(i, i + CHUNK);
          const batch = writeBatch(db);
          for (const w of slice) {
            if (w.kind === "delete") {
              batch.delete(doc(db, "dteDocuments", w.id));
            } else {
              const { id, ...rest } = w.record;
              const wasExisting = existingIds.has(id);
              const patch = {
                ...rest,
                importedAt: serverTimestamp(),
                importedBy: uid,
              };
              // Preservar paymentStatus existente al reimportar — solo seteamos
              // "unpaid" si el doc es nuevo.
              if (!wasExisting) patch.paymentStatus = "unpaid";
              batch.set(doc(db, "dteDocuments", id), patch, { merge: true });
            }
          }
          await batch.commit();
        }
        totalDeleted += orphans.length;
        for (const r of records) {
          if (existingIds.has(r.id)) totalOverwrite++;
          else totalNew++;
        }
      }
      dteDocumentsService.invalidate();
      const filesProcessed = importPreview.files.filter((f) => !f.excluded && !f.parseFailed).length;
      toast.success(
        `${filesProcessed} archivo${filesProcessed === 1 ? "" : "s"} procesado${filesProcessed === 1 ? "" : "s"}.\n` +
        `Nuevos: ${totalNew} · Sobreescritos: ${totalOverwrite} · Huérfanos eliminados: ${totalDeleted}\n` +
        `Total: ${allRecords.length}`,
        { title: "Importación lista" },
      );
      setImportPreview(null);
      setImportCompanyId("");
      await loadAll();
    } catch (err) {
      toast.error("Error al guardar: " + (err.message || String(err)));
    } finally {
      setImporting(false);
    }
  };

  // --- Marcar estado de pago de una factura ---
  // Setter directo del estado — el UI lo expone como `<select>` por fila
  // (con las 4 opciones) en vez del antiguo botón cíclico, que era confuso
  // con más de 3 estados.
  const setPaymentStatus = async (dteDoc, newStatus) => {
    if (!PAYMENT_STATUSES[newStatus]) return;
    if ((dteDoc.paymentStatus || "unpaid") === newStatus) return;
    try {
      await dteDocumentsService.update(dteDoc.id, {
        paymentStatus: newStatus,
        paymentStatusSetAt: serverTimestamp(),
        paymentStatusSetBy: auth.currentUser?.uid || null,
      });
      setDocs((prev) => prev.map((d) => (d.id === dteDoc.id ? { ...d, paymentStatus: newStatus } : d)));
    } catch (err) {
      toast.error("Error al cambiar estado: " + (err.message || err));
    }
  };

  // Guarda notas / detalle libre asociado a un DTE. Útil para registrar
  // glosa que el SII no incluye en el CSV o para tracking interno.
  const saveDocNotes = async (dteDoc, notes) => {
    try {
      await dteDocumentsService.update(dteDoc.id, { notes });
      setDocs((prev) => prev.map((d) => (d.id === dteDoc.id ? { ...d, notes } : d)));
      setDetailDoc((cur) => (cur?.id === dteDoc.id ? { ...cur, notes } : cur));
    } catch (err) {
      toast.error("Error al guardar notas: " + (err.message || err));
    }
  };

  // Guarda el array completo de pagos. Persistimos `amountPaid` denormalizado
  // por si en el futuro queremos filtrar/ordenar por saldo sin tener que
  // recorrer el array en cada doc.
  const saveDocPayments = async (dteDoc, payments) => {
    const amountPaid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    try {
      await dteDocumentsService.update(dteDoc.id, { payments, amountPaid });
      setDocs((prev) => prev.map((d) => (d.id === dteDoc.id ? { ...d, payments, amountPaid } : d)));
      setDetailDoc((cur) => (cur?.id === dteDoc.id ? { ...cur, payments, amountPaid } : cur));
    } catch (err) {
      toast.error("Error al guardar pagos: " + (err.message || err));
    }
  };

  // --- Export de Retenciones (infografía) ---
  // Captura el off-screen printable. El patrón es el mismo que usan los otros
  // resúmenes (PrintablePayrollTable, PrintableSummary, etc.): el printable se
  // renderiza fuera de pantalla y los botones lo capturan con html-to-image.

  const exportFileBase = useMemo(() => {
    const company = companiesById.get(selectedCompanyId);
    const alias = (company?.alias || company?.razonSocial || "empresa").replace(/[^\w-]+/g, "_");
    const period = periodoFilter || "todos";
    return `Retenciones_${alias}_${period}`;
  }, [companiesById, selectedCompanyId, periodoFilter]);

  const handleRetencionesCopy = async () => {
    if (!retencionesPrintRef.current) return;
    setExportBusy("copy");
    try {
      const blob = await toBlob(retencionesPrintRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada al portapapeles");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setExportBusy("");
    }
  };

  const handleRetencionesDownload = async () => {
    if (!retencionesPrintRef.current) return;
    setExportBusy("png");
    try {
      const dataUrl = await toPng(retencionesPrintRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = `${exportFileBase}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      toast.error("Error al generar PNG: " + (err.message || err));
    } finally {
      setExportBusy("");
    }
  };

  const handleRetencionesPrint = () => {
    if (!retencionesPrintRef.current) return;
    const html = retencionesPrintRef.current.outerHTML;
    const win = window.open("", "_blank", "width=1000,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Retenciones</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; }
        thead th { background: #92d050 !important; text-align: left; }
        @media print { @page { size: landscape; margin: 12mm; } }
      </style>
    </head><body>${html}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  };

  // XLSX siguiendo la convención del proyecto: col A vacía width 6, fila 1
  // vacía, datos desde B2. Una sola hoja "Resumen" con un row por contraparte,
  // y opcionalmente una segunda "Detalle" con cada factura individual.
  const handleRetencionesXlsx = async () => {
    setExportBusy("xlsx");
    try {
      const ExcelJS = (await import("exceljs")).default || (await import("exceljs"));
      const wb = new ExcelJS.Workbook();
      const company = companiesById.get(selectedCompanyId);
      const period = periodoFilter || "Todos los períodos";

      // ============ Hoja Resumen ============
      const ws = wb.addWorksheet("Resumen");
      ws.getColumn(1).width = 6; // col A vacía + half-width (convención)
      ws.getColumn(2).width = 6;  // #
      ws.getColumn(3).width = 40; // Empresa
      ws.getColumn(4).width = 16; // RUT
      ws.getColumn(5).width = 14; // N° Facturas
      ws.getColumn(6).width = 18; // Neto
      ws.getColumn(7).width = 18; // IVA Retenido
      ws.getColumn(8).width = 18; // Total

      // Título (B2): "Retenciones — empresa — período"
      ws.getCell("B2").value = `RETENCIONES — ${company?.alias || company?.razonSocial || ""} — ${period}`;
      ws.getCell("B2").font = { bold: true, size: 14 };
      ws.mergeCells("B2:H2");

      // Headers en fila 4
      const HR = 4;
      const headers = ["#", "Empresa", "RUT", "N° Facturas", "Neto", "IVA Retenido", "Total"];
      headers.forEach((h, i) => {
        const c = ws.getCell(HR, 2 + i);
        c.value = h;
        c.font = { bold: true };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF92D050" } };
        c.alignment = { horizontal: i === 0 ? "center" : i <= 2 ? "left" : "right", vertical: "middle" };
        c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
      });

      const dataStart = HR + 1;
      let r = dataStart;
      for (let i = 0; i < retencionesByContraparte.length; i++) {
        const g = retencionesByContraparte[i];
        const row = [i + 1, g.razon || "—", formatRutForDisplay(g.rut) || "—", g.count, g.neto, g.iva, g.total];
        row.forEach((v, j) => {
          const c = ws.getCell(r, 2 + j);
          c.value = v;
          c.alignment = { horizontal: j === 0 ? "center" : j <= 2 ? "left" : "right" };
          c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
          if (j >= 4) c.numFmt = '"$"#,##0';
        });
        r++;
      }
      const lastDataRow = r - 1;
      const totalRow = r;

      // Fila de totales con fórmulas vivas.
      const totalLabel = ws.getCell(totalRow, 2);
      totalLabel.value = "TOTAL";
      totalLabel.font = { bold: true };
      totalLabel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
      totalLabel.alignment = { horizontal: "left" };
      // merge B:D para el label
      ws.mergeCells(totalRow, 2, totalRow, 4);
      for (let col = 2; col <= 8; col++) {
        const c = ws.getCell(totalRow, col);
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
        c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
        c.font = { bold: true };
      }
      // Conteo + sumas con fórmulas (referencia las celdas E/F/G/H del rango).
      if (retencionesByContraparte.length > 0) {
        ws.getCell(totalRow, 5).value = { formula: `SUM(E${dataStart}:E${lastDataRow})`, result: retencionesByContraparte.reduce((s, g) => s + g.count, 0) };
        ws.getCell(totalRow, 6).value = { formula: `SUM(F${dataStart}:F${lastDataRow})`, result: totals.netOnlyTotal - totals.netOnlyIva };
        ws.getCell(totalRow, 7).value = { formula: `SUM(G${dataStart}:G${lastDataRow})`, result: totals.netOnlyIva };
        ws.getCell(totalRow, 8).value = { formula: `SUM(H${dataStart}:H${lastDataRow})`, result: totals.netOnlyTotal };
      }
      ws.getCell(totalRow, 5).alignment = { horizontal: "right" };
      ws.getCell(totalRow, 6).alignment = { horizontal: "right" };
      ws.getCell(totalRow, 7).alignment = { horizontal: "right" };
      ws.getCell(totalRow, 8).alignment = { horizontal: "right" };
      ws.getCell(totalRow, 6).numFmt = '"$"#,##0';
      ws.getCell(totalRow, 7).numFmt = '"$"#,##0';
      ws.getCell(totalRow, 8).numFmt = '"$"#,##0';

      // ============ Hoja Detalle (todas las facturas individuales) ============
      // Nota: omitimos columna "Tipo" numérico — la columna "Documento" trae
      // el label legible y el número se vuelve ruido en la vista.
      const wsd = wb.addWorksheet("Detalle");
      wsd.getColumn(1).width = 6;
      wsd.getColumn(2).width = 12; // Fecha
      wsd.getColumn(3).width = 26; // Documento (label)
      wsd.getColumn(4).width = 10; // Folio
      wsd.getColumn(5).width = 36; // Contraparte
      wsd.getColumn(6).width = 16; // RUT
      wsd.getColumn(7).width = 16; // Neto
      wsd.getColumn(8).width = 16; // IVA Retenido
      wsd.getColumn(9).width = 16; // Total
      wsd.getCell("B2").value = `DETALLE — ${company?.alias || ""} — ${period}`;
      wsd.getCell("B2").font = { bold: true, size: 14 };
      wsd.mergeCells("B2:I2");
      const dHeaders = ["Fecha", "Documento", "Folio", "Contraparte", "RUT", "Neto", "IVA Retenido", "Total"];
      dHeaders.forEach((h, i) => {
        const c = wsd.getCell(4, 2 + i);
        c.value = h;
        c.font = { bold: true };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF92D050" } };
        c.alignment = { horizontal: i <= 3 ? "left" : "right" };
        c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
      });
      let dr = 5;
      for (const g of retencionesByContraparte) {
        for (const d of g.docs) {
          const cells = [
            d.fechaEmision || "",
            d.tipoLabel || dteTypeLabel(d.tipo),
            d.folio,
            g.razon || "",
            formatRutForDisplay(g.rut) || "",
            Number(d.neto) || 0,
            Number(d.iva) || 0,
            Number(d.total) || 0,
          ];
          cells.forEach((v, j) => {
            const c = wsd.getCell(dr, 2 + j);
            c.value = v;
            c.alignment = { horizontal: j <= 3 ? "left" : "right" };
            c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
            if (j === 6) c.font = { bold: true }; // IVA en bold
            if (j >= 5) c.numFmt = '"$"#,##0';
          });
          dr++;
        }
      }

      // Descargar
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${exportFileBase}.xlsx`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      toast.error("Error al generar XLSX: " + (err.message || err));
    } finally {
      setExportBusy("");
    }
  };

  const selectedCompany = companiesById.get(selectedCompanyId);
  const noCompany = companies.length === 0;

  // ===== Export por contraparte (individual) =====
  // Filename seguro para una contraparte específica.
  const groupFileBase = (g) => {
    const alias = (selectedCompany?.alias || selectedCompany?.razonSocial || "empresa").replace(/[^\w-]+/g, "_");
    const contra = (g.razon || "contraparte").replace(/[^\w-]+/g, "_").slice(0, 40);
    const period = periodoFilter || "todos";
    return `Retencion_${alias}_${contra}_${period}`;
  };

  const handleGroupCopy = async (g) => {
    const key = groupKey(g);
    const el = groupPrintRefs.current.get(key);
    if (!el) return;
    setBusyFor(key, "copy");
    try {
      const blob = await toBlob(el, { backgroundColor: "#ffffff", pixelRatio: 2 });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success(`Copiado: ${g.razon || "contraparte"}`);
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusyFor(key, null);
    }
  };

  const handleGroupPng = async (g) => {
    const key = groupKey(g);
    const el = groupPrintRefs.current.get(key);
    if (!el) return;
    setBusyFor(key, "png");
    try {
      const dataUrl = await toPng(el, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = `${groupFileBase(g)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      toast.error("Error al generar PNG: " + (err.message || err));
    } finally {
      setBusyFor(key, null);
    }
  };

  const handleGroupPrint = (g) => {
    const key = groupKey(g);
    const el = groupPrintRefs.current.get(key);
    if (!el) return;
    const html = el.outerHTML;
    const win = window.open("", "_blank", "width=1000,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Retención ${g.razon || ""}</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; }
        thead th { background: #92d050 !important; text-align: left; }
        @media print { @page { size: landscape; margin: 12mm; } }
      </style>
    </head><body>${html}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  };

  const handleGroupXlsx = async (g) => {
    const key = groupKey(g);
    setBusyFor(key, "xlsx");
    try {
      const ExcelJS = (await import("exceljs")).default || (await import("exceljs"));
      const wb = new ExcelJS.Workbook();
      const company = selectedCompany;
      const period = periodoFilter || "Todos los períodos";
      const ws = wb.addWorksheet("Retención");
      ws.getColumn(1).width = 6;  // col A vacía half-width (convención)
      ws.getColumn(2).width = 12; // Fecha
      ws.getColumn(3).width = 28; // Documento
      ws.getColumn(4).width = 10; // Folio
      ws.getColumn(5).width = 16; // Neto
      ws.getColumn(6).width = 16; // IVA Retenido
      ws.getColumn(7).width = 16; // Total

      ws.getCell("B2").value = `RETENCIÓN — ${company?.alias || company?.razonSocial || ""} · ${period}`;
      ws.getCell("B2").font = { bold: true, size: 14 };
      ws.mergeCells("B2:G2");
      ws.getCell("B3").value = `${g.razon || "—"} · RUT ${formatRutForDisplay(g.rut) || "—"} · ${g.count} factura${g.count === 1 ? "" : "s"}`;
      ws.getCell("B3").font = { italic: true, color: { argb: "FF555555" } };
      ws.mergeCells("B3:G3");

      // Banner explícito de IVA retenido del período — fila 4 destacada.
      ws.getCell("B4").value = `IVA RETENIDO · ${period}`;
      ws.getCell("B4").font = { bold: true, size: 11 };
      ws.getCell("B4").alignment = { horizontal: "left", vertical: "middle" };
      ws.getCell("B4").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4CE" } };
      ws.mergeCells("B4:E4");
      ws.getCell("F4").value = Number(g.iva) || 0;
      ws.getCell("F4").font = { bold: true, size: 14 };
      ws.getCell("F4").alignment = { horizontal: "right", vertical: "middle" };
      ws.getCell("F4").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4CE" } };
      ws.getCell("F4").numFmt = '"$"#,##0';
      ws.mergeCells("F4:G4");

      const HR = 6;
      const headers = ["Fecha", "Documento", "Folio", "Neto", "IVA Retenido", "Total"];
      headers.forEach((h, i) => {
        const c = ws.getCell(HR, 2 + i);
        c.value = h;
        c.font = { bold: true };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF92D050" } };
        c.alignment = { horizontal: i <= 2 ? "left" : "right", vertical: "middle" };
        c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
      });

      const dataStart = HR + 1;
      let r = dataStart;
      const sortedDocs = [...g.docs].sort(
        (a, b) => String(a.fechaEmision || "").localeCompare(String(b.fechaEmision || "")),
      );
      for (const d of sortedDocs) {
        const cells = [
          d.fechaEmision || "",
          d.tipoLabel || dteTypeLabel(d.tipo),
          d.folio,
          Number(d.neto) || 0,
          Number(d.iva) || 0,
          Number(d.total) || 0,
        ];
        cells.forEach((v, j) => {
          const c = ws.getCell(r, 2 + j);
          c.value = v;
          c.alignment = { horizontal: j <= 2 ? "left" : "right" };
          c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
          if (j === 4) c.font = { bold: true }; // IVA en bold
          if (j >= 3) c.numFmt = '"$"#,##0';
        });
        r++;
      }
      const lastDataRow = r - 1;
      const totalRow = r;
      ws.getCell(totalRow, 2).value = "TOTAL";
      ws.mergeCells(totalRow, 2, totalRow, 4);
      for (let col = 2; col <= 7; col++) {
        const c = ws.getCell(totalRow, col);
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
        c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
        c.font = { bold: true };
      }
      if (lastDataRow >= dataStart) {
        ws.getCell(totalRow, 5).value = { formula: `SUM(E${dataStart}:E${lastDataRow})`, result: g.neto };
        ws.getCell(totalRow, 6).value = { formula: `SUM(F${dataStart}:F${lastDataRow})`, result: g.iva };
        ws.getCell(totalRow, 7).value = { formula: `SUM(G${dataStart}:G${lastDataRow})`, result: g.total };
      }
      ws.getCell(totalRow, 5).alignment = { horizontal: "right" };
      ws.getCell(totalRow, 6).alignment = { horizontal: "right" };
      ws.getCell(totalRow, 7).alignment = { horizontal: "right" };
      ws.getCell(totalRow, 5).numFmt = '"$"#,##0';
      ws.getCell(totalRow, 6).numFmt = '"$"#,##0';
      ws.getCell(totalRow, 7).numFmt = '"$"#,##0';

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${groupFileBase(g)}.xlsx`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      toast.error("Error al generar XLSX: " + (err.message || err));
    } finally {
      setBusyFor(key, null);
    }
  };

  const groupExport = (action, g) => {
    if (action === "copy") return handleGroupCopy(g);
    if (action === "png") return handleGroupPng(g);
    if (action === "print") return handleGroupPrint(g);
    if (action === "xlsx") return handleGroupXlsx(g);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Facturación</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Importar el RCV del SII mes a mes · Marcar estado de pago · Auditar por empresa.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setCompaniesModalOpen(true)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
          >
            🏢 Empresas ({companies.length})
          </button>
          <button
            onClick={openImport}
            disabled={noCompany}
            title={noCompany ? "Registrá una empresa primero" : "Importar CSV del SII"}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            📥 Importar CSV del SII
          </button>
        </div>
      </div>

      {/* Empresa selector + tabs + audit toggle */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={selectedCompanyId}
          onChange={(e) => setSelectedCompanyId(e.target.value)}
          disabled={noCompany}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium"
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              🏢 {c.alias || c.razonSocial}
            </option>
          ))}
          {noCompany && <option value="">Sin empresas</option>}
        </select>

        <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1 text-sm">
          {[
            { v: "venta", label: "📤 Facturas" },
            { v: "compra", label: "📥 Compras" },
            { v: "retenciones", label: "📑 Retenciones" },
          ].map((t) => (
            <button
              key={t.v}
              onClick={() => setKindTab(t.v)}
              className={`rounded px-3 py-1 ${
                kindTab === t.v
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : "text-[var(--color-muted)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setAuditMode((v) => !v)}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            auditMode
              ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
              : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
          }`}
          title={auditMode
            ? "Volver a vista operativa (mes actual)"
            : "Activar auditoría — navegar todos los meses históricos"}
        >
          {auditMode ? "🔍 Auditoría · ON" : "🔍 Auditoría"}
        </button>

        <button
          onClick={() => setPendientesModalOpen(true)}
          disabled={noCompany}
          title="Ver todas las facturas con saldo pendiente (cualquier período): factura completa, abonos parciales o IVA pendiente."
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
        >
          ⏳ Ver pendientes
          {pendientesList.length > 0 && (
            <span className="ml-1.5 rounded-full bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-warning)]">
              {pendientesList.length}
            </span>
          )}
        </button>
      </div>

      {/* Sub-filtros */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={periodoFilter}
          onChange={(e) => setPeriodoFilter(e.target.value)}
          disabled={!auditMode}
          title={!auditMode ? "Activá Auditoría para cambiar de período" : "Filtrar por período"}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs disabled:opacity-60"
        >
          {auditMode && <option value="">Todos los períodos</option>}
          {periodoOptions.map((p) => (
            <option key={p} value={p}>
              {p === currentPeriod() ? `${p} (actual)` : p}
            </option>
          ))}
        </select>
        <select
          value={tipoFilter}
          onChange={(e) => setTipoFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
        >
          <option value="">Todos los tipos</option>
          {tipoOptions.map((t) => (
            <option key={t} value={t}>{t} · {dteTypeLabel(t)}</option>
          ))}
        </select>
        {!isRetencionesView && (
          <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-0.5 text-xs">
            {[
              { v: "", label: "Todos" },
              { v: "unpaid", label: "No pagado" },
              { v: "paid", label: "Pagado" },
              { v: "net_only", label: "Solo neto" },
              { v: "factored", label: "Solo IVA" },
            ].map((s) => (
              <button
                key={s.v}
                onClick={() => setPaymentFilter(s.v)}
                className={`rounded px-2 py-1 ${
                  paymentFilter === s.v
                    ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                    : "text-[var(--color-muted)]"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            isRetencionesView
              ? "Buscar por contraparte, RUT o folio..."
              : `Buscar por ${kindTab === "venta" ? "cliente" : "proveedor"}, RUT o folio...`
          }
          list="dte-contrapartes"
          className="flex-1 min-w-[200px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <datalist id="dte-contrapartes">
          {contrapartesAutocomplete.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <SummaryCard label="Documentos" value={fmtNumber(totals.count)} />
        <SummaryCard label="Neto" value={fmtCurrency(totals.neto)} />
        <SummaryCard label="IVA" value={fmtCurrency(totals.iva)} />
        <SummaryCard label="Total" value={fmtCurrency(totals.total)} highlight />
        <SummaryCard
          label={`NC (${totals.ncCount})`}
          value={fmtCurrency(totals.ncTotal)}
          subtle
        />
      </div>

      {selectedCompany && !auditMode && !isRetencionesView && (
        <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <SummaryCard label="No pagado del período" value={fmtCurrency(totals.unpaidTotal)} warning />
          <SummaryCard label="Solo neto (IVA retenido)" value={fmtCurrency(totals.netOnlyTotal)} />
          <SummaryCard label="Cedidas / Solo IVA" value={fmtCurrency(totals.factoredTotal)} />
        </div>
      )}
      {isRetencionesView && (
        <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <SummaryCard label="Facturas con retención" value={fmtNumber(totals.count)} />
          <SummaryCard label="IVA retenido" value={fmtCurrency(totals.netOnlyIva)} highlight />
          <SummaryCard label="Total facturado (con IVA)" value={fmtCurrency(totals.netOnlyTotal)} />
        </div>
      )}

      {loading ? (
        <div className="flex h-40 items-center justify-center text-[var(--color-muted)]">
          Cargando...
        </div>
      ) : noCompany ? (
        <div className="flex h-60 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--color-border)] text-sm text-[var(--color-muted)]">
          <div>No hay empresas registradas todavía.</div>
          <button
            onClick={() => setCompaniesModalOpen(true)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)]"
          >
            🏢 Registrar la primera empresa
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-[var(--color-border)] text-sm text-[var(--color-muted)]">
          {docs.some((d) => (isRetencionesView || d.kind === kindTab) && d.companyId === selectedCompanyId)
            ? "Sin coincidencias para los filtros aplicados."
            : isRetencionesView
              ? "No hay facturas con estado \"Solo neto\" para esta empresa en este período."
              : `No hay ${kindTab === "venta" ? "facturas" : "compras"} importadas para esta empresa en este período. Usá "📥 Importar CSV del SII".`}
        </div>
      ) : isRetencionesView ? (
        <>
          {/* Toolbar de export para la infografía. Mismo patrón visual que el
              resto de los resúmenes del proyecto (Cobrar, Quincenas, Worker). */}
          <div className="mb-2 flex flex-wrap gap-1">
            <button
              onClick={handleRetencionesCopy}
              disabled={exportBusy === "copy" || retencionesByContraparte.length === 0}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              title="Copiar tabla como imagen"
            >
              {exportBusy === "copy" ? "Copiando..." : "📋 Copiar"}
            </button>
            <button
              onClick={handleRetencionesDownload}
              disabled={exportBusy === "png" || retencionesByContraparte.length === 0}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              title="Descargar como PNG"
            >
              {exportBusy === "png" ? "..." : "📥 PNG"}
            </button>
            <button
              onClick={handleRetencionesPrint}
              disabled={retencionesByContraparte.length === 0}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              title="Imprimir"
            >
              🖨 Imprimir
            </button>
            <button
              onClick={handleRetencionesXlsx}
              disabled={exportBusy === "xlsx" || retencionesByContraparte.length === 0}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              title="Exportar XLSX (Resumen + Detalle)"
            >
              {exportBusy === "xlsx" ? "..." : "📊 XLSX"}
            </button>
          </div>

          {/* Off-screen printables — capturados por html-to-image. No visibles.
              Renderizamos el resumen general + un printable individual por cada
              contraparte para poder exportarlos uno a uno. */}
          <div style={{ position: "absolute", left: -99999, top: 0, pointerEvents: "none" }} aria-hidden>
            <PrintableRetenciones
              ref={retencionesPrintRef}
              groups={retencionesByContraparte}
              company={selectedCompany}
              periodo={periodoFilter}
              totals={totals}
            />
            {retencionesByContraparte.map((g) => {
              const k = groupKey(g);
              return (
                <PrintableRetencionesGroup
                  key={`pg_${k}`}
                  ref={(el) => {
                    if (el) groupPrintRefs.current.set(k, el);
                    else groupPrintRefs.current.delete(k);
                  }}
                  group={g}
                  company={selectedCompany}
                  periodo={periodoFilter}
                />
              );
            })}
          </div>

          <RetencionesView
            groups={retencionesByContraparte}
            onSelectDoc={(d) => setDetailDoc(d)}
            onSetStatus={setPaymentStatus}
            onGroupExport={groupExport}
            groupBusy={groupBusy}
            groupKeyOf={groupKey}
          />
        </>
      ) : (
        <div className="flex-1 overflow-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <SortHeader sortKey="fechaEmision" sortBy={sortBy} onToggle={toggleSort} align="left">Fecha</SortHeader>
                <SortHeader sortKey="tipo" sortBy={sortBy} onToggle={toggleSort} align="left">Tipo</SortHeader>
                <SortHeader sortKey="folio" sortBy={sortBy} onToggle={toggleSort} align="right">Folio</SortHeader>
                <SortHeader sortKey="razon" sortBy={sortBy} onToggle={toggleSort} align="left">{kindTab === "venta" ? "Cliente" : "Proveedor"}</SortHeader>
                <SortHeader sortKey="rut" sortBy={sortBy} onToggle={toggleSort} align="left">RUT</SortHeader>
                <SortHeader sortKey="neto" sortBy={sortBy} onToggle={toggleSort} align="right">Neto</SortHeader>
                <SortHeader sortKey="iva" sortBy={sortBy} onToggle={toggleSort} align="right">IVA</SortHeader>
                <SortHeader sortKey="total" sortBy={sortBy} onToggle={toggleSort} align="right">Total</SortHeader>
                <SortHeader sortKey="pagado" sortBy={sortBy} onToggle={toggleSort} align="right">Abonos</SortHeader>
                <SortHeader sortKey="estado" sortBy={sortBy} onToggle={toggleSort} align="center">Estado</SortHeader>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {sortedFiltered.map((d) => {
                const razon = kindTab === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor;
                const rut = kindTab === "venta" ? d.rutReceptor : d.rutEmisor;
                const isNC = CREDIT_NOTE_TYPES.has(Number(d.tipo));
                const st = d.paymentStatus || "unpaid";
                const hasNotes = !!(d.notes && d.notes.trim());
                return (
                  <tr key={d.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                    <td className="px-2 py-1.5 font-mono text-xs">{d.fechaEmision}</td>
                    <td className="px-2 py-1.5 text-xs">
                      <span className={`rounded px-1.5 py-0.5 ${isNC ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]" : "bg-[var(--color-surface-2)]"}`}>
                        {d.tipo}
                      </span>
                      <span className="ml-1 text-[var(--color-muted)]">{d.tipoLabel}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{d.folio}</td>
                    <td className="px-2 py-1.5 truncate max-w-[260px]">{razon || "—"}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{formatRutForDisplay(rut)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${isNC ? "text-[var(--color-danger)]" : ""}`}>
                      {isNC ? "−" : ""}{fmtCurrency(d.neto)}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${isNC ? "text-[var(--color-danger)]" : ""}`}>
                      {isNC ? "−" : ""}{fmtCurrency(d.iva)}
                    </td>
                    <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${isNC ? "text-[var(--color-danger)]" : ""}`}>
                      {isNC ? "−" : ""}{fmtCurrency(d.total)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {(() => {
                        if (isNC) return <span className="text-[var(--color-muted)]">—</span>;
                        const pays = Array.isArray(d.payments) ? d.payments : [];
                        const paid = Number(d.amountPaid) || pays.reduce((s, p) => s + (Number(p.amount) || 0), 0);
                        if (paid <= 0) return <span className="text-[var(--color-muted)]">—</span>;
                        const bal = (Number(d.total) || 0) - paid;
                        const full = bal <= 0.01;
                        return (
                          <div className="flex flex-col items-end leading-tight">
                            <span>{fmtCurrency(paid)}</span>
                            <span className={`text-[10px] ${full ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}>
                              {full ? `✓ ${pays.length} abono${pays.length === 1 ? "" : "s"}` : `Saldo ${fmtCurrency(bal)}`}
                            </span>
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {isNC ? (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${NC_STATE.chip}`}>
                          {NC_STATE.label}
                        </span>
                      ) : (
                        <div className="flex items-center justify-center gap-1">
                          <PaymentStatusSelect
                            value={st}
                            onChange={(next) => setPaymentStatus(d, next)}
                          />
                          {cancellingByDocId.has(d.id) && st !== "cancelled" && (
                            <button
                              onClick={() => setDetailDoc(d)}
                              title={`Posible NC anula esta factura (${cancellingByDocId.get(d.id).length} candidata${cancellingByDocId.get(d.id).length === 1 ? "" : "s"}). Click para revisar.`}
                              className="rounded-full bg-[var(--color-danger-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-danger)] hover:opacity-80"
                            >
                              ⚠ NC?
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <button
                        onClick={() => setDetailDoc(d)}
                        title={hasNotes ? "Ver detalle (tiene notas)" : "Ver detalle / agregar notas"}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
                      >
                        {hasNotes ? "📝" : "ℹ"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          existingIds={new Set(docs.map((d) => d.id))}
          company={companiesById.get(importCompanyId)}
          busy={importing}
          onToggleFile={toggleFileExclusion}
          onConfirm={confirmImport}
          onCancel={() => { setImportPreview(null); setImportCompanyId(""); }}
        />
      )}

      {importCompanyId && !importPreview && (
        <CompanySelectAndPickModal
          companies={companies}
          companyId={importCompanyId}
          onChange={setImportCompanyId}
          onFilesPick={onFilesPick}
          onCancel={() => setImportCompanyId("")}
        />
      )}

      {companiesModalOpen && (
        <CompaniesModal
          companies={companies}
          onClose={() => setCompaniesModalOpen(false)}
          onChanged={loadAll}
        />
      )}

      {pendientesModalOpen && (
        <PendientesModal
          items={pendientesList}
          totals={pendientesTotals}
          company={selectedCompany}
          onClose={() => setPendientesModalOpen(false)}
          onSelectDoc={(d) => { setPendientesModalOpen(false); setDetailDoc(d); }}
        />
      )}

      {detailDoc && (
        <DocDetailModal
          dteDoc={detailDoc}
          candidateNcs={cancellingByDocId.get(detailDoc.id) || []}
          onClose={() => setDetailDoc(null)}
          onSaveNotes={(notes) => saveDocNotes(detailDoc, notes)}
          onSetStatus={(next) => setPaymentStatus(detailDoc, next)}
          onSavePayments={(payments) => saveDocPayments(detailDoc, payments)}
        />
      )}
    </div>
  );
}

// Select inline en cada fila para cambiar el estado de pago de una factura.
// Reemplaza el viejo botón cíclico — con 4 estados el ciclo se vuelve confuso.
// El styling matchea el chip del estado actual para mantener la continuidad visual.
// Las <option> llevan colores explícitos del tema (surface + text) porque el
// dropdown nativo hereda el fondo del select y en dark mode los chips de color
// soft (amarillo, rojo claro) hacen ilegibles los items del dropdown.
function PaymentStatusSelect({ value, onChange }) {
  const meta = PAYMENT_STATUSES[value] || PAYMENT_STATUSES.unpaid;
  const optionStyle = {
    backgroundColor: "var(--color-surface)",
    color: "var(--color-text)",
  };
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium outline-none border-0 cursor-pointer ${meta.chip}`}
    >
      {Object.entries(PAYMENT_STATUSES).map(([key, m]) => (
        <option key={key} value={key} style={optionStyle}>{m.label}</option>
      ))}
    </select>
  );
}

// Printable de Retenciones — versión limpia para captura (html-to-image,
// print, PNG). No incluye los selects ni controles interactivos; muestra
// dos secciones: (1) resumen por contraparte y (2) detalle de cada factura
// agrupada por contraparte con subtotales. Estética estilo Excel
// (verde #92d050 header, verde claro #c6efce totales, verde muy claro
// #e2efda subheader de grupo).
const PrintableRetenciones = forwardRef(function PrintableRetenciones(
  { groups, company, periodo, totals },
  ref,
) {
  const periodLabel = periodo || "Todos los períodos";
  const totalCount = groups.reduce((s, g) => s + g.count, 0);
  const totalNeto = groups.reduce((s, g) => s + (Number(g.neto) || 0), 0);
  const totalIva = totals?.netOnlyIva ?? groups.reduce((s, g) => s + (Number(g.iva) || 0), 0);
  const totalTotal = totals?.netOnlyTotal ?? groups.reduce((s, g) => s + (Number(g.total) || 0), 0);
  // Ordenar docs por fecha asc dentro de cada grupo — más legible que el orden
  // por id que viene del agrupador.
  const groupsSorted = groups.map((g) => ({
    ...g,
    docs: [...g.docs].sort((a, b) => String(a.fechaEmision || "").localeCompare(String(b.fechaEmision || ""))),
  }));
  return (
    <div
      ref={ref}
      style={{
        background: "#ffffff",
        color: "#000",
        padding: 16,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        minWidth: 820,
      }}
    >
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15, textTransform: "uppercase" }}>
          RETENCIONES — {(company?.alias || company?.razonSocial || "—").toString().toUpperCase()}
        </div>
        <div style={{ fontSize: 12, color: "#444" }}>{periodLabel}</div>
      </div>
      <div style={{ marginBottom: 8, fontSize: 11, color: "#444" }}>
        Facturas con estado <b>"Solo neto"</b> agrupadas por contraparte (cliente que retuvo el IVA).
      </div>

      {/* Banner explícito con el IVA retenido del período — el dato más
          importante de la vista, destacado para no perderse entre las tablas. */}
      <div style={{
        marginBottom: 12, padding: "10px 14px", background: "#fff4ce",
        border: "2px solid #f4b400", borderRadius: 6,
        display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
          IVA retenido en el período {periodLabel}
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
          {fmtCurrency(totalIva)}
        </div>
      </div>

      {/* ===== Sección 1: Resumen por contraparte ===== */}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#92d050" }}>
            <th style={{ ...pCellH, width: 32, textAlign: "center" }}>#</th>
            <th style={pCellH}>EMPRESA</th>
            <th style={pCellH}>RUT</th>
            <th style={{ ...pCellH, textAlign: "right" }}>N° FAC.</th>
            <th style={{ ...pCellH, textAlign: "right" }}>NETO</th>
            <th style={{ ...pCellH, textAlign: "right" }}>IVA RETENIDO</th>
            <th style={{ ...pCellH, textAlign: "right" }}>TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {groupsSorted.length === 0 ? (
            <tr>
              <td style={pCell} colSpan={7}>(sin retenciones para mostrar)</td>
            </tr>
          ) : (
            groupsSorted.map((g, i) => (
              <tr key={g.rut || `i${i}`}>
                <td style={{ ...pCell, textAlign: "center" }}>{i + 1}</td>
                <td style={pCell}>{g.razon || "—"}</td>
                <td style={pCell}>{formatRutForDisplay(g.rut) || "—"}</td>
                <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{g.count}</td>
                <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(g.neto)}</td>
                <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 800 }}>{fmtCurrency(g.iva)}</td>
                <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(g.total)}</td>
              </tr>
            ))
          )}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...pCell, fontWeight: 700 }} colSpan={3}>TOTAL</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{totalCount}</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totalNeto)}</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totalIva)}</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totalTotal)}</td>
          </tr>
        </tbody>
      </table>

      {/* ===== Sección 2: Detalle de cada factura por contraparte ===== */}
      {groupsSorted.length > 0 && (
        <>
          <div style={{ marginTop: 18, marginBottom: 6, fontWeight: 700, fontSize: 13, textTransform: "uppercase" }}>
            Detalle de facturas
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ background: "#92d050" }}>
                <th style={{ ...pCellH, width: 90 }}>FECHA</th>
                <th style={pCellH}>DOCUMENTO</th>
                <th style={{ ...pCellH, textAlign: "right", width: 80 }}>FOLIO</th>
                <th style={{ ...pCellH, textAlign: "right" }}>NETO</th>
                <th style={{ ...pCellH, textAlign: "right" }}>IVA RETENIDO</th>
                <th style={{ ...pCellH, textAlign: "right" }}>TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {groupsSorted.map((g, gi) => (
                <React.Fragment key={`d_${g.rut || gi}`}>
                  <tr style={{ background: "#e2efda" }}>
                    <td style={{ ...pCell, fontWeight: 700 }} colSpan={6}>
                      {gi + 1}. {g.razon || "—"}
                      <span style={{ marginLeft: 8, fontWeight: 400, color: "#555" }}>
                        · {formatRutForDisplay(g.rut) || "—"}
                      </span>
                      <span style={{ marginLeft: 8, fontWeight: 400, color: "#555" }}>
                        · {g.count} factura{g.count === 1 ? "" : "s"}
                      </span>
                    </td>
                  </tr>
                  {g.docs.map((d) => (
                    <tr key={d.id}>
                      <td style={{ ...pCell, fontVariantNumeric: "tabular-nums" }}>{d.fechaEmision || "—"}</td>
                      <td style={pCell}>{d.tipoLabel || dteTypeLabel(d.tipo)}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.folio}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(d.neto)}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 800 }}>{fmtCurrency(d.iva)}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(d.total)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: "#f2f2f2" }}>
                    <td style={{ ...pCell, fontWeight: 700 }} colSpan={3}>Subtotal</td>
                    <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(g.neto)}</td>
                    <td style={{ ...pCell, textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(g.iva)}</td>
                    <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(g.total)}</td>
                  </tr>
                </React.Fragment>
              ))}
              <tr style={{ background: "#c6efce" }}>
                <td style={{ ...pCell, fontWeight: 700 }} colSpan={3}>TOTAL GENERAL</td>
                <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totalNeto)}</td>
                <td style={{ ...pCell, textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totalIva)}</td>
                <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totalTotal)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
});

const pCellH = {
  border: "1px solid #555",
  padding: "6px 8px",
  fontSize: 12,
  fontWeight: 700,
  textAlign: "left",
};
const pCell = {
  border: "1px solid #999",
  padding: "5px 8px",
  fontSize: 12,
};

// Printable de una sola contraparte (resumen individual). Se renderiza N veces
// off-screen — uno por grupo — para que cada uno pueda exportarse a
// imagen/PDF/XLSX de manera independiente.
const PrintableRetencionesGroup = forwardRef(function PrintableRetencionesGroup(
  { group, company, periodo },
  ref,
) {
  const periodLabel = periodo || "Todos los períodos";
  const docs = [...(group.docs || [])].sort(
    (a, b) => String(a.fechaEmision || "").localeCompare(String(b.fechaEmision || "")),
  );
  return (
    <div
      ref={ref}
      style={{
        background: "#ffffff",
        color: "#000",
        padding: 16,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        minWidth: 720,
      }}
    >
      <div style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, textTransform: "uppercase" }}>
          RETENCIÓN — {(company?.alias || company?.razonSocial || "—").toString().toUpperCase()}
        </div>
        <div style={{ fontSize: 12, color: "#444" }}>{periodLabel}</div>
      </div>
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        <b>{group.razon || "—"}</b>
        <span style={{ marginLeft: 8, color: "#555" }}>RUT {formatRutForDisplay(group.rut) || "—"}</span>
        <span style={{ marginLeft: 8, color: "#555" }}>· {group.count} factura{group.count === 1 ? "" : "s"}</span>
      </div>
      {/* Banner IVA retenido de la contraparte — destacado para que el dato
          clave (cuánto IVA retuvo este cliente en el período) salte a la vista. */}
      <div style={{
        marginBottom: 10, padding: "8px 12px", background: "#fff4ce",
        border: "2px solid #f4b400", borderRadius: 6,
        display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
          IVA retenido · {periodLabel}
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
          {fmtCurrency(group.iva)}
        </div>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#92d050" }}>
            <th style={{ ...pCellH, width: 90 }}>FECHA</th>
            <th style={pCellH}>DOCUMENTO</th>
            <th style={{ ...pCellH, textAlign: "right", width: 80 }}>FOLIO</th>
            <th style={{ ...pCellH, textAlign: "right" }}>NETO</th>
            <th style={{ ...pCellH, textAlign: "right" }}>IVA RETENIDO</th>
            <th style={{ ...pCellH, textAlign: "right" }}>TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td style={{ ...pCell, fontVariantNumeric: "tabular-nums" }}>{d.fechaEmision || "—"}</td>
              <td style={pCell}>{d.tipoLabel || dteTypeLabel(d.tipo)}</td>
              <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.folio}</td>
              <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(d.neto)}</td>
              <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 800 }}>{fmtCurrency(d.iva)}</td>
              <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(d.total)}</td>
            </tr>
          ))}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...pCell, fontWeight: 700 }} colSpan={3}>TOTAL ({group.count})</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(group.neto)}</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(group.iva)}</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(group.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
});

// Vista de Retenciones: agrupa facturas con estado `net_only` por contraparte.
// Cada grupo es expandible — muestra los docs individuales con su select de
// estado por si el usuario quiere revertir el "solo neto" a otro estado.
// Cada grupo tiene su propia toolbar de export (📋📥🖨📊) para que se pueda
// compartir el resumen de una sola contraparte sin armar uno general.
function RetencionesView({ groups, onSelectDoc, onSetStatus, onGroupExport, groupBusy = {}, groupKeyOf = (g) => g?.rut || "__sin_rut__" }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (rut) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(rut)) n.delete(rut); else n.add(rut);
      return n;
    });
  };
  if (groups.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-[var(--color-border)] text-sm text-[var(--color-muted)]">
        No hay facturas marcadas como "Solo neto" en este período.
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto rounded-md border border-[var(--color-border)]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
          <tr>
            <th className="px-2 py-2 text-left"></th>
            <th className="px-2 py-2 text-left">Empresa</th>
            <th className="px-2 py-2 text-left">RUT</th>
            <th className="px-2 py-2 text-right">N° Facturas</th>
            <th className="px-2 py-2 text-right">Neto</th>
            <th className="px-2 py-2 text-right">IVA retenido</th>
            <th className="px-2 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isOpen = expanded.has(g.rut);
            const gk = groupKeyOf(g);
            const busy = groupBusy[gk];
            const stop = (e) => e.stopPropagation();
            const fireExport = (action) => onGroupExport && onGroupExport(action, g);
            return (
              <React.Fragment key={g.rut || "_sinrut_"}>
                <tr
                  className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                  onClick={() => toggle(g.rut)}
                >
                  <td className="px-2 py-2 w-6 text-center text-[var(--color-muted)]">{isOpen ? "▾" : "▸"}</td>
                  <td className="px-2 py-2 font-medium truncate max-w-[300px]">{g.razon || "—"}</td>
                  <td className="px-2 py-2 font-mono text-xs">{formatRutForDisplay(g.rut)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{g.count}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtCurrency(g.neto)}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums text-[var(--color-accent)]">{fmtCurrency(g.iva)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    <div className="flex items-center justify-end gap-1.5">
                      <span>{fmtCurrency(g.total)}</span>
                      {onGroupExport && (
                        <div onClick={stop} className="ml-2 flex gap-0.5">
                          <button
                            onClick={() => fireExport("copy")}
                            disabled={!!busy}
                            title="Copiar resumen de esta contraparte"
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                          >
                            {busy === "copy" ? "…" : "📋"}
                          </button>
                          <button
                            onClick={() => fireExport("png")}
                            disabled={!!busy}
                            title="Descargar PNG"
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                          >
                            {busy === "png" ? "…" : "📥"}
                          </button>
                          <button
                            onClick={() => fireExport("print")}
                            disabled={!!busy}
                            title="Imprimir"
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                          >
                            🖨
                          </button>
                          <button
                            onClick={() => fireExport("xlsx")}
                            disabled={!!busy}
                            title="Exportar XLSX"
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                          >
                            {busy === "xlsx" ? "…" : "📊"}
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && g.docs.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
                    <td></td>
                    <td colSpan={2} className="px-2 py-1.5 text-xs">
                      <span className="font-mono">{d.fechaEmision}</span>
                      <span className="ml-2 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5">{d.tipo}</span>
                      <span className="ml-1 text-[var(--color-muted)]">{d.tipoLabel}</span>
                      <span className="ml-2 font-mono tabular-nums">Folio {d.folio}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <PaymentStatusSelect value={d.paymentStatus || "unpaid"} onChange={(next) => onSetStatus(d, next)} />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtCurrency(d.neto)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-accent)]">{fmtCurrency(d.iva)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {fmtCurrency(d.total)}
                      <button
                        onClick={(e) => { e.stopPropagation(); onSelectDoc(d); }}
                        className="ml-2 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
                      >
                        {d.notes ? "📝" : "ℹ"}
                      </button>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Sección de pagos / abonos de una factura. Lista los pagos existentes con
// fecha, tipo, monto y notas, calcula pagado/saldo, y permite agregar nuevos
// con validación de no superar el total de la factura.
function PaymentsSection({ dteDoc, payments, amountPaid, balance, onSavePayments }) {
  const toast = useToast();
  const total = Number(dteDoc?.total) || 0;
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // Sugerir el monto en función del kind elegido — UX rápida para los casos
  // típicos (saldo completo, neto, IVA). El usuario puede sobreescribir.
  const suggestAmount = (kind) => {
    if (kind === "total") return Math.max(0, total - amountPaid);
    if (kind === "neto") return Number(dteDoc?.neto) || 0;
    if (kind === "iva") return Number(dteDoc?.iva) || 0;
    return ""; // abono: sin sugerencia
  };
  const [newPay, setNewPay] = useState(() => ({
    date: todayIso(), kind: "abono", amount: "", notes: "",
  }));

  const start = () => {
    setNewPay({ date: todayIso(), kind: "abono", amount: "", notes: "" });
    setAdding(true);
  };
  const cancel = () => setAdding(false);

  const onKindChange = (kind) => {
    const s = suggestAmount(kind);
    setNewPay((p) => ({ ...p, kind, amount: s === "" ? p.amount : String(s) }));
  };

  const submit = async () => {
    const amount = Math.round(Number(newPay.amount) || 0);
    if (amount <= 0) { toast.warning("El monto debe ser mayor a 0."); return; }
    if (amountPaid + amount > total + 0.01) {
      toast.error(
        `Total: ${fmtCurrency(total)}\nYa pagado: ${fmtCurrency(amountPaid)}\nSaldo: ${fmtCurrency(balance)}\nIntento: ${fmtCurrency(amount)}`,
        { title: "El abono excede el total de la factura" },
      );
      return;
    }
    if (!newPay.date) { toast.warning("Tenés que indicar la fecha del pago."); return; }
    const entry = {
      id: newPaymentId(),
      date: newPay.date,
      kind: newPay.kind,
      amount,
      notes: (newPay.notes || "").trim(),
      recordedAt: new Date().toISOString(),
    };
    setBusy(true);
    try {
      await onSavePayments([...payments, entry]);
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!confirm("¿Eliminar este pago del registro?")) return;
    setBusy(true);
    try {
      await onSavePayments(payments.filter((p) => p.id !== id));
    } finally {
      setBusy(false);
    }
  };

  const fullyPaid = balance <= 0.01;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
          Pagos / abonos
        </div>
        <div className="text-xs">
          <span className="text-[var(--color-muted)]">Pagado: </span>
          <span className="font-semibold tabular-nums">{fmtCurrency(amountPaid)}</span>
          <span className="mx-2 text-[var(--color-border)]">·</span>
          <span className="text-[var(--color-muted)]">Saldo: </span>
          <span className={`font-semibold tabular-nums ${fullyPaid ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}>
            {fmtCurrency(balance)}
          </span>
        </div>
      </div>
      {payments.length === 0 ? (
        <div className="px-1 py-2 text-xs italic text-[var(--color-muted)]">Sin pagos registrados.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[var(--color-muted)]">
              <tr>
                <th className="px-1 py-1 text-left">Fecha</th>
                <th className="px-1 py-1 text-left">Tipo</th>
                <th className="px-1 py-1 text-right">Monto</th>
                <th className="px-1 py-1 text-left">Notas</th>
                <th className="px-1 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {[...payments]
                .sort((a, b) => String(a.date).localeCompare(String(b.date)))
                .map((p) => (
                  <tr key={p.id} className="border-t border-[var(--color-border)]">
                    <td className="px-1 py-1 font-mono">{p.date || "—"}</td>
                    <td className="px-1 py-1">
                      <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5">
                        {PAYMENT_KINDS[p.kind]?.label || p.kind}
                      </span>
                    </td>
                    <td className="px-1 py-1 text-right tabular-nums">{fmtCurrency(p.amount)}</td>
                    <td className="px-1 py-1 truncate max-w-[200px]">{p.notes || "—"}</td>
                    <td className="px-1 py-1 text-right">
                      <button
                        onClick={() => remove(p.id)}
                        disabled={busy}
                        title="Eliminar pago"
                        className="rounded px-1 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {adding ? (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <label className="mb-0.5 block text-[10px] text-[var(--color-muted)]">Fecha</label>
              <input
                type="date"
                value={newPay.date}
                onChange={(e) => setNewPay({ ...newPay, date: e.target.value })}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] text-[var(--color-muted)]">Tipo</label>
              <select
                value={newPay.kind}
                onChange={(e) => onKindChange(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
              >
                {Object.entries(PAYMENT_KINDS).map(([k, m]) => (
                  <option key={k} value={k}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] text-[var(--color-muted)]">
                Monto <span className="text-[var(--color-muted)]">(máx {fmtCurrency(balance)})</span>
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={newPay.amount}
                onChange={(e) => setNewPay({ ...newPay, amount: e.target.value })}
                placeholder="0"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs tabular-nums"
              />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] text-[var(--color-muted)]">Notas</label>
              <input
                type="text"
                value={newPay.notes}
                onChange={(e) => setNewPay({ ...newPay, notes: e.target.value })}
                placeholder="opcional"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
              />
            </div>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={cancel}
              disabled={busy}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs"
            >
              Cancelar
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="rounded-md bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {busy ? "Guardando..." : "Registrar pago"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between border-t border-[var(--color-border)] pt-2">
          <div className="text-[10px] text-[var(--color-muted)]">
            {fullyPaid && payments.length > 0
              ? "✓ Factura totalmente pagada."
              : `Total factura: ${fmtCurrency(total)}.`}
          </div>
          <button
            onClick={start}
            disabled={fullyPaid && payments.length > 0}
            title={fullyPaid && payments.length > 0 ? "Ya no hay saldo pendiente" : "Registrar un nuevo pago o abono"}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            + Registrar pago / abono
          </button>
        </div>
      )}
    </div>
  );
}

// Modal de detalle de un DTE — muestra todos los campos disponibles + permite
// editar las notas (la "glosa" interna del usuario, ya que el SII RCV CSV no
// trae los items de la factura). Para NCs muestra un campo extra opcional
// para registrar manualmente la factura referenciada (tipo + folio).
function DocDetailModal({ dteDoc, candidateNcs = [], onClose, onSaveNotes, onSetStatus, onSavePayments }) {
  const [notes, setNotes] = useState(dteDoc.notes || "");
  const [dirty, setDirty] = useState(false);
  const isNC = CREDIT_NOTE_TYPES.has(Number(dteDoc.tipo));
  const st = dteDoc.paymentStatus || "unpaid";
  const showNcSuggestion = !isNC && st !== "cancelled" && candidateNcs.length > 0;
  const { payments, amountPaid, balance } = paymentsSummary(dteDoc);

  const save = async () => {
    await onSaveNotes(notes);
    setDirty(false);
  };

  // Marca la factura como anulada y agrega una nota con la referencia a la(s)
  // NC candidata(s). La nota se concatena con lo que el usuario ya tenía.
  const acceptNcSuggestion = async () => {
    const ref = candidateNcs
      .map((nc) => `NC ${nc.tipo}-${nc.folio} (${nc.fechaEmision || "s/f"}, ${fmtCurrency(nc.total)})`)
      .join(", ");
    const prefix = notes && notes.trim() ? `${notes.trim()}\n` : "";
    const stamp = `[Anulada por ${ref}]`;
    const newNotes = `${prefix}${stamp}`;
    setNotes(newNotes);
    setDirty(false);
    await onSaveNotes(newNotes);
    onSetStatus("cancelled");
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${dteDoc.tipoLabel} N° ${dteDoc.folio}`}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
          >
            Cerrar
          </button>
          <button
            onClick={save}
            disabled={!dirty}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Guardar notas
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {showNcSuggestion && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-[var(--color-danger)]">
                ⚠ Posible NC que anula esta factura
              </div>
              <button
                onClick={acceptNcSuggestion}
                className="rounded-md bg-[var(--color-danger)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
              >
                Marcar como Anulada
              </button>
            </div>
            <div className="space-y-0.5 text-[11px] text-[var(--color-text)]">
              {candidateNcs.map((nc) => (
                <div key={nc.id} className="font-mono">
                  · {nc.tipoLabel} {nc.tipo}-{nc.folio} · {nc.fechaEmision || "s/f"} · {fmtCurrency(nc.total)}
                </div>
              ))}
            </div>
            <div className="mt-1 text-[10px] text-[var(--color-muted)]">
              Match por contraparte + total exacto. Verificá antes de aceptar — puede haber falso positivo.
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Tipo</div>
            <div>
              <span className={`rounded px-1.5 py-0.5 ${isNC ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]" : "bg-[var(--color-surface-2)]"}`}>
                {dteDoc.tipo}
              </span>
              <span className="ml-1 text-[var(--color-muted)]">{dteDoc.tipoLabel}</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Estado</div>
            {isNC ? (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${NC_STATE.chip}`}>{NC_STATE.label}</span>
            ) : (
              <PaymentStatusSelect value={st} onChange={onSetStatus} />
            )}
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Fecha emisión</div>
            <div className="font-mono">{dteDoc.fechaEmision || "—"}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Período</div>
            <div className="font-mono">{dteDoc.periodo || "—"}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Emisor</div>
            <div className="font-medium truncate">{dteDoc.razonSocialEmisor || "—"}</div>
            <div className="font-mono text-xs text-[var(--color-muted)]">{formatRutForDisplay(dteDoc.rutEmisor) || "—"}</div>
          </div>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Receptor</div>
            <div className="font-medium truncate">{dteDoc.razonSocialReceptor || "—"}</div>
            <div className="font-mono text-xs text-[var(--color-muted)]">{formatRutForDisplay(dteDoc.rutReceptor) || "—"}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryCard label="Neto" value={fmtCurrency(dteDoc.neto)} />
          <SummaryCard label="Exento" value={fmtCurrency(dteDoc.exento)} subtle />
          <SummaryCard label="IVA" value={fmtCurrency(dteDoc.iva)} />
          <SummaryCard label="Total" value={fmtCurrency(dteDoc.total)} highlight />
        </div>

        {!isNC && (
          <PaymentsSection
            dteDoc={dteDoc}
            payments={payments}
            amountPaid={amountPaid}
            balance={balance}
            onSavePayments={onSavePayments}
          />
        )}

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
            Notas / glosa (interno)
          </label>
          <textarea
            value={notes}
            onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
            rows={3}
            placeholder={
              isNC
                ? 'Detalle libre. Ej: "Anula Factura 33-1234 por error en monto"'
                : 'Detalle libre. El SII no trae la glosa en el CSV — usá este campo para registrar items, condiciones, OC, etc.'
            }
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <p className="mt-1 text-[10px] text-[var(--color-muted)]">
            Las notas persisten en Firestore y aparecen marcadas con 📝 en el listado.
          </p>
        </div>

        {dteDoc.sourceFile && (
          <div className="text-[10px] text-[var(--color-muted)]">
            Importado desde: <span className="font-mono">{dteDoc.sourceFile}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// Header de tabla clickeable con indicador de orden actual. Mantiene el
// estilo del thead original — solo agrega cursor + flechita ↑/↓ cuando es la
// columna activa.
function SortHeader({ sortKey, sortBy, onToggle, align = "left", children }) {
  const active = sortBy.key === sortKey;
  const arrow = active ? (sortBy.dir === "asc" ? "▲" : "▼") : "";
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th
      onClick={() => onToggle(sortKey)}
      title="Click para ordenar"
      className={`cursor-pointer select-none px-2 py-2 ${alignCls} hover:text-[var(--color-text)] ${active ? "text-[var(--color-text)]" : ""}`}
    >
      {children}
      {arrow && <span className="ml-1 text-[10px]">{arrow}</span>}
    </th>
  );
}

function SummaryCard({ label, value, highlight = false, warning = false, subtle = false }) {
  const cls = highlight
    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
    : warning
      ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)]"
      : subtle
        ? "border-[var(--color-border)] bg-[var(--color-surface-2)]"
        : "border-[var(--color-border)] bg-[var(--color-surface)]";
  const valueCls = highlight
    ? "text-[var(--color-accent)]"
    : warning
      ? "text-[var(--color-warning)]"
      : "";
  return (
    <div className={`rounded-md border px-3 py-2 ${cls}`}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${valueCls}`}>{value}</div>
    </div>
  );
}

// Modal intermedio: confirma empresa + abre file picker (multi-archivo).
// El usuario puede subir varios archivos en una sola operación — ventas y
// compras mezcladas, varios meses, lo que sea. Cada archivo se parsea
// independiente y queda como entrada del preview.
function CompanySelectAndPickModal({ companies, companyId, onChange, onFilesPick, onCancel }) {
  const ref = useRef(null);
  return (
    <Modal
      open
      onClose={onCancel}
      size="md"
      title="Importar CSV del SII"
      footer={
        <>
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
          >
            Cancelar
          </button>
          <button
            onClick={() => ref.current?.click()}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)]"
          >
            📥 Elegir archivos...
          </button>
          <input
            ref={ref}
            type="file"
            accept=".csv,text/csv,text/plain"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              onFilesPick(files);
              e.target.value = "";
            }}
          />
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
            Empresa a la que pertenecen los archivos
          </label>
          <select
            value={companyId}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                🏢 {c.alias || c.razonSocial} · {c.rut}
              </option>
            ))}
          </select>
        </div>
        <div className="rounded-md bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-muted)] space-y-1">
          <div>Podés seleccionar <b>varios archivos a la vez</b> (Ctrl/Cmd+click en el picker).</div>
          <div>Cada archivo se identifica como <b>ventas</b> o <b>compras</b> auto mirando los encabezados.</div>
          <div>Si detectamos un RUT en el nombre del archivo distinto al de la empresa, te lo avisamos en el preview.</div>
          <div>Reimportar un período reemplaza completo (docs huérfanos del mismo mes se eliminan).</div>
        </div>
      </div>
    </Modal>
  );
}

// Modal con preview de N archivos parseados. Muestra:
//   - banner de empresa elegida
//   - stats agregados (sumando todos los archivos no excluidos)
//   - lista de archivos con warnings de mismatch + checkbox para excluir
//   - sample de las primeras filas del primer archivo incluido
function ImportPreviewModal({ preview, existingIds, company, busy, onToggleFile, onConfirm, onCancel }) {
  const { files } = preview;
  const included = files.filter((f) => !f.excluded && !f.parseFailed);

  const agg = useMemo(() => {
    const a = { count: 0, total: 0, newCount: 0, dupCount: 0, byTipo: {}, periodos: new Set(), kinds: new Set() };
    for (const f of included) {
      for (const r of f.records) {
        a.count++;
        a.total += Number(r.total) || 0;
        if (existingIds.has(r.id)) a.dupCount++;
        else a.newCount++;
        a.byTipo[r.tipo] = (a.byTipo[r.tipo] || 0) + 1;
        if (r.periodo) a.periodos.add(r.periodo);
      }
      if (f.kind) a.kinds.add(f.kind);
    }
    return a;
  }, [included, existingIds]);

  const sampleFile = included[0];
  const sample = sampleFile?.records.slice(0, 5) || [];

  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      size="3xl"
      title={`Importar ${files.length} archivo${files.length === 1 ? "" : "s"}`}
      footer={
        <>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || agg.count === 0}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            {busy ? "Importando..." : `Confirmar (${agg.count} doc${agg.count === 1 ? "" : "s"} de ${included.length} archivo${included.length === 1 ? "" : "s"})`}
          </button>
        </>
      }
    >
      <div className="mb-2 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-2 text-xs">
        <div className="font-semibold text-[var(--color-accent)]">
          🏢 {company?.alias || company?.razonSocial} · {company?.rut}
        </div>
        <div className="mt-0.5 text-[var(--color-muted)]">
          Período(s): <span className="font-mono">{[...agg.periodos].sort().join(", ") || "—"}</span>
          {" · "}
          Kind(s): <span className="font-mono">{[...agg.kinds].join(", ") || "—"}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Documentos" value={fmtNumber(agg.count)} />
        <SummaryCard label="Total" value={fmtCurrency(agg.total)} highlight />
        <SummaryCard label="Nuevos" value={fmtNumber(agg.newCount)} />
        <SummaryCard label="Sobreescriben" value={fmtNumber(agg.dupCount)} />
      </div>

      {/* Lista de archivos */}
      <div className="mt-3 space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
          Archivos ({files.length})
        </div>
        {files.map((f) => (
          <FileRow
            key={f.name}
            file={f}
            existingIds={existingIds}
            companyRut={company?.rut}
            onToggle={() => onToggleFile(f.name)}
          />
        ))}
      </div>

      {Object.keys(agg.byTipo).length > 0 && (
        <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            Por tipo (agregado)
          </div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(agg.byTipo).map(([tipo, count]) => (
              <span
                key={tipo}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs"
              >
                <span className="font-mono">{tipo}</span>
                <span className="ml-1 text-[var(--color-muted)]">{dteTypeLabel(tipo)}</span>
                <span className="ml-1 font-medium">· {count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Sample del primer archivo incluido */}
      {sample.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            Vista previa · {sampleFile.name}
          </div>
          <div className="overflow-auto rounded-md border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-surface-2)] text-[var(--color-muted)]">
                <tr>
                  <th className="px-2 py-1 text-left">Fecha</th>
                  <th className="px-2 py-1 text-left">Tipo</th>
                  <th className="px-2 py-1 text-right">Folio</th>
                  <th className="px-2 py-1 text-left">{sampleFile.kind === "venta" ? "Cliente" : "Proveedor"}</th>
                  <th className="px-2 py-1 text-left">RUT</th>
                  <th className="px-2 py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((r) => {
                  const razon = sampleFile.kind === "venta" ? r.razonSocialReceptor : r.razonSocialEmisor;
                  const rut = sampleFile.kind === "venta" ? r.rutReceptor : r.rutEmisor;
                  return (
                    <tr key={r.id} className="border-t border-[var(--color-border)]">
                      <td className="px-2 py-1 font-mono">{r.fechaEmision}</td>
                      <td className="px-2 py-1">{r.tipo} · {r.tipoLabel}</td>
                      <td className="px-2 py-1 text-right font-mono tabular-nums">{r.folio}</td>
                      <td className="px-2 py-1 truncate max-w-[200px]">{razon || "—"}</td>
                      <td className="px-2 py-1 font-mono">{formatRutForDisplay(rut)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(r.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Fila por archivo en el preview multi-file: muestra nombre, kind detectada,
// cantidad de docs, warning de mismatch de RUT, errores de parsing y checkbox
// para excluir del import.
function FileRow({ file, existingIds, companyRut, onToggle }) {
  const dupCount = file.records.filter((r) => existingIds.has(r.id)).length;
  const newCount = file.records.length - dupCount;
  const periodos = useMemo(() => {
    const set = new Set();
    for (const r of file.records) if (r.periodo) set.add(r.periodo);
    return [...set].sort().join(", ") || "—";
  }, [file.records]);

  const showRutWarning = file.rutMismatch;
  const isFailed = file.parseFailed;

  return (
    <div
      className={`flex flex-col gap-1 rounded-md border px-3 py-2 ${
        file.excluded
          ? "border-[var(--color-border)] bg-[var(--color-surface-2)] opacity-60"
          : isFailed
            ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)]"
            : showRutWarning
              ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)]"
      }`}
    >
      <div className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!file.excluded && !isFailed}
          disabled={isFailed}
          onChange={onToggle}
          className="h-4 w-4"
        />
        <span className="flex-1 truncate font-mono text-xs">{file.name}</span>
        {!isFailed && file.kind && (
          <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] uppercase">
            {file.kind === "venta" ? "📤 facturas" : "📥 compras"}
          </span>
        )}
        {!isFailed && (
          <span className="text-xs tabular-nums">
            {fmtNumber(file.records.length)} doc{file.records.length === 1 ? "" : "s"}
            {dupCount > 0 && (
              <span className="ml-1 text-[var(--color-warning)]">({dupCount} sobreescriben)</span>
            )}
          </span>
        )}
      </div>
      {!isFailed && (
        <div className="ml-6 text-[10px] text-[var(--color-muted)]">
          Período: <span className="font-mono">{periodos}</span>
          {" · "}
          Total: <span className="tabular-nums">{fmtCurrency(file.stats.totalAmount)}</span>
          {file.detectedRut && (
            <>
              {" · "}
              RUT detectado: <span className="font-mono">{file.detectedRut}</span>
            </>
          )}
        </div>
      )}
      {showRutWarning && !file.excluded && (
        <div className="ml-6 text-[11px] font-medium text-[var(--color-warning)]">
          ⚠ El archivo parece pertenecer al RUT <span className="font-mono">{file.detectedRut}</span>, distinto del seleccionado (<span className="font-mono">{normalizeRut(companyRut || "")}</span>). Excluí este archivo si fue un error.
        </div>
      )}
      {isFailed && (
        <div className="ml-6 text-[11px] font-medium text-[var(--color-danger)]">
          ✕ No se pudo parsear: {file.errors[0]?.message || "error desconocido"}
        </div>
      )}
      {!isFailed && file.errors.length > 0 && (
        <div className="ml-6 text-[10px] text-[var(--color-danger)]">
          {file.errors.length} línea{file.errors.length === 1 ? "" : "s"} con errores (se ignoran)
        </div>
      )}
    </div>
  );
}

// CRUD inline de empresas. Lista + formulario para agregar/editar/borrar.
// El alias es lo que se muestra en la UI; razón social va en el detalle.
function CompaniesModal({ companies, onClose, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null); // { id?, rut, razonSocial, alias }
  const [busy, setBusy] = useState(false);

  const startNew = () => setEditing({ id: null, rut: "", razonSocial: "", alias: "" });
  const startEdit = (c) => setEditing({ id: c.id, rut: c.rut, razonSocial: c.razonSocial, alias: c.alias || "" });

  const save = async () => {
    if (!editing.rut.trim() || !editing.razonSocial.trim()) {
      toast.warning("Completá RUT y Razón Social.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        rut: normalizeRut(editing.rut),
        razonSocial: editing.razonSocial.trim(),
        alias: (editing.alias || "").trim() || editing.razonSocial.trim(),
        enabled: true,
      };
      if (editing.id) {
        await companiesService.update(editing.id, payload);
      } else {
        await companiesService.create(payload);
      }
      setEditing(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c) => {
    if (!confirm(`¿Eliminar la empresa "${c.alias || c.razonSocial}"?\n\nAtención: los documentos importados con esta empresa quedarán huérfanos.`)) return;
    setBusy(true);
    try {
      await companiesService.remove(c.id);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="lg" title="Empresas">
      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">RUT</label>
            <input
              value={editing.rut}
              onChange={(e) => setEditing({ ...editing, rut: e.target.value })}
              placeholder="76.123.456-7"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Razón Social</label>
            <input
              value={editing.razonSocial}
              onChange={(e) => setEditing({ ...editing, razonSocial: e.target.value })}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Alias (display)</label>
            <input
              value={editing.alias}
              onChange={(e) => setEditing({ ...editing, alias: e.target.value })}
              placeholder="HP, Agroquinta, etc."
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[10px] text-[var(--color-muted)]">
              Si lo dejás vacío, se usa la razón social.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setEditing(null)}
              disabled={busy}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
            >
              Cancelar
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
            >
              {busy ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex justify-end">
            <button
              onClick={startNew}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)]"
            >
              + Nueva empresa
            </button>
          </div>
          {companies.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
              No hay empresas registradas todavía.
            </div>
          ) : (
            <div className="space-y-1">
              {companies.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">
                      🏢 {c.alias || c.razonSocial}
                      {c.alias && c.alias !== c.razonSocial && (
                        <span className="ml-2 text-xs text-[var(--color-muted)]">({c.razonSocial})</span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-[var(--color-muted)]">{c.rut}</div>
                  </div>
                  <button
                    onClick={() => startEdit(c)}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => remove(c)}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <button
              onClick={onClose}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Modal con todas las facturas pendientes (cualquier período) de la empresa
// seleccionada. Las separa en tres bloques (factura completa / abono parcial /
// IVA pendiente) con subtotales y un total general. Toolbar de export idéntico
// al de Retenciones: Copiar / PNG / Imprimir / XLSX.
function PendientesModal({ items, totals, company, onClose, onSelectDoc }) {
  const toast = useToast();
  const printRef = useRef(null);
  const [busy, setBusy] = useState("");

  const byCategory = useMemo(() => {
    const m = { full: [], partial: [], iva: [] };
    for (const d of items) m[d._category].push(d);
    return m;
  }, [items]);

  const fileBase = useMemo(() => {
    const alias = (company?.alias || company?.razonSocial || "empresa").replace(/[^\w-]+/g, "_");
    return `Pendientes_${alias}_${todayIso()}`;
  }, [company]);

  const handleCopy = async () => {
    if (!printRef.current) return;
    setBusy("copy");
    try {
      const blob = await toBlob(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada al portapapeles");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handlePng = async () => {
    if (!printRef.current) return;
    setBusy("png");
    try {
      const dataUrl = await toPng(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = `${fileBase}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      toast.error("Error PNG: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const html = printRef.current.outerHTML;
    const win = window.open("", "_blank", "width=1000,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Pendientes</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; }
        thead th { background: #92d050 !important; text-align: left; }
        @media print { @page { size: landscape; margin: 12mm; } }
      </style>
    </head><body>${html}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  };

  const handleXlsx = async () => {
    setBusy("xlsx");
    try {
      const ExcelJS = (await import("exceljs")).default || (await import("exceljs"));
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Pendientes");
      ws.getColumn(1).width = 6;  // col A vacía half-width (convención)
      ws.getColumn(2).width = 12; // Fecha
      ws.getColumn(3).width = 26; // Documento
      ws.getColumn(4).width = 10; // Folio
      ws.getColumn(5).width = 34; // Contraparte
      ws.getColumn(6).width = 16; // RUT
      ws.getColumn(7).width = 16; // Total
      ws.getColumn(8).width = 16; // Pagado
      ws.getColumn(9).width = 16; // Pendiente

      ws.getCell("B2").value = `PENDIENTES — ${company?.alias || company?.razonSocial || ""}`;
      ws.getCell("B2").font = { bold: true, size: 14 };
      ws.mergeCells("B2:I2");
      ws.getCell("B3").value = `Generado ${todayIso()} · ${items.length} factura${items.length === 1 ? "" : "s"} con saldo · Total pendiente ${fmtCurrency(totals.total)}`;
      ws.getCell("B3").font = { italic: true, color: { argb: "FF555555" } };
      ws.mergeCells("B3:I3");

      let r = 5;
      const writeHeaders = () => {
        const headers = ["Fecha", "Documento", "Folio", "Contraparte", "RUT", "Total", "Pagado", "Pendiente"];
        headers.forEach((h, i) => {
          const c = ws.getCell(r, 2 + i);
          c.value = h;
          c.font = { bold: true };
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF92D050" } };
          c.alignment = { horizontal: i <= 4 ? "left" : "right" };
          c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
        });
        r++;
      };

      const catOrder = ["full", "partial", "iva"];
      for (const cat of catOrder) {
        const list = byCategory[cat];
        if (list.length === 0) continue;
        // Sub-header por categoría
        const meta = PENDIENTE_CATS[cat];
        const subHexClean = meta.hex.replace("#", "");
        const argb = `FF${subHexClean.toUpperCase()}`;
        ws.getCell(r, 2).value = `${meta.label} (${list.length})`;
        ws.getCell(r, 2).font = { bold: true };
        for (let col = 2; col <= 9; col++) {
          ws.getCell(r, col).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
          ws.getCell(r, col).border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
        }
        ws.mergeCells(r, 2, r, 9);
        r++;
        writeHeaders();
        const dataStart = r;
        for (const d of list) {
          const razon = d.kind === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor;
          const rut = d.kind === "venta" ? d.rutReceptor : d.rutEmisor;
          const paid = Number(d.amountPaid) || 0;
          const cells = [
            d.fechaEmision || "",
            d.tipoLabel || dteTypeLabel(d.tipo),
            d.folio,
            razon || "",
            formatRutForDisplay(rut) || "",
            Number(d.total) || 0,
            paid,
            d._pending,
          ];
          cells.forEach((v, j) => {
            const c = ws.getCell(r, 2 + j);
            c.value = v;
            c.alignment = { horizontal: j <= 4 ? "left" : "right" };
            c.border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
            if (j === 7) c.font = { bold: true }; // Pendiente bold
            if (j >= 5) c.numFmt = '"$"#,##0';
          });
          r++;
        }
        // Subtotal de la categoría
        const lastDataRow = r - 1;
        ws.getCell(r, 2).value = "Subtotal";
        ws.getCell(r, 2).font = { bold: true };
        ws.mergeCells(r, 2, r, 8);
        for (let col = 2; col <= 9; col++) {
          ws.getCell(r, col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
          ws.getCell(r, col).border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
          ws.getCell(r, col).font = { bold: true };
        }
        ws.getCell(r, 9).value = { formula: `SUM(I${dataStart}:I${lastDataRow})`, result: totals[cat] };
        ws.getCell(r, 9).alignment = { horizontal: "right" };
        ws.getCell(r, 9).numFmt = '"$"#,##0';
        r++;
        r++; // gap
      }

      // Total general
      ws.getCell(r, 2).value = "TOTAL PENDIENTE";
      ws.mergeCells(r, 2, r, 8);
      for (let col = 2; col <= 9; col++) {
        ws.getCell(r, col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
        ws.getCell(r, col).border = { top: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" }, bottom: { style: "thin" } };
        ws.getCell(r, col).font = { bold: true };
      }
      ws.getCell(r, 9).value = totals.total;
      ws.getCell(r, 9).alignment = { horizontal: "right" };
      ws.getCell(r, 9).numFmt = '"$"#,##0';

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${fileBase}.xlsx`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      toast.error("Error XLSX: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  return (
    <Modal open onClose={onClose} size="3xl" title={`Pendientes — ${company?.alias || company?.razonSocial || "empresa"}`}>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          🎉 No hay facturas con saldo pendiente. Todo al día.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryCard label="Facturas pendientes" value={fmtNumber(items.length)} />
              <SummaryCard label="Factura completa" value={fmtCurrency(totals.full)} warning />
              <SummaryCard label="Abono parcial" value={fmtCurrency(totals.partial)} />
              <SummaryCard label="IVA pendiente" value={fmtCurrency(totals.iva)} />
            </div>
          </div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="text-[var(--color-muted)]">Total pendiente: </span>
              <span className="font-semibold text-[var(--color-warning)] tabular-nums">{fmtCurrency(totals.total)}</span>
            </div>
            <div className="flex gap-1">
              <button
                onClick={handleCopy}
                disabled={!!busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
                title="Copiar como imagen"
              >
                {busy === "copy" ? "..." : "📋 Copiar"}
              </button>
              <button
                onClick={handlePng}
                disabled={!!busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
                title="Descargar PNG"
              >
                {busy === "png" ? "..." : "📥 PNG"}
              </button>
              <button
                onClick={handlePrint}
                disabled={!!busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
                title="Imprimir"
              >
                🖨 Imprimir
              </button>
              <button
                onClick={handleXlsx}
                disabled={!!busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
                title="Exportar XLSX"
              >
                {busy === "xlsx" ? "..." : "📊 XLSX"}
              </button>
            </div>
          </div>

          {/* Tabla en pantalla — agrupada por categoría con subtotales. */}
          <div className="max-h-[60vh] overflow-auto rounded-md border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="px-2 py-2 text-left">Fecha</th>
                  <th className="px-2 py-2 text-left">Documento</th>
                  <th className="px-2 py-2 text-right">Folio</th>
                  <th className="px-2 py-2 text-left">Contraparte</th>
                  <th className="px-2 py-2 text-left">RUT</th>
                  <th className="px-2 py-2 text-right">Total</th>
                  <th className="px-2 py-2 text-right">Pagado</th>
                  <th className="px-2 py-2 text-right">Pendiente</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {["full", "partial", "iva"].map((cat) => {
                  const list = byCategory[cat];
                  if (list.length === 0) return null;
                  const meta = PENDIENTE_CATS[cat];
                  return (
                    <React.Fragment key={cat}>
                      <tr style={{ background: meta.hex }}>
                        <td colSpan={9} className="px-2 py-1.5 text-xs font-semibold text-black">
                          {meta.label} <span className="font-normal">· {list.length} factura{list.length === 1 ? "" : "s"} · {fmtCurrency(totals[cat])}</span>
                        </td>
                      </tr>
                      {list.map((d) => {
                        const razon = d.kind === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor;
                        const rut = d.kind === "venta" ? d.rutReceptor : d.rutEmisor;
                        const paid = Number(d.amountPaid) || 0;
                        return (
                          <tr key={d.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                            <td className="px-2 py-1.5 font-mono text-xs">{d.fechaEmision}</td>
                            <td className="px-2 py-1.5 text-xs">{d.tipoLabel || dteTypeLabel(d.tipo)}</td>
                            <td className="px-2 py-1.5 text-right font-mono tabular-nums">{d.folio}</td>
                            <td className="px-2 py-1.5 truncate max-w-[260px]">{razon || "—"}</td>
                            <td className="px-2 py-1.5 font-mono text-xs">{formatRutForDisplay(rut)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{fmtCurrency(d.total)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-muted)]">{paid > 0 ? fmtCurrency(paid) : "—"}</td>
                            <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-[var(--color-warning)]">{fmtCurrency(d._pending)}</td>
                            <td className="px-2 py-1.5 text-center">
                              <button
                                onClick={() => onSelectDoc(d)}
                                title="Abrir detalle"
                                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
                              >
                                ℹ
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      <tr className="bg-[var(--color-surface-2)]">
                        <td colSpan={7} className="px-2 py-1.5 text-right text-xs font-semibold">Subtotal {meta.label}</td>
                        <td className="px-2 py-1.5 text-right font-bold tabular-nums">{fmtCurrency(totals[cat])}</td>
                        <td></td>
                      </tr>
                    </React.Fragment>
                  );
                })}
                <tr className="border-t-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)]">
                  <td colSpan={7} className="px-2 py-2 text-right text-sm font-bold">TOTAL PENDIENTE</td>
                  <td className="px-2 py-2 text-right text-base font-bold tabular-nums text-[var(--color-accent)]">{fmtCurrency(totals.total)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Off-screen printable — capturado por html-to-image / print. */}
          <div style={{ position: "absolute", left: -99999, top: 0, pointerEvents: "none" }} aria-hidden>
            <PrintablePendientes
              ref={printRef}
              items={items}
              byCategory={byCategory}
              totals={totals}
              company={company}
            />
          </div>
        </>
      )}
    </Modal>
  );
}

// Printable de pendientes — limpio, sin controles. Agrupa por categoría con
// sub-header coloreado y subtotal por categoría. Mismo aesthetic Excel-style
// del resto de los exports del proyecto.
const PrintablePendientes = forwardRef(function PrintablePendientes(
  { items, byCategory, totals, company },
  ref,
) {
  const today = todayIso();
  return (
    <div
      ref={ref}
      style={{
        background: "#ffffff",
        color: "#000",
        padding: 16,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        minWidth: 900,
      }}
    >
      <div style={{ marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15, textTransform: "uppercase" }}>
          PENDIENTES — {(company?.alias || company?.razonSocial || "—").toString().toUpperCase()}
        </div>
        <div style={{ fontSize: 12, color: "#444" }}>{today}</div>
      </div>
      <div style={{ marginBottom: 8, fontSize: 11, color: "#444" }}>
        {items.length} factura{items.length === 1 ? "" : "s"} con saldo pendiente. Desglose por tipo.
      </div>

      {/* Banner total pendiente */}
      <div style={{
        marginBottom: 12, padding: "10px 14px", background: "#fff4ce",
        border: "2px solid #f4b400", borderRadius: 6,
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
          TOTAL PENDIENTE
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
          {fmtCurrency(totals.total)}
        </div>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#92d050" }}>
            <th style={{ ...pCellH, width: 90 }}>FECHA</th>
            <th style={pCellH}>DOCUMENTO</th>
            <th style={{ ...pCellH, textAlign: "right", width: 70 }}>FOLIO</th>
            <th style={pCellH}>CONTRAPARTE</th>
            <th style={pCellH}>RUT</th>
            <th style={{ ...pCellH, textAlign: "right" }}>TOTAL</th>
            <th style={{ ...pCellH, textAlign: "right" }}>PAGADO</th>
            <th style={{ ...pCellH, textAlign: "right" }}>PENDIENTE</th>
          </tr>
        </thead>
        <tbody>
          {["full", "partial", "iva"].map((cat) => {
            const list = byCategory[cat];
            if (list.length === 0) return null;
            const meta = PENDIENTE_CATS[cat];
            return (
              <React.Fragment key={`pcat_${cat}`}>
                <tr style={{ background: meta.hex }}>
                  <td style={{ ...pCell, fontWeight: 700 }} colSpan={8}>
                    {meta.label}
                    <span style={{ marginLeft: 8, fontWeight: 400, color: "#444" }}>
                      · {list.length} factura{list.length === 1 ? "" : "s"}
                    </span>
                  </td>
                </tr>
                {list.map((d) => {
                  const razon = d.kind === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor;
                  const rut = d.kind === "venta" ? d.rutReceptor : d.rutEmisor;
                  const paid = Number(d.amountPaid) || 0;
                  return (
                    <tr key={`p_${d.id}`}>
                      <td style={{ ...pCell, fontVariantNumeric: "tabular-nums" }}>{d.fechaEmision || "—"}</td>
                      <td style={pCell}>{d.tipoLabel || dteTypeLabel(d.tipo)}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.folio}</td>
                      <td style={pCell}>{razon || "—"}</td>
                      <td style={{ ...pCell, fontVariantNumeric: "tabular-nums" }}>{formatRutForDisplay(rut) || "—"}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(d.total)}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#666" }}>{paid > 0 ? fmtCurrency(paid) : "—"}</td>
                      <td style={{ ...pCell, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{fmtCurrency(d._pending)}</td>
                    </tr>
                  );
                })}
                <tr style={{ background: "#f2f2f2" }}>
                  <td style={{ ...pCell, fontWeight: 700 }} colSpan={7}>Subtotal {meta.label}</td>
                  <td style={{ ...pCell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totals[cat])}</td>
                </tr>
              </React.Fragment>
            );
          })}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...pCell, fontWeight: 700 }} colSpan={7}>TOTAL PENDIENTE</td>
            <td style={{ ...pCell, textAlign: "right", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
});
