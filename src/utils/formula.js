// Parse a cell input. Accepts:
//   - Numbers ("1500", "1.500", "1,5")
//   - Formulas starting with "=" using only digits and + - * / ( ) .
// Returns a finite number or 0 on error.
export function parseAmount(input) {
  if (input == null) return 0;
  if (typeof input === "number") return Number.isFinite(input) ? input : 0;
  const s = String(input).trim();
  if (!s) return 0;

  if (s.startsWith("=")) {
    const expr = s.slice(1).trim();
    if (!/^[\d+\-*/().\s]+$/.test(expr)) return 0;
    try {
      // eslint-disable-next-line no-new-func
      const value = Function(`"use strict"; return (${expr});`)();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  // Allow Chilean-style "1.500,25" or plain "1500.25"
  const cleaned = s.replace(/\s/g, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    return Number(cleaned.replace(/\./g, "").replace(",", ".")) || 0;
  }
  return Number(cleaned.replace(",", ".")) || 0;
}
