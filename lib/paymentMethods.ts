// Métodos de pago de SalonOS v1.2 — fuente única en el frontend.
// Deben coincidir con POS_METHODS de salon-routes.js (backend).
// "Bre-B / Llave Nu" es UN método aparte: la clienta paga a la cuenta Nu
// por llave Bre-B. Nunca se mezcla con "Transferencia banco" en el cierre.
export const PAYMENT_METHODS = [
  'efectivo',
  'nequi',
  'daviplata',
  'breb_nu',
  'transferencia_banco',
  'tarjeta_bold',
  'pse',
  'wompi',
  'payu',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  efectivo: 'Efectivo',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  breb_nu: 'Bre-B / Llave Nu',
  transferencia_banco: 'Transferencia banco',
  tarjeta_bold: 'Tarjeta Bold',
  pse: 'PSE',
  wompi: 'Wompi',
  payu: 'PayU',
};

// Métodos que se pueden registrar a mano en el salón (Nequi, llave Nu...).
// Wompi/PayU no van aquí: esos se cobran por link y los confirma el webhook.
export const MANUAL_PAYMENT_METHODS = [
  'efectivo',
  'nequi',
  'daviplata',
  'breb_nu',
  'transferencia_banco',
  'tarjeta_bold',
  'pse',
] as const;

// Mapeo de los métodos viejos (v1/v1.1) a los nuevos. Sin perder datos:
// un pago viejo guardado como "transferencia" se lee como
// "transferencia_banco" y uno como "bre-b" como "breb_nu".
export const LEGACY_PAYMENT_METHODS: Record<string, string> = {
  transferencia: 'transferencia_banco',
  'transferencia_bancaria': 'transferencia_banco',
  'bre-b': 'breb_nu',
  breb: 'breb_nu',
  bre_b: 'breb_nu',
  llave_nu: 'breb_nu',
  'llave-nu': 'breb_nu',
  nu: 'breb_nu',
  tarjeta: 'tarjeta_bold',
};

export function normalizePaymentMethod(raw: any): string | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if ((PAYMENT_METHODS as readonly string[]).includes(s)) return s;
  if (LEGACY_PAYMENT_METHODS[s]) return LEGACY_PAYMENT_METHODS[s];
  if (s.includes('llave') && s.includes('nu')) return 'breb_nu';
  if (s.includes('bre-b') || s.includes('breb')) return 'breb_nu';
  if (s.includes('transferencia')) return 'transferencia_banco';
  return null;
}

export function paymentMethodLabel(raw: any): string {
  const n = normalizePaymentMethod(raw);
  if (n) return PAYMENT_METHOD_LABELS[n];
  return String(raw || '—');
}

// Compatibilidad: los componentes exportaban METHODS.
export const METHODS = PAYMENT_METHODS;
