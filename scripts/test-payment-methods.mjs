// Prueba de métodos de pago v1.2 — sin DB ni WhatsApp real.
// Importa las funciones reales de salon-routes.js y comprueba:
// 1) el ticket mixto del encargo, 2) el mapeo de métodos viejos,
// 3) que un null no se multiplica, 4) rechazos, 5) el cierre por método.
import { normalizePaymentMethod, resolvePayments, POS_METHODS, PAYMENT_METHOD_LABELS } from '../salon-routes.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function throws(name, fn) {
  try { fn(); ok(name, false, '(no lanzó error)'); }
  catch (e) { ok(name, true); console.log(`      -> ${e.message}`); }
}

console.log('Métodos canónicos:', POS_METHODS.join(', '));
ok('9 métodos canónicos', POS_METHODS.length === 9);
ok('breb_nu tiene etiqueta "Bre-B / Llave Nu"', PAYMENT_METHOD_LABELS.breb_nu === 'Bre-B / Llave Nu');
ok('no existe método genérico "transferencia"', !POS_METHODS.includes('transferencia'));
ok('no existe método "bre-b"', !POS_METHODS.includes('bre-b'));

console.log('\nMapeo de métodos viejos (sin perder datos):');
ok('"transferencia" -> transferencia_banco', normalizePaymentMethod('transferencia') === 'transferencia_banco');
ok('"bre-b" -> breb_nu', normalizePaymentMethod('bre-b') === 'breb_nu');
ok('"breb" -> breb_nu', normalizePaymentMethod('breb') === 'breb_nu');
ok('"Bre-B / Llave Nu" -> breb_nu', normalizePaymentMethod('Bre-B / Llave Nu') === 'breb_nu');
ok('"NEQUI" (mayúsculas) -> nequi', normalizePaymentMethod('NEQUI') === 'nequi');
ok('método inventado -> null', normalizePaymentMethod('neqiu') === null);

console.log('\nTicket mixto del encargo (Nequi 40.000 + Bre-B/Llave Nu 20.000 + efectivo 10.000 = 70.000):');
const mixed = resolvePayments([
  { method: 'nequi', amount: 40000, reference: '123456' },
  { method: 'breb_nu', amount: 20000, reference: '98765' },
  { method: 'efectivo', amount: 10000 },
], 70000);
ok('3 partes normalizadas', mixed.length === 3);
ok('referencia guardada en Nequi', mixed[0].reference === '123456');
const byMethod = {};
for (const p of mixed) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
ok('Nequi = 40.000', byMethod.nequi === 40000);
ok('Bre-B / Llave Nu = 20.000', byMethod.breb_nu === 20000);
ok('Efectivo = 10.000', byMethod.efectivo === 10000);
ok('Llave Nu NO se mezcla con transferencia banco', (byMethod.transferencia_banco || 0) === 0);
ok('suma por método = 70.000', Object.values(byMethod).reduce((a, v) => a + v, 0) === 70000);

console.log('\nCierre con registros viejos (transferencia 10.000 + bre-b 5.000 + breb_nu 7.000 + nequi 40.000):');
const oldRows = [
  { method: 'transferencia', amount: 10000 },
  { method: 'bre-b', amount: 5000 },
  { method: 'breb_nu', amount: 7000 },
  { method: 'nequi', amount: 40000 },
];
const close = Object.fromEntries(POS_METHODS.map((m) => [m, 0]));
for (const p of oldRows) close[normalizePaymentMethod(p.method)] += p.amount;
ok('transferencia vieja suma en transferencia_banco = 10.000', close.transferencia_banco === 10000);
ok('bre-b vieja + breb_nu suman en breb_nu = 12.000', close.breb_nu === 12000);
ok('cierre total = 62.000', Object.values(close).reduce((a, v) => a + v, 0) === 62000);

console.log('\nUn null cobra el resto, no el total (bug R9 de v1.1):');
const oneNull = resolvePayments([{ method: 'nequi', amount: 50000 }, { method: 'efectivo', amount: null }], 70000);
ok('efectivo sin monto = 20.000 (resto), no 70.000', oneNull[1].amount === 20000);

console.log('\nRechazos:');
throws('dos nulls se rechazan', () => resolvePayments([{ method: 'nequi', amount: null }, { method: 'efectivo', amount: null }], 70000));
throws('suma distinta al resto se rechaza', () => resolvePayments([{ method: 'nequi', amount: 40000 }], 70000));
throws('monto 0 se rechaza', () => resolvePayments([{ method: 'nequi', amount: 0 }, { method: 'efectivo', amount: 70000 }], 70000));
throws('monto negativo se rechaza', () => resolvePayments([{ method: 'nequi', amount: -5000 }, { method: 'efectivo', amount: 75000 }], 70000));
throws('método inventado se rechaza', () => resolvePayments([{ method: 'neqiu', amount: 70000 }], 70000));
ok('anticipo manual con método viejo "transferencia" se normaliza, no se rechaza', normalizePaymentMethod('transferencia') === 'transferencia_banco');
ok('resto 0 (anticipo cubre todo) no exige pago', resolvePayments([], 0).length === 0);

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
