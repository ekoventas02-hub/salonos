// Pruebas v1.3 (añadido): anticipo OPCIONAL + disponibilidad por profesional.
// Solo para una base de pruebas desechable (Postgres local, sin QR/Meta/Google reales).
// Uso: levanta el servidor con las variables de entorno de prueba y corre:
//   node scripts/test-v13-deposito-disponibilidad.mjs
import { execSync } from 'child_process';

const BASE = 'http://127.0.0.1:3220';
const TEST_DB = { host: process.env.TEST_DB_HOST || '127.0.0.1', user: process.env.TEST_DB_USER || 'salonos13', pass: process.env.TEST_DB_PASSWORD || 'test13pass', db: process.env.TEST_DB_NAME || 'salonos13_test' };
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
const sql = (q) => execSync(`PGPASSWORD=${TEST_DB.pass} psql -h ${TEST_DB.host} -U ${TEST_DB.user} -d ${TEST_DB.db} -t -A -c ${JSON.stringify(q)}`, { encoding: 'utf8' }).trim();
// Hora actual de Bogotá (igual que el servidor).
function bogotaNow() {
  const parts = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, dow: new Date(`${get('year')}-${get('month')}-${get('day')}T12:00:00-05:00`).getDay(), min: Number(get('hour')) * 60 + Number(get('minute')) };
}
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const todayPlus = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
};

const admin = jar();
const salon = jar();
const recep = jar();
const now = bogotaNow();

