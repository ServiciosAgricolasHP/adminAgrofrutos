// Payroll helpers — Banco de Chile nómina format + Transferencias + Efectivo.
// ExcelJS is loaded lazily — only when the user actually exports.
import { ACCOUNT_TYPES, bankName, isCashBank } from "./banks";
import { normalizeRut } from "./rutUtils";
import { getTratoTierTotals } from "./cosechaCombos";

// Strip accents and special chars (BChile only accepts ASCII).
export function cleanText(text) {
  if (!text) return "";
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns RUT digits + DV (no dash, no dots), or empty if can't parse.
export function rutWithDvNoDash(rut) {
  const r = normalizeRut(rut);
  const m = r.match(/^(\d+)-([0-9KBH])$/);
  if (!m) return r.replace(/[-.]/g, "");
  return m[1] + m[2];
}

// Map account type code (0/1/3) → BChile code (CTD / JUV / JUV).
export function bchileAccountTypeCode(accountTypeValue) {
  const v = Number(accountTypeValue);
  const found = ACCOUNT_TYPES.find((t) => t.value === v);
  return found?.code || "JUV";
}

// Aggregate amount per worker, per cycle, respecting labor type.
// Returns: [{ rut, total, byCycle: { [cycleId]: amount }, workdayIds: [] }]
export function aggregateWorkerAmounts(workdays, laborTypeById) {
  const byWorker = new Map();
  for (const wd of workdays) {
    if (!wd.workerRut) continue;
    const type = laborTypeById.get(wd.laborId);
    let amount = 0;
    if (type === "trato") {
      amount = getTratoTierTotals(wd).amount;
    } else {
      amount = Number(wd.amount) || 0;
    }
    if (amount === 0) continue;
    if (!byWorker.has(wd.workerRut)) {
      byWorker.set(wd.workerRut, { rut: wd.workerRut, total: 0, byCycle: {}, workdayIds: [] });
    }
    const e = byWorker.get(wd.workerRut);
    e.total += amount;
    e.byCycle[wd.cycleId] = (e.byCycle[wd.cycleId] || 0) + amount;
    if (wd.id) e.workdayIds.push(wd.id);
  }
  return [...byWorker.values()];
}

// Validate the bank account number — returns null if OK, error string otherwise.
// Lightweight sanity checks; not bank-format-specific, just catches obvious mistakes.
export function validateAccountNumber(accountNumber, bankCode) {
  if (isCashBank(bankCode)) return null;
  const s = String(accountNumber || "").trim();
  if (!s) return "cuenta vacía";
  if (!/^[0-9-]+$/.test(s)) return "contiene caracteres no numéricos";
  const digits = s.replace(/-/g, "");
  if (digits.length < 4) return "muy corta (<4 dígitos)";
  if (digits.length > 20) return "demasiado larga";
  if (/^0+$/.test(digits)) return "todo ceros";
  return null;
}

export function splitBankAndCash(items) {
  const bank = [];
  const cash = [];
  for (const it of items) {
    if (isCashBank(it.bankCode)) cash.push(it);
    else bank.push(it);
  }
  return { bank, cash };
}

// Normalize leader names to UPPERCASE-trimmed so case-only duplicates merge
// (e.g. "Grupo Oliver" / "GRUPO OLIVER" / "grupo oliver" → all the same group).
export function normalizeLeader(s) {
  return String(s || "").trim().toUpperCase();
}

export function groupCashByLeader(cashItems) {
  const groups = new Map();
  for (const it of cashItems) {
    const leader = normalizeLeader(it.groupLeader) || "Sin líder";
    if (!groups.has(leader)) groups.set(leader, { leader, items: [], total: 0 });
    const g = groups.get(leader);
    g.items.push(it);
    g.total += Number(it.amount) || 0;
  }
  return [...groups.values()].sort((a, b) => a.leader.localeCompare(b.leader));
}

export const groupItemsByLeader = groupCashByLeader;

// ─────────────────────────── Styling helpers ───────────────────────────
const BORDER_THIN = { style: "thin", color: { argb: "FF999999" } };
const BORDER_ALL = { top: BORDER_THIN, left: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN };

const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

// Header (light blue like the screenshot).
const STYLE_HEADER = { font: { bold: true }, fill: fill("FFB7DEE8"), border: BORDER_ALL, alignment: { vertical: "middle" } };

// Group leader row (per-leader). Cycle through warm colors so each group is visibly distinct.
const LEADER_FILLS = ["FFFFE699", "FFC6E0B4", "FFF8CBAD", "FFB4C7E7", "FFE2C2F0", "FFFFC9C9", "FFCFE7F5", "FFD9D2E9"];
const ITEM_FILLS = ["FFFFF2CC", "FFE2EFDA", "FFFCE4D6", "FFD9E1F2", "FFEAD8F2", "FFFCE0E0", "FFE7F2F8", "FFEEE7F4"];

const STYLE_GROUP_TOTAL = (idx) => ({
  font: { bold: true },
  fill: fill(LEADER_FILLS[idx % LEADER_FILLS.length]),
  border: BORDER_ALL,
});
const STYLE_GROUP_ITEM = (idx) => ({
  fill: fill(ITEM_FILLS[idx % ITEM_FILLS.length]),
  border: BORDER_ALL,
});

const STYLE_GRAND_TOTAL = { font: { bold: true, size: 12 }, fill: fill("FFC6EFCE"), border: BORDER_ALL };
const STYLE_BANK_TOTAL = { font: { bold: true }, fill: fill("FFD9E1F2"), border: BORDER_ALL };
const STYLE_CELL = { border: BORDER_ALL };

// ─────────────────────────── BChile sheet ───────────────────────────
const BCHILE_DEFAULT_EMAIL = "remuneracionesis@gmail.com";

function buildBchileSheet(wb, items) {
  const ws = wb.addWorksheet("Nomina");
  const headers = [
    "Rut Beneficiario *",
    "Nombre Beneficiario *",
    "Cuenta beneficiario *",
    "Cod Banco *",
    "Monto *",
    "Tipo de Cuenta *",
    "Identificador",
    "Descripcion del Pago",
    "Mail destinatario",
    "Campo Libre 1  (Glosa 1)",
    "Campo Libre 2 (Glosa 2)",
  ];
  ws.addRow(headers);
  // Orden alfabético por nombre para que el correlativo A001…A999 sea estable.
  const sorted = [...items].sort((a, b) =>
    cleanText(a.name || "").localeCompare(cleanText(b.name || ""), "es", { sensitivity: "base" }),
  );
  sorted.forEach((it, idx) => {
    const identifier = `A${String(idx + 1).padStart(3, "0")}`;
    // `paymentRut` viene de bankDetails[0] (la cuenta destino del banco) y
    // puede diferir del RUT de la persona — p.ej. cuando el pago va a una
    // cuenta de un familiar. El portal de BChile lo valida contra la
    // titularidad de la cuenta, así que SIEMPRE va paymentRut acá.
    ws.addRow([
      rutWithDvNoDash(it.paymentRut || it.rut),
      cleanText(it.name),
      String(it.accountNumber || ""),
      String(it.bankCode || ""),
      Math.round(Number(it.amount) || 0),
      bchileAccountTypeCode(it.accountType),
      identifier,
      "",
      it.email || BCHILE_DEFAULT_EMAIL,
      "",
      "",
    ]);
  });
  ws.getRow(1).eachCell((c) => (c.style = STYLE_HEADER));
  ws.columns.forEach((col, i) => {
    col.width = i === 1 ? 30 : i === 8 ? 28 : 16;
  });
  return ws;
}

// ─────────────────────────── Transferencias sheet ───────────────────────────
// items: bank items, cycles: [{ id, label }]
function buildTransferenciasSheet(wb, items, cycles) {
  const ws = wb.addWorksheet("Transferencias");
  const cycleHeaders = cycles.map((c) => c.label || c.id);
  const headers = ["RUT", "NOMBRE", ...cycleHeaders, "TOTAL"];
  ws.addRow(headers);

  for (const it of items) {
    const cycleAmounts = cycles.map((c) =>
      it.byCycle && it.byCycle[c.id] ? Math.round(it.byCycle[c.id]) : "",
    );
    ws.addRow([
      it.rut,
      it.name,
      ...cycleAmounts,
      Math.round(Number(it.amount) || 0),
    ]);
  }

  // Totals row
  const totalsByCycle = cycles.map((c) =>
    items.reduce((s, it) => s + (it.byCycle?.[c.id] || 0), 0),
  );
  const grand = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const totalsRow = ws.addRow([
    "",
    "TOTAL CICLO",
    ...totalsByCycle.map((v) => Math.round(v)),
    Math.round(grand),
  ]);

  // Style header
  ws.getRow(1).eachCell((c) => (c.style = STYLE_HEADER));
  // Style data cells (just borders + currency format on numeric cols)
  const totalCol = headers.length;
  for (let r = 2; r < totalsRow.number; r++) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.style = { ...STYLE_CELL };
      if (colNum >= 3) cell.numFmt = '"$"#,##0;[Red]"$"#,##0;""';
    });
  }
  // Style totals
  totalsRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = colNum === totalCol ? STYLE_GRAND_TOTAL : STYLE_BANK_TOTAL;
    if (colNum >= 3) cell.numFmt = '"$"#,##0';
  });

  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 28;
  for (let i = 3; i <= totalCol; i++) ws.getColumn(i).width = 14;
}

