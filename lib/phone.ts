// Normalización de teléfonos de Colombia (v5 Parte 2B).
// MISMA lógica que normalizePhoneCO en server.js: si cambias una regla
// aquí, cambia la otra igual, o el frontend y el servidor discrepan.
//
// Reglas (en orden):
// - Se quitan espacios, guiones, paréntesis y puntos.
// - 10 dígitos que empiezan por 3 (celular colombiano) -> +57 + dígitos.
// - 12 dígitos que empiezan por 57 (con o sin +) -> +57 + últimos 10.
// - Si ya viene +57... con 13 caracteres, queda igual (cubre la regla anterior).
// - Cualquier otro caso (fijo de Bogotá 601..., número corto, extranjero,
//   vacío) se deja tal cual: nunca se inventa un +57.
//
// Ejemplos:
//   normalizePhoneCO('300 123 4567')   -> '+573001234567'
//   normalizePhoneCO('300-123-4567')   -> '+573001234567'
//   normalizePhoneCO('(300) 123.4567') -> '+573001234567'
//   normalizePhoneCO('573001234567')   -> '+573001234567'
//   normalizePhoneCO('+573001234567')  -> '+573001234567'
//   normalizePhoneCO('6012345678')     -> '6012345678' (no se toca)
//   normalizePhoneCO('')               -> ''
export function normalizePhoneCO(value: string | null | undefined): string {
  const original = (value ?? '').trim();
  if (!original) return '';
  const digits = original.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return `+57${digits}`;
  if (digits.length === 12 && digits.startsWith('57')) return `+57${digits.slice(2)}`;
  return original;
}

/** Formato legible para mostrar: '+57 300 123 4567'. Si no es normalizable, tal cual. */
export function formatPhoneCO(value: string | null | undefined): string {
  const normalized = normalizePhoneCO(value);
  if (/^\+57\d{10}$/.test(normalized)) {
    const d = normalized.slice(3);
    return `+57 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  }
  return (value ?? '').trim();
}