console.log('== Preparación: salón + equipo ==');
let r = await admin.req('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'SuperAdmin13Segura' } });
ok('login superadmin', r.status === 200, `${r.status}`);
r = await admin.req('/api/salons', { method: 'POST', body: { name: 'Salón Depósito', slug: 'deposito', phone: '3001112222', city: 'Bogotá' } });
const salonId = r.json?.id || Number(sql(`SELECT id FROM salons WHERE slug='deposito'`));
ok('salón creado', Boolean(salonId), String(salonId));
r = await admin.req(`/api/salons/${salonId}/token`, { method: 'POST' });
const salonToken = r.json?.token;
r = await admin.req('/api/staff', { method: 'POST', headers: {}, body: { name: 'Admin Salón', email: 'admin@deposito.local', password: 'AdminSalon13X', role: 'admin', phone: '3002223333' } });
// (la creación con token de salón va por Bearer; el jar admin ya tiene la cookie del token)
r = await salon.req('/api/auth/login', { method: 'POST', body: { email: 'admin@deposito.local', password: 'AdminSalon13X' } });
ok('login admin de salón', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
// Una profesional con horario toda la semana, para que computeSlots tenga huecos.
r = await salon.req('/api/staff', { method: 'POST', body: { name: 'María Pérez', email: 'maria@deposito.local', password: 'MariaSalon13X', role: 'estilista', phone: '3001112223' } });
const mariaId = r.json?.id;
ok('profesional María creada', Boolean(mariaId), `${r.status} ${r.text.slice(0, 100)}`);
const allWeek = { '0': ['00:00', '23:59'], '1': ['00:00', '23:59'], '2': ['00:00', '23:59'], '3': ['00:00', '23:59'], '4': ['00:00', '23:59'], '5': ['00:00', '23:59'], '6': ['00:00', '23:59'] };
r = await salon.req(`/api/salon/professionals/${mariaId}/schedule`, { method: 'PUT', body: { schedule: allWeek } });
ok('horario de María (toda la semana) guardado', r.status === 200, `${r.status}`);

console.log('\n== 1. Anticipo opcional: servicio con 0 % ==');
r = await salon.req('/api/salon/catalog-services', { method: 'POST', body: { name: 'Corte Sin Anticipo', category: 'cabello', durationMinutes: 60, cleanupMinutes: 15, price: 60000, commissionPct: 40, depositPct: 0, teamSize: 1, requiresConsent: false, retouchDays: null } });
ok('crear servicio con depositPct 0 -> 201', r.status === 201, `${r.status} ${r.text.slice(0, 150)}`);
const svc0 = r.json?.id;
r = await salon.req('/api/salon/catalog-services', { method: 'POST', body: { name: 'Servicio Malo', category: 'cabello', durationMinutes: 60, price: 60000, depositPct: -1 } });
ok('depositPct -1 -> 400', r.status === 400, `${r.status}`);
r = await salon.req('/api/salon/catalog-services', { method: 'POST', body: { name: 'Servicio Malo 2', category: 'cabello', durationMinutes: 60, price: 60000, depositPct: 101 } });
ok('depositPct 101 -> 400', r.status === 400, `${r.status}`);
r = await salon.req(`/api/salon/catalog-services/${svc0}`, { method: 'PUT', body: { depositPct: 150 } });
ok('PUT depositPct 150 -> 400', r.status === 400, `${r.status}`);
r = await salon.req('/api/salon/appointments', { method: 'POST', body: { serviceId: svc0, professionalId: mariaId, clientName: 'Ana Cero', clientPhone: '3001234567', date: todayPlus(1), startTime: '10:00' } });
ok('cita interna con anticipo 0 -> 201 confirmada', r.status === 201 && r.json?.[0]?.status === 'confirmada', `${r.status} ${r.text.slice(0, 200)}`);
const appt0 = r.json?.[0]?.id;
ok('cita 0 %: deposit_amount 0 y política "Sin anticipo"', Number(sql(`SELECT deposit_amount FROM appointments WHERE id=${appt0}`)) === 0 && sql(`SELECT policy_text FROM appointments WHERE id=${appt0}`).startsWith('Sin anticipo'), sql(`SELECT policy_text FROM appointments WHERE id=${appt0}`).slice(0, 60));
r = await salon.req(`/api/salon/appointments/${appt0}/deposit-link`, { method: 'POST', body: { provider: 'wompi' } });
ok('deposit-link con anticipo 0 -> 400 (no hay link de $0)', r.status === 400, `${r.status} ${r.text.slice(0, 120)}`);
r = await salon.req(`/api/salon/appointments/${appt0}/deposit`, { method: 'POST', body: { method: 'nequi' } });
ok('anticipo manual con anticipo 0 -> 400', r.status === 400, `${r.status} ${r.text.slice(0, 120)}`);
const pub = jar();
r = await pub.req('/api/public/reserva/deposito', { method: 'POST', body: { serviceId: svc0, clientName: 'Clienta Web Cero', clientPhone: '3007778888', date: todayPlus(2), startTime: '11:00', acceptPolicy: true } });
ok('reserva pública con anticipo 0 -> 201 confirmada', r.status === 201 && r.json?.appointments?.[0]?.status === 'confirmada' && r.json?.deposit?.amount === 0, `${r.status} ${r.text.slice(0, 200)}`);
ok('reserva pública 0 %: nota dice confirmada sin anticipo', (r.json?.note || '').includes('no requiere anticipo'), String(r.json?.note));
ok('reserva pública 0 %: policy dice "Sin anticipo"', (r.json?.policy || '').startsWith('Sin anticipo'), String(r.json?.policy).slice(0, 60));

console.log('\n== 2. Anticipo por defecto del salón (Ajustes) ==');
r = await salon.req('/api/salons/me');
ok('GET /api/salons/me trae default_deposit_pct 20', r.status === 200 && Number(r.json?.default_deposit_pct) === 20, `${r.status} ${r.text.slice(0, 120)}`);
r = await salon.req('/api/salons/me/settings', { method: 'PUT', body: { default_deposit_pct: -5 } });
ok('default -5 -> 400', r.status === 400, `${r.status}`);
r = await salon.req('/api/salons/me/settings', { method: 'PUT', body: { default_deposit_pct: 101 } });
ok('default 101 -> 400', r.status === 400, `${r.status}`);
r = await salon.req('/api/salons/me/settings', { method: 'PUT', body: { default_deposit_pct: 0 } });
ok('default 0 guardado', r.status === 200 && Number(r.json?.default_deposit_pct) === 0, `${r.status} ${r.text.slice(0, 120)}`);
// Servicio con deposit_pct NULL en DB (el POST pone 20 por defecto; se simula el
// servicio viejo sin % con SQL) -> con default 0, la cita confirma sin pago.
sql(`INSERT INTO salon_services (salon_id, name, category, duration_minutes, cleanup_minutes, price, commission_pct, deposit_pct, team_size, active) VALUES (${salonId}, 'Servicio Viejo Sin Pct', 'cabello', 60, 15, 50000, 40, NULL, 1, true)`);
const svcNull = Number(sql(`SELECT id FROM salon_services WHERE salon_id=${salonId} AND name='Servicio Viejo Sin Pct'`));
r = await salon.req('/api/salon/appointments', { method: 'POST', body: { serviceId: svcNull, professionalId: mariaId, clientName: 'Ana Nula', clientPhone: '3001234568', date: todayPlus(1), startTime: '12:00' } });
ok('servicio sin % + default 0 -> confirmada', r.status === 201 && r.json?.[0]?.status === 'confirmada', `${r.status} ${r.text.slice(0, 150)}`);
// Y con default 20, el mismo servicio pide anticipo y queda pendiente.
r = await salon.req('/api/salons/me/settings', { method: 'PUT', body: { default_deposit_pct: 20 } });
ok('default 20 restaurado', r.status === 200, `${r.status}`);
r = await salon.req('/api/salon/appointments', { method: 'POST', body: { serviceId: svcNull, professionalId: mariaId, clientName: 'Ana Veinte', clientPhone: '3001234569', date: todayPlus(1), startTime: '13:30' } });
ok('servicio sin % + default 20 -> pendiente con anticipo $10.000', r.status === 201 && r.json?.[0]?.status === 'pendiente' && Number(r.json?.[0]?.depositAmount) === 10000, `${r.status} ${r.text.slice(0, 200)}`);
// Servicio con 0 % manda sobre el default 20.
r = await salon.req('/api/salon/appointments', { method: 'POST', body: { serviceId: svc0, professionalId: mariaId, clientName: 'Ana Cero 2', clientPhone: '3001234570', date: todayPlus(1), startTime: '15:00' } });
ok('servicio 0 % + default 20 -> confirmada (manda el servicio)', r.status === 201 && r.json?.[0]?.status === 'confirmada', `${r.status} ${r.text.slice(0, 150)}`);
// Recepcionista no puede cambiar los ajustes.
r = await salon.req('/api/staff', { method: 'POST', body: { name: 'Recep', email: 'recep@deposito.local', password: 'RecepSalon13X', role: 'recepcionista', phone: '3004445555' } });
r = await recep.req('/api/auth/login', { method: 'POST', body: { email: 'recep@deposito.local', password: 'RecepSalon13X' } });
ok('login recepcionista', r.status === 200, `${r.status}`);
r = await recep.req('/api/salons/me/settings', { method: 'PUT', body: { default_deposit_pct: 0 } });
ok('recepcionista no cambia ajustes (403)', r.status === 403, `${r.status}`);

console.log('\n== 3. Disponibilidad por profesional ==');
// Profesionales con horario y servicios.
const mkPro = async (name, email) => {
  const x = await salon.req('/api/staff', { method: 'POST', body: { name, email, password: 'ProSalon13Xx', role: 'estilista', phone: '3005556666' } });
  return x.json?.id;
};
const anaId = await mkPro('Ana Ocupada', 'ana@deposito.local');
const luzId = await mkPro('Luz Libre', 'luz@deposito.local');
const carmenId = await mkPro('Carmen Tarde', 'carmen@deposito.local');
const dianaId = await mkPro('Diana Sin Horario', 'diana@deposito.local');
ok('4 profesionales creadas', [anaId, luzId, carmenId, dianaId].every(Boolean), [anaId, luzId, carmenId, dianaId].join(','));
const dow = String(now.dow);
const dowTomorrow = String((now.dow + 1) % 7);
// Ana: horario todo el día + cita que cubre "ahora" (empieza 30 min antes, termina 30 min después).
r = await salon.req(`/api/salon/professionals/${anaId}/schedule`, { method: 'PUT', body: { schedule: { [dow]: ['00:00', '23:59'], [dowTomorrow]: ['00:00', '23:59'] } } });
ok('horario de Ana guardado (todo el día)', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);
const startNow = hm(Math.max(0, now.min - 30));
const endNow = hm(Math.min(1439, now.min + 30));
r = await salon.req('/api/salon/appointments', { method: 'POST', body: { serviceId: svc0, professionalId: anaId, clientName: 'Clienta Ahora', clientPhone: '3001234571', date: now.date, startTime: startNow } });
ok('cita de Ana cubriendo "ahora"', r.status === 201, `${r.status} ${r.text.slice(0, 150)}`);
const anaEnd = r.json?.[0]?.endTime;
// Luz: horario todo el día, sin citas.
r = await salon.req(`/api/salon/professionals/${luzId}/schedule`, { method: 'PUT', body: { schedule: { [dow]: ['00:00', '23:59'], [dowTomorrow]: ['00:00', '23:59'] } } });
ok('horario de Luz guardado', r.status === 200, `${r.status}`);
// Carmen: horario ya terminado hoy (hace 4 h a hace 2 h; si es muy temprano, 00:00-00:01).
const carmenEnd = now.min >= 180 ? hm(now.min - 120) : '00:01';
const carmenStart = now.min >= 180 ? hm(now.min - 240) : '00:00';
r = await salon.req(`/api/salon/professionals/${carmenId}/schedule`, { method: 'PUT', body: { schedule: { [dow]: [carmenStart, carmenEnd] } } });
ok('horario de Carmen guardado (ya terminó)', r.status === 200, `${r.status}`);
// Diana: sin horario hoy — el día se guarda con horas vacías (["",""]) para que
// scheduleForDay no aplique el horario por defecto Lun-Sáb 09:00-19:00.
r = await salon.req(`/api/salon/professionals/${dianaId}/schedule`, { method: 'PUT', body: { schedule: { [dow]: ['', ''] } } });
ok('horario de Diana vaciado hoy', r.status === 200, `${r.status}`);
r = await salon.req('/api/salon/professionals/availability');
ok('GET availability 200', r.status === 200 && Array.isArray(r.json?.professionals), `${r.status} ${r.text.slice(0, 150)}`);
const byName = (n) => (r.json?.professionals || []).find((p) => p.name === n);
const ana = byName('Ana Ocupada');
const luz = byName('Luz Libre');
const carmen = byName('Carmen Tarde');
const diana = byName('Diana Sin Horario');
ok('Ana: Ocupada hasta las ' + anaEnd, ana?.status === 'ocupada' && ana?.busyUntil === anaEnd && ana?.label === `Ocupada hasta las ${anaEnd}`, JSON.stringify(ana));
ok('Luz: Disponible ahora', luz?.status === 'disponible' && luz?.label === 'Disponible ahora', JSON.stringify(luz));
ok('Carmen: Fuera de horario', carmen?.status === 'fuera_horario' && carmen?.label?.startsWith('Fuera de horario'), JSON.stringify(carmen));
ok('Diana: Sin horario definido (no se inventa)', diana?.status === 'sin_horario' && diana?.label === 'Sin horario definido', JSON.stringify(diana));
ok('fecha y hora de Bogotá en la respuesta', r.json?.date === now.date && typeof r.json?.now === 'string', `${r.json?.date} vs ${now.date}, now=${r.json?.now}`);
// Recepcionista también ve la disponibilidad; sin token 401.
r = await recep.req('/api/salon/professionals/availability');
ok('recepcionista ve disponibilidad', r.status === 200, `${r.status}`);
const anon = jar();
r = await anon.req('/api/salon/professionals/availability');
ok('sin token 401', r.status === 401, `${r.status}`);

console.log('\n== 4. Huecos libres: sin cruces, automáticos ==');
// Luz mañana 10:00-11:00 ocupada -> el hueco 10:00 no se ofrece, el 11:15 sí.
r = await salon.req('/api/salon/appointments', { method: 'POST', body: { serviceId: svc0, professionalId: luzId, clientName: 'Clienta Mañana', clientPhone: '3001234572', date: todayPlus(1), startTime: '10:00' } });
ok('cita de Luz mañana 10:00', r.status === 201, `${r.status} ${r.text.slice(0, 150)}`);
r = await pub.req(`/api/public/reserva/deposito/slots?serviceId=${svc0}&professionalId=${luzId}&date=${todayPlus(1)}`);
const starts = (r.json || []).map((s) => s.start);
ok('hueco 10:00 ocupado NO se ofrece', r.status === 200 && !starts.includes('10:00'), `huecos: ${starts.slice(0, 8).join(',')}`);
ok('hueco 11:15 libre SÍ se ofrece (60 min + 15 limpieza)', starts.includes('11:15'), `huecos: ${starts.slice(0, 12).join(',')}`);
// Asignación de servicio a profesional: el servicio solo lo hace Ana.
r = await salon.req('/api/salon/catalog-services', { method: 'POST', body: { name: 'Solo Ana', category: 'cabello', durationMinutes: 60, cleanupMinutes: 15, price: 70000, commissionPct: 40, depositPct: 0, teamSize: 1, requiresConsent: false, retouchDays: null, professionalIds: [anaId] } });
ok('servicio con professionalIds [Ana] -> 201', r.status === 201, `${r.status} ${r.text.slice(0, 120)}`);
const svcAna = r.json?.id;
r = await salon.req('/api/salon/catalog-services');
const row = (r.json || []).find((x) => x.id === svcAna);
ok('GET catálogo trae professionalIds', Array.isArray(row?.professionalIds) && row.professionalIds.includes(anaId), JSON.stringify(row?.professionalIds));
r = await pub.req(`/api/public/reserva/deposito/slots?serviceId=${svcAna}&date=${todayPlus(1)}`);
const names = [...new Set((r.json || []).flatMap((s) => (s.professionals || []).map((p) => p.name).concat(s.professionalName || [])))];
ok('huecos del servicio "Solo Ana" solo con Ana', r.status === 200 && names.length === 1 && names[0] === 'Ana Ocupada', `profesionales: ${names.join(',')}`);
// La reserva pública muestra el default del salón (20 %) cuando el servicio no fija %.
r = await pub.req('/api/public/reserva/deposito');
ok('GET pública trae default_deposit_pct 20', r.status === 200 && Number(r.json?.salon?.default_deposit_pct) === 20, JSON.stringify(r.json?.salon?.default_deposit_pct));

console.log(`\nRESULTADO: ${pass} ✓ / ${fail} ✗`);
process.exit(fail ? 1 : 0);
