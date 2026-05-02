// Bancos chilenos — código para nóminas.
export const BANKS = [
  { code: "012", name: "Banco del Estado de Chile" },
  { code: "001", name: "Banco de Chile" },
  { code: "037", name: "Banco Santander" },
  { code: "016", name: "Banco de Crédito e Inversiones" },
  { code: "504", name: "Banco BBVA" },
  { code: "027", name: "Banco Corpbanca" },
  { code: "028", name: "Banco BICE" },
  { code: "055", name: "Banco Consorcio" },
  { code: "507", name: "Banco del Desarrollo" },
  { code: "051", name: "Banco Falabella" },
  { code: "009", name: "Banco Internacional" },
  { code: "039", name: "Banco Itaú Chile" },
  { code: "053", name: "Banco Ripley" },
  { code: "031", name: "HSBC Bank (Chile)" },
  { code: "014", name: "Scotiabank / Sud Americano" },
  { code: "730", name: "Tempo" },
  { code: "875", name: "MercadoLibre" },
];

export const ACCOUNT_TYPES = [
  { value: 0, label: "Cuenta Corriente", code: "CTD" },
  { value: 1, label: "Cuenta Vista", code: "JUV" },
  { value: 3, label: "Cuenta RUT", code: "JUV" },
];

export const bankName = (code) => BANKS.find((b) => b.code === code)?.name || code || "—";
export const accountTypeLabel = (v) => ACCOUNT_TYPES.find((t) => t.value === Number(v))?.label || "—";

// bankDetails = [paymentRut, accountNumber, accountType, bankCode]
export const DEFAULT_BANK_CODE = "012";
export const ACCOUNT_TYPE_RUT = 3;

export function rutWithoutDv(rut) {
  if (!rut) return "";
  const [num] = String(rut).split("-");
  return num || "";
}

export function defaultBankDetails(rut) {
  const num = rutWithoutDv(rut);
  return [rut, num, ACCOUNT_TYPE_RUT, DEFAULT_BANK_CODE];
}

export function isCuentaRut(bankDetails) {
  return Number(bankDetails?.[2]) === ACCOUNT_TYPE_RUT;
}