// ─────────────────────────── Efectivo sheet ───────────────────────────
function buildEfectivoSheet(wb, cashItems, cycles) {
  if (cashItems.length === 0) return;
  const ws = wb.addWorksheet("Efectivo");
  const cycleHeaders = cycles.map((c) => c.label || c.id);
  const headers = ["LÍDER", "RUT", "NOMBRE", ...cycleHeaders, "TOTAL"];
  ws.addRow(headers);
  ws.getRow(1).eachCell((c) => (c.style = STYLE_HEADER));

  const totalCol = headers.length;
  const groups = groupCashByLeader(cashItems);

  let leaderIdx = 0;
  for (const g of groups) {
    const leaderStyleTotal = STYLE_GROUP_TOTAL(leaderIdx);
    const leaderStyleItem = STYLE_GROUP_ITEM(leaderIdx);

    // Items first
    for (const it of g.items) {
      const cycleAmounts = cycles.map((c) =>
        it.byCycle && it.byCycle[c.id] ? Math.round(it.byCycle[c.id]) : "",
      );
      const row = ws.addRow([
        leaderIdx === 0 || g.items.indexOf(it) === 0 ? g.leader : "",
        it.rut,
        it.name,
        ...cycleAmounts,
        Math.round(Number(it.amount) || 0),
      ]);
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.style = { ...leaderStyleItem };
        if (colNum >= 4) cell.numFmt = '"$"#,##0;[Red]"$"#,##0;""';
      });
    }

    // Subtotal row per leader
    const subTotalsByCycle = cycles.map((c) =>
      g.items.reduce((s, it) => s + (it.byCycle?.[c.id] || 0), 0),
    );
    const subRow = ws.addRow([
      "",
      "",
      `Subtotal ${g.leader}`,
      ...subTotalsByCycle.map((v) => Math.round(v)),
      Math.round(g.total),
    ]);
    subRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.style = { ...leaderStyleTotal };
      if (colNum >= 4) cell.numFmt = '"$"#,##0';
    });

    // Spacer (no fill)
    ws.addRow([]);
    leaderIdx++;
  }

  // Grand total
  const grandTotalsByCycle = cycles.map((c) =>
    cashItems.reduce((s, it) => s + (it.byCycle?.[c.id] || 0), 0),
  );
  const grand = cashItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const grandRow = ws.addRow([
    "",
    "",
    "TOTAL EFECTIVO",
    ...grandTotalsByCycle.map((v) => Math.round(v)),
    Math.round(grand),
  ]);
  grandRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = STYLE_GRAND_TOTAL;
    if (colNum >= 4) cell.numFmt = '"$"#,##0';
  });

  ws.getColumn(1).width = 18;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 28;
  for (let i = 4; i <= totalCol; i++) ws.getColumn(i).width = 14;
}

