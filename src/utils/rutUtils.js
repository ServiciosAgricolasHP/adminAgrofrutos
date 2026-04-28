// RUT helpers — supports Chilean RUT and foreign IDs (7-9 digits ending in -B or -H).

const FOREIGN_SUFFIX = /^[BH]$/;

export function normalizeRut(value) {
  if (!value) return "";
  return String(value).replace(/[.\s]/g, "").toUpperCase();
}

export function isForeignRut(rut) {
  const r = normalizeRut(rut);
  const m = r.match(/^(\d{7,9})-([BH])$/);
  return Boolean(m);
}

function computeChileanDv(numStr) {
  let sum = 0;
  let mul = 2;
  for (let i = numStr.length - 1; i >= 0; i--) {
    sum += Number(numStr[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const rem = 11 - (sum % 11);
  if (rem === 11) return "0";
  if (rem === 10) return "K";
  return String(rem);
}

export function validateRut(value) {
  const r = normalizeRut(value);
  if (!r) return false;

  // Foreign: 7–9 digits + -B or -H
  const foreign = r.match(/^(\d{7,9})-([BH])$/);
  if (foreign) return FOREIGN_SUFFIX.test(foreign[2]);

  // Chilean: 1–8 digits + -DV (0–9 or K)
  const chilean = r.match(/^(\d{1,8})-([0-9K])$/);
  if (!chilean) return false;
  return computeChileanDv(chilean[1]) === chilean[2];
}

export function formatRutForDisplay(value) {
  const r = normalizeRut(value);
  if (!r) return "";
  const m = r.match(/^(\d+)-([0-9KBH])$/);
  if (!m) return r;
  const [, num, dv] = m;
  const withDots = num.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${dv}`;
}

export function cleanRutForStorage(value) {
  return normalizeRut(value);
}
