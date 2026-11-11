// Pruebas de SalonOS v1.3 con Postgres local (sin QR/Meta/Google/Wompi/PayU/DIAN reales).
// Solo para una base de pruebas desechable: crea el usuario y la DB antes de correrlo
// (ver README, sección v1.3) y levanta el servidor con las variables de entorno de prueba.
import { execSync } from 'child_process';

const BASE = 'http://127.0.0.1:3220';
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
const jar = () => {
  const cookies = new Map();
  return {
    async req(path, { method = 'GET', body = null, headers = {} } = {}) {
      const h = { ...headers };
      if (cookies.size) h.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body != null && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: body != null ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const mm = c.match(/^([^=]+)=([^;]*)/);
        if (mm) cookies.set(mm[1], mm[2]);
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* noop */ }
      return { status: res.status, json, text };
    },
  };
};
const TEST_DB = { host: process.env.TEST_DB_HOST || '127.0.0.1', user: process.env.TEST_DB_USER || 'salonos13', pass: process.env.TEST_DB_PASSWORD || 'test13pass', db: process.env.TEST_DB_NAME || 'salonos13_test' };
const sql = (q) => execSync(`PGPASSWORD=${TEST_DB.pass} psql -h ${TEST_DB.host} -U ${TEST_DB.user} -d ${TEST_DB.db} -t -A -c ${JSON.stringify(q)}`, { encoding: 'utf8' }).trim();
const today = new Date().toISOString().slice(0, 10);

const admin = jar();
const salon = jar();
let r = await admin.req('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'SuperAdmin13Segura' } });
ok('login superadmin', r.status === 200, `${r.status}`);
r = await salon.req('/api/auth/login', { method: 'POST', body: { email: 'admin@salon.local', password: 'AdminSalon14Y' } });
ok('login admin de salón', r.status === 200, `${r.status}`);

console.log('\n== POS: venta mixta Nequi + Llave Nu y cierre por método ==');
sql(`DELETE FROM salon_products WHERE salon_id=2 AND name='Shampoo V13'`);
sql(`INSERT INTO salon_products (salon_id, name, price, stock, active) VALUES (2, 'Shampoo V13', 80000, 10, true)`);
const prodId = Number(sql(`SELECT id FROM salon_products WHERE salon_id=2 AND name='Shampoo V13'`));
const closeBefore = await salon.req(`/api/salon/pos/cash-close?date=${today}`);
const nequiBefore = Number(closeBefore.json?.byMethod?.nequi || 0);
const nuBefore = Number(closeBefore.json?.byMethod?.breb_nu || 0);
r = await salon.req('/api/salon/pos/sale', { method: 'POST', body: { items: [{ productId: prodId, qty: 1 }], payments: [{ method: 'nequi', amount: 40000 }, { method: 'breb_nu', amount: 40000, reference: 'NU-123' }] } });
ok('venta mixta 201 (Nequi 40k + Nu 40k)', r.status === 201 && Number(r.json?.sale?.total) === 80000, `${r.status} ${r.text.slice(0, 200)}`);
ok('stock descontado (10 -> 9)', Number(sql(`SELECT stock FROM salon_products WHERE id=${prodId}`)) === 9, sql(`SELECT stock FROM salon_products WHERE id=${prodId}`));
r = await salon.req(`/api/salon/pos/cash-close?date=${today}`);
const byMethod = r.json?.byMethod || r.json?.methods || r.json;
const nequi = Number(byMethod?.nequi ?? byMethod?.NEQUI ?? NaN);
const nu = Number(byMethod?.breb_nu ?? NaN);
ok('cierre por método: Nequi +40000 y breb_nu +40000 vs antes', r.status === 200 && nequi === nequiBefore + 40000 && nu === nuBefore + 40000, `${r.status} nequi:${nequi} (antes ${nequiBefore}) breb_nu:${nu} (antes ${nuBefore})`);

console.log('\n== WA flush: sin WhatsApp, intento contado y error guardado ==');
sql(`INSERT INTO wa_queue (salon_id, phone, content, status) VALUES (2, '+573001234567', 'prueba flush', 'pendiente')`);
const qid = Number(sql(`SELECT id FROM wa_queue WHERE salon_id=2 AND content='prueba flush' ORDER BY id DESC LIMIT 1`));
r = await salon.req('/api/salon/wa/flush', { method: 'POST' });
ok('flush responde con conteo', r.status === 200 && typeof r.json?.total === 'number', `${r.status} ${r.text.slice(0, 200)}`);
ok('flush: 0 enviados, al menos 1 fallido', r.json?.sent === 0 && (r.json?.failed || 0) >= 1, JSON.stringify(r.json));
ok('intento contado (attempts=1) y error guardado', sql(`SELECT attempts FROM wa_queue WHERE id=${qid}`) === '1' && sql(`SELECT last_error IS NOT NULL FROM wa_queue WHERE id=${qid}`) === 't', `attempts=${sql(`SELECT attempts FROM wa_queue WHERE id=${qid}`)}`);
ok('sigue pendiente (no se pierde)', sql(`SELECT status FROM wa_queue WHERE id=${qid}`) === 'pendiente', sql(`SELECT status FROM wa_queue WHERE id=${qid}`));

console.log('\n== H-M11: cuota de subidas 413 ==');
r = await admin.req('/api/settings', { method: 'POST', body: { key: 'uploads_user_day_max_mb', value: '1' } });
ok('superadmin puede cambiar la cuota (isAdminRole)', r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 120)}`);
const big = Buffer.alloc(2 * 1024 * 1024, 0);
big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47; // firma PNG
const fd = new FormData();
fd.append('logo', new Blob([big], { type: 'image/png' }), 'logo.png');
r = await salon.req('/api/settings/logo', { method: 'POST', body: fd });
ok('logo de 2 MB con cuota de 1 MB/día -> 413', r.status === 413, `${r.status} ${r.text.slice(0, 150)}`);
r = await admin.req('/api/settings', { method: 'POST', body: { key: 'uploads_user_day_max_mb', value: '100' } });
ok('cuota restaurada a 100', r.status === 200, `${r.status}`);

console.log(`\nRESULTADO: ${pass} ✓ / ${fail} ✗`);
process.exit(fail ? 1 : 0);
