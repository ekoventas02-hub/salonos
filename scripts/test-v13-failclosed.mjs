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
    async req(path, { method = 'GET', body = null } = {}) {
      const h = {};
      if (cookies.size) h.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body != null) h['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: body != null ? JSON.stringify(body) : undefined });
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
// Sin directorio de respaldos todavía, la lista es vacía (no el centinela VACIO).
const lsBackups = () => execSync(`ls ${process.env.TEST_PERSIST_DIR || '/tmp/salon13-persist'}/backups/ 2>/dev/null || true`, { encoding: 'utf8' }).trim().split('\n').filter((f) => f && f !== 'VACIO');

const admin = jar();
let r = await admin.req('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'SuperAdmin13Segura' } });
ok('login superadmin', r.status === 200, `${r.status}`);
// El test no es idempotente si una corrida anterior dejó el opt-in en true:
// se resetea antes de la sección H-M8.
r = await admin.req('/api/settings', { method: 'POST', body: { key: 'backup_allow_unencrypted', value: 'false' } });
ok('opt-in reseteado a false', r.status === 200, `${r.status}`);

console.log('\n== H-M8: sin clave y sin opt-in, el respaldo FALLA y no deja plano ==');
const before = lsBackups();
r = await admin.req('/api/system/backup', { method: 'POST' });
ok('respaldo sin clave -> 500', r.status === 500, `${r.status} ${r.text.slice(0, 150)}`);
const after = lsBackups();
ok('no se creó ningún archivo en plano', after.length === before.length && !after.some((f) => f.endsWith('.sql.gz') && !f.endsWith('.enc')), `antes:${before.length} después:${after.length}`);
r = await admin.req('/api/system/status');
const backupComp = (r.json?.components || []).find((c) => c.key === 'backup');
ok('lastBackup persistido ok:false', r.status === 200 && backupComp?.backup?.ok === false, JSON.stringify(backupComp?.backup));

console.log('\n== H-M8 opt-in: con backup_allow_unencrypted=true sí sale, pero en plano ==');
r = await admin.req('/api/settings', { method: 'POST', body: { key: 'backup_allow_unencrypted', value: 'true' } });
ok('opt-in guardado', r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 120)}`);
r = await admin.req('/api/system/backup', { method: 'POST' });
ok('respaldo con opt-in -> 200, encrypted:false', r.status === 200 && r.json?.ok && r.json?.encrypted === false, `${r.status} ${r.text.slice(0, 150)}`);
ok('archivo .sql.gz (plano) creado', r.json?.file?.endsWith('.sql.gz') && lsBackups().includes(r.json.file), String(r.json?.file));

console.log('\n== H-A2: duplicado viejo se renombra al arrancar ==');
// Duplicado insertado a mano (como si viniera de v1.2): mismo nombre, otro correo.
// El índice único impide insertar el duplicado: se quita (como si fuera v1.2,
// que no lo tenía), se inserta el duplicado y al arrancar la migración
// debe renombrarlo a 'María Pérez (2)' y recrear el índice.
// Salón propio del test (antes asumía salon_id=2 de otra suite) + una
// María Pérez, para que el duplicado tenga contra qué chocar.
r = await admin.req('/api/salons', { method: 'POST', body: { name: 'Salón Failclosed', slug: 'failclosed', phone: '3009998888', city: 'Bogotá' } });
const salonId = r.json?.id;
ok('salón del test creado', Boolean(salonId), `${r.status} ${r.text.slice(0, 100)}`);
await admin.req(`/api/salons/${salonId}/token`, { method: 'POST' });
r = await admin.req('/api/staff', { method: 'POST', body: { name: 'María Pérez', email: 'maria-fc@test.local', password: 'MariaFc13Xx', role: 'estilista', phone: '3001112224' } });
ok('María Pérez original creada', r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 100)}`);
sql(`DROP INDEX IF EXISTS idx_employees_salon_name_unique`);
sql(`INSERT INTO employees (salon_id, name, email, password, role, active, commission_pct) VALUES (${salonId}, 'María Pérez', 'maria-dup@test.local', '$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'estilista', true, 40)`);
console.log('duplicado insertado; reinicia el servidor CON clave y verifica el renombre');
console.log(`\nRESULTADO: ${pass} ✓ / ${fail} ✗`);
process.exit(fail ? 1 : 0);