// ─────────────────────────── Resumen sheet ───────────────────────────
function buildResumenSheet(wb, bankItems, cashItems, cycles) {
  const ws = wb.addWorksheet("Resumen");
  const headers = ["Concepto", ...cycles.map((c) => c.label || c.id), "TOTAL"];
  ws.addRow(headers);
  ws.getRow(1).eachCell((c) => (c.style = STYLE_HEADER));

  const sumByCycle = (items) =>
    cycles.map((c) => items.reduce((s, it) => s + (it.byCycle?.[c.id] || 0), 0));
  const sum = (items) => items.reduce((s, it) => s + (Number(it.amount) || 0), 0);

  const bankRow = ws.addRow([
    "🏦 Transferencias",
    ...sumByCycle(bankItems).map((v) => Math.round(v)),
    Math.round(sum(bankItems)),
  ]);
  bankRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = STYLE_BANK_TOTAL;
    if (colNum >= 2) cell.numFmt = '"$"#,##0';
  });

  const cashRow = ws.addRow([
    "💵 Efectivo",
    ...sumByCycle(cashItems).map((v) => Math.round(v)),
    Math.round(sum(cashItems)),
  ]);
  cashRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = { font: { bold: true }, fill: fill("FFFFE699"), border: BORDER_ALL };
    if (colNum >= 2) cell.numFmt = '"$"#,##0';
  });

  const total = sum(bankItems) + sum(cashItems);
  const totalByCycle = cycles.map(
    (c, i) => sumByCycle(bankItems)[i] + sumByCycle(cashItems)[i],
  );
  const totalRow = ws.addRow([
    "TOTAL GENERAL",
    ...totalByCycle.map((v) => Math.round(v)),
    Math.round(total),
  ]);
  totalRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.style = STYLE_GRAND_TOTAL;
    if (colNum >= 2) cell.numFmt = '"$"#,##0';
  });

  ws.getColumn(1).width = 28;
  for (let i = 2; i <= headers.length; i++) ws.getColumn(i).width = 14;
}

// ─────────────────────────── Public API ───────────────────────────
async function writeWorkbook(wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadBchileXlsx(items, filename = "Nomina", cycles = []) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const { bank, cash } = splitBankAndCash(items);

  // Nomina first — it's the file the bank ingests.
  buildBchileSheet(wb, bank);
  buildResumenSheet(wb, bank, cash, cycles);
  buildTransferenciasSheet(wb, bank, cycles);
  buildEfectivoSheet(wb, cash, cycles);

  await writeWorkbook(wb, filename);
}

// Just the BChile Nomina sheet — the file you upload to the bank portal.
export async function downloadNominaOnlyXlsx(items, filename = "Nomina") {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const { bank } = splitBankAndCash(items);
  buildBchileSheet(wb, bank);
  await writeWorkbook(wb, filename);
}

export function payrollSuggestedName(date = new Date()) {
  const year = date.getFullYear();
  const months = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ];
  const month = months[date.getMonth()];
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${year}${month}Semana${week}`;
}

export { bankName };
