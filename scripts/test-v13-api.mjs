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

// Cliente HTTP con jar de cookies simple (una sesión por jar).
function jar() {
  const cookies = new Map();
  return {
    async req(path, { method = 'GET', body = null, headers = {} } = {}) {
      const h = { ...headers };
      if (cookies.size) h.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body != null) h['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: body != null ? JSON.stringify(body) : undefined });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        for (const part of setCookie.split(/,(?=[^;]+=[^;]+;)/)) {
          const m = part.trim().match(/^([^=]+)=([^;]*)/);
          if (m) {
            if (part.includes('Max-Age=0') || part.toLowerCase().includes('expires=thu, 01 jan 1970')) cookies.delete(m[1]);
            else cookies.set(m[1], m[2]);
          }
        }
        // set-cookie puede venir como varias cabeceras unidas; el split de arriba es aproximado.
        const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        for (const c of raw) {
          const mm = c.match(/^([^=]+)=([^;]*)/);
          if (mm) cookies.set(mm[1], mm[2]);
        }
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* no json */ }
      return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') || '', setCookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
    },
    cookies,
  };
}
const TEST_DB = { host: process.env.TEST_DB_HOST || '127.0.0.1', user: process.env.TEST_DB_USER || 'salonos13', pass: process.env.TEST_DB_PASSWORD || 'test13pass', db: process.env.TEST_DB_NAME || 'salonos13_test' };
const sql = (q) => {
  const out = execSync(`PGPASSWORD=${TEST_DB.pass} psql -h ${TEST_DB.host} -U ${TEST_DB.user} -d ${TEST_DB.db} -t -A -c ${JSON.stringify(q)}`, { encoding: 'utf8' });
  return out.trim();
};
const todayPlus = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
};

const admin = jar();      // superadmin
const salon = jar();      // admin del salón
const recep = jar();      // recepcionista

console.log('\n== 1. Salud y arranque ==');
let r = await admin.req('/api/health');
ok('health 200 versión 1.3.0 sin detalle para anónimo', r.status === 200 && r.json?.version === '1.3.0' && r.json?.db === undefined, JSON.stringify(r.json));

console.log('\n== 2. Login con cookie HttpOnly ==');
r = await admin.req('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'SuperAdmin13Segura' } });
ok('login superadmin 200', r.status === 200 && r.json?.success, JSON.stringify(r.json));
ok('Set-Cookie salon_token HttpOnly', (r.setCookies || []).some((c) => /^salon_token=/.test(c) && /HttpOnly/i.test(c)), (r.setCookies || []).join(' | ').replace(/salon_token=[^;]+/, 'salon_token=<token>'));
r = await admin.req('/api/auth/me');
ok('/api/auth/me con solo cookie -> superadmin', r.status === 200 && r.json?.user?.role === 'superadmin', JSON.stringify(r.json));
r = await admin.req('/api/health');
ok('health con admin muestra detalle (db + whatsapp)', r.status === 200 && r.json?.db === true && r.json?.whatsapp !== undefined, JSON.stringify(r.json));

console.log('\n== 3. Fuerza bruta: 5 fallos -> 429 ==');
const victim = jar();
let statuses = [];
for (let i = 0; i < 6; i++) {
  const x = await victim.req('/api/auth/login', { method: 'POST', body: { email: 'victima@test.local', password: 'mala' } });
  statuses.push(x.status);
}
ok('5 fallos con mismo correo+IP terminan en 429', statuses.slice(0, 5).includes(429) && statuses[5] === 429, statuses.join(','));

console.log('\n== 4. Salón + token de salón + exit ==');
r = await admin.req('/api/salons', { method: 'POST', body: { name: 'Salón Prueba', slug: 'prueba', phone: '3001112222', city: 'Bogotá' } });
ok('crear salón', r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
const salonId = r.json?.id || Number(sql(`SELECT id FROM salons WHERE slug='prueba'`));
ok('salonId obtenido', Boolean(salonId), String(salonId));
r = await admin.req(`/api/salons/${salonId}/token`, { method: 'POST' });
ok('token de salón 200', r.status === 200 && r.json?.token, `${r.status} ${r.text.slice(0, 150)}`);
ok('token de salón en cookie', (r.setCookies || []).some((c) => /^salon_token=/.test(c)), '');
const salonToken = r.json?.token;
// El admin del salón se crea con el token de salón (Bearer).
r = await admin.req('/api/staff', { method: 'POST', headers: { Authorization: `Bearer ${salonToken}` }, body: { name: 'Admin Salón', email: 'admin@salon.local', password: 'AdminSalon13X', role: 'admin', phone: '3002223333' } });
ok('crear admin de salón con token de salón', r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 200)}`);
// Login como admin del salón (cookie).
r = await salon.req('/api/auth/login', { method: 'POST', body: { email: 'admin@salon.local', password: 'AdminSalon13X' } });
ok('login admin de salón', r.status === 200 && r.json?.user?.salonId === salonId, JSON.stringify(r.json));
// Exit: volver a superadmin con la cookie guardada.
r = await admin.req('/api/salons/exit', { method: 'POST' });
ok('exit vuelve a superadmin', r.status === 200 && r.json?.user?.role === 'superadmin', `${r.status} ${r.text.slice(0, 150)}`);
r = await admin.req('/api/auth/me');
ok('tras exit, /api/auth/me es superadmin', r.status === 200 && r.json?.user?.role === 'superadmin', JSON.stringify(r.json));

console.log('\n== 5. Staff: nombre único, sin clave débil, email duplicado ==');
r = await salon.req('/api/staff', { method: 'POST', body: { name: 'María Pérez', email: 'maria@salon.local', password: 'MariaSalon13X', role: 'estilista', phone: '3003334444' } });
ok('crear profesional María Pérez', r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 150)}`);
const mariaId = r.json?.id;
r = await salon.req('/api/staff', { method: 'POST', body: { name: 'María Pérez', email: 'maria2@salon.local', password: 'MariaSalon13X', role: 'estilista', phone: '3003334445' } });
ok('nombre duplicado en el salón -> 400', r.status === 400, `${r.status} ${r.text.slice(0, 150)}`);
r = await salon.req('/api/staff', { method: 'POST', body: { name: 'Laura', email: 'laura@salon.local', password: '12345678', role: 'estilista', phone: '3003334446' } });
ok('clave débil -> 400', r.status === 400, `${r.status} ${r.text.slice(0, 150)}`);
r = await salon.req('/api/staff', { method: 'POST', body: { name: 'Laura Gómez', email: 'laura@salon.local', password: 'LauraSalon13X', role: 'estilista', phone: '3003334446' } });
ok('crear Laura Gómez', r.status === 200, `${r.status} ${r.text.slice(0, 150)}`);
const lauraId = r.json?.id;
r = await salon.req(`/api/staff/${lauraId}`, { method: 'PUT', body: { name: 'Laura Gómez', email: 'maria@salon.local', role: 'estilista', phone: '3003334446', active: true, commissionPct: 0, parentId: null } });
ok('PUT con email de otra empleada -> 400', r.status === 400, `${r.status} ${r.text.slice(0, 150)}`);
r = await salon.req(`/api/staff/${lauraId}`, { method: 'PUT', body: { name: 'María Pérez', email: 'laura@salon.local', role: 'estilista', phone: '3003334446', active: true, commissionPct: 0, parentId: null } });
ok('PUT con nombre duplicado -> 400', r.status === 400, `${r.status} ${r.text.slice(0, 150)}`);

console.log('\n== 6. Servicio + cita (Google sin credenciales no rompe) ==');
r = await salon.req('/api/salon/catalog-services', { method: 'POST', body: { name: 'Tinte V13', category: 'cabello', durationMinutes: 60, cleanupMinutes: 15, price: 80000, commissionPct: 40, depositPct: 20, teamSize: 1, requiresConsent: false, retouchDays: 21 } });
ok('crear servicio Tinte V13 con retouchDays 21', r.status === 201, `${r.status} ${r.text.slice(0, 150)}`);
const serviceId = r.json?.id;
r = await salon.req('/api/salon/catalog-services');
ok('GET catálogo trae retouchDays 21', r.status === 200 && Array.isArray(r.json) && r.json.find((x) => x.id === serviceId)?.retouchDays === 21, JSON.stringify(r.json)?.slice(0, 200));
r = await salon.req('/api/salon/calendar/status');
ok('Google Calendar status: sin configurar, sin romper', r.status === 200 && r.json?.configured === false, JSON.stringify(r.json));
r = await salon.req('/api/salon/calendar/test', { method: 'POST' });
ok('Google Calendar test -> ok:false con motivo', r.status === 200 && r.json?.ok === false, JSON.stringify(r.json));
r = await salon.req('/api/salon/appointments', { method: 'POST', body: { serviceId, clientName: 'Ana Torres', clientPhone: '3001234567', date: todayPlus(1), startTime: '10:00' } });
ok('crear cita 201 (ruta interna)', r.status === 201 && Array.isArray(r.json) && r.json.length === 1, `${r.status} ${r.text.slice(0, 200)}`);
const apptId = r.json?.[0]?.id;
ok('cita sin evento de Google (sin credenciales)', sql(`SELECT google_calendar_event_id FROM appointments WHERE id=${apptId}`) === '', sql(`SELECT google_calendar_event_id FROM appointments WHERE id=${apptId}`));
r = await salon.req(`/api/salon/appointments/${apptId}`, { method: 'PATCH', body: { date: todayPlus(2), startTime: '11:00' } });
ok('reprogramar cita 200', r.status === 200, `${r.status} ${r.text.slice(0, 150)}`);
// Reserva PÚBLICA (sin sesión): la otra ruta con el INSERT roto en v1.2.
const pub = jar();
r = await pub.req('/api/public/reserva/prueba', { method: 'POST', body: { serviceId, clientName: 'Clienta Web', clientPhone: '3007778888', date: todayPlus(3), startTime: '15:00', acceptPolicy: true } });
ok('reserva pública 201 (ruta /api/public/reserva)', r.status === 201 && r.json?.success && Array.isArray(r.json?.appointments) && r.json.appointments.length === 1, `${r.status} ${r.text.slice(0, 200)}`);
ok('reserva pública queda en pendiente con anticipo', r.json?.appointments?.[0]?.status === 'pendiente' && typeof r.json?.deposit?.pct === 'number', JSON.stringify(r.json?.deposit));
r = await salon.req(`/api/salon/appointments/${apptId}/sync-calendar`, { method: 'POST' });
ok('sync manual de cita -> ok:false sin credenciales', r.status === 200 && r.json?.ok === false, JSON.stringify(r.json));
r = await salon.req(`/api/salon/appointments/${apptId}/cancel`, { method: 'POST', body: { reason: 'prueba' } });
ok('cancelar cita 200', r.status === 200 && r.json?.appointment?.status === 'cancelada', `${r.status} ${r.text.slice(0, 200)}`);

console.log('\n== 7. Chat: tope 50, paginación, marcar leído, estado de envío ==');
sql(`INSERT INTO conversations (id, client_phone, client_name, source, status, last_message, last_message_time, unread_count, channel, salon_id) VALUES ('wa_573001234567', '+573001234567', 'Ana Torres', 'WhatsApp Directo', 'open', 'mensaje 60', NOW(), 5, 'qr', ${salonId}) ON CONFLICT (id) DO UPDATE SET unread_count=5`);
for (let i = 1; i <= 60; i++) {
  sql(`INSERT INTO messages (conversation_id, sender, type, content, timestamp, status) VALUES ('wa_573001234567', '${i % 2 ? 'client' : 'agent'}', 'text', 'mensaje ${i}', NOW() - INTERVAL '${61 - i} minutes', '${i % 2 ? 'recibido' : 'enviado'}')`);
}
r = await salon.req('/api/chats');
const conv = (r.json || []).find((c) => c.id === 'wa_573001234567');
ok('GET /api/chats trae la conversación', Boolean(conv), `chats: ${(r.json || []).length}`);
ok('tope de 50 mensajes por conversación', conv?.messages?.length === 50, `mensajes: ${conv?.messages?.length}`);
ok('hasMoreMessages true + lastMessageId', conv?.hasMoreMessages === true && Boolean(conv?.lastMessageId), JSON.stringify({ hm: conv?.hasMoreMessages, last: conv?.lastMessageId }));
const firstShown = conv.messages[0].id;
r = await salon.req(`/api/chats/wa_573001234567/messages?before=${firstShown}&limit=50`);
ok('paginación: 10 anteriores con before', r.status === 200 && r.json?.data?.length === 10 && r.json?.hasMore === false, `${r.status} data:${r.json?.data?.length} hasMore:${r.json?.hasMore}`);
r = await salon.req('/api/chats/wa_573001234567/read', { method: 'POST' });
ok('marcar leída 200', r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 100)}`);
ok('unread_count en 0 en DB', sql(`SELECT unread_count FROM conversations WHERE id='wa_573001234567'`) === '0', sql(`SELECT unread_count FROM conversations WHERE id='wa_573001234567'`));
r = await salon.req('/api/chats/wa_573001234567/messages', { method: 'POST', body: { content: 'Hola Ana, prueba de envío', type: 'text' } });
ok('envío sin WhatsApp listo -> sent:false, sin_confirmar', r.status === 200 && r.json?.sent === false && r.json?.status === 'sin_confirmar', `${r.status} ${r.text.slice(0, 200)}`);
const sentId = r.json?.messageId;
ok('mensaje guardado con status sin_confirmar en DB', sql(`SELECT status FROM messages WHERE id=${sentId}`) === 'sin_confirmar', sql(`SELECT status FROM messages WHERE id=${sentId}`));
// El reintento de un envío FALLIDO sí se vuelve a intentar (no es duplicado).
r = await salon.req('/api/chats/wa_573001234567/messages', { method: 'POST', body: { content: 'Hola Ana, prueba de envío', type: 'text' } });
ok('reintento de un envío fallido se vuelve a intentar (sent:false, no duplicate)', r.status === 200 && r.json?.sent === false && r.json?.duplicate !== true, `${r.status} ${r.text.slice(0, 150)}`);
// Pero si el mismo mensaje YA salió (estado enviado), no se manda dos veces.
sql(`INSERT INTO messages (conversation_id, sender, type, content, timestamp, status) VALUES ('wa_573001234567', 'agent', 'text', 'Hola Ana, ya salió', NOW(), 'enviado')`);
const countBefore = Number(sql(`SELECT COUNT(*) FROM messages WHERE conversation_id='wa_573001234567' AND content='Hola Ana, ya salió'`));
r = await salon.req('/api/chats/wa_573001234567/messages', { method: 'POST', body: { content: 'Hola Ana, ya salió', type: 'text' } });
const countAfter = Number(sql(`SELECT COUNT(*) FROM messages WHERE conversation_id='wa_573001234567' AND content='Hola Ana, ya salió'`));
ok('mensaje ya enviado -> duplicate:true y no crea otra fila', r.status === 200 && r.json?.duplicate === true && countAfter === countBefore, `${r.status} ${r.text.slice(0, 150)} filas:${countBefore}->${countAfter}`);

console.log('\n== 8. Limitador por usuario (settings 30/15 min) ==');
let got429 = false;
for (let i = 0; i < 32; i++) {
  const x = await salon.req('/api/settings', { method: 'POST', body: { key: 'daily_capacity', value: '15' } });
  if (x.status === 429) { got429 = true; break; }
}
ok('POST /api/settings 31 veces -> 429 (límite por usuario)', got429, 'nunca llegó a 429 en 32 intentos');

console.log('\n== 9. Revocación: cambio de clave mata la sesión vieja ==');
const oldCookie = salon.cookies.get('salon_token');
r = await salon.req('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'AdminSalon13X', newPassword: 'AdminSalon14Y' } });
ok('cambio de clave 200', r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 150)}`);
const oldSalon = jar();
oldSalon.cookies.set('salon_token', oldCookie);
r = await oldSalon.req('/api/auth/me');
ok('token viejo tras cambio de clave -> 401 (revocado)', r.status === 401, `${r.status}`);
r = await salon.req('/api/auth/login', { method: 'POST', body: { email: 'admin@salon.local', password: 'AdminSalon13X' } });
ok('clave vieja ya no entra (401)', r.status === 401, `${r.status}`);
r = await salon.req('/api/auth/login', { method: 'POST', body: { email: 'admin@salon.local', password: 'AdminSalon14Y' } });
ok('clave nueva entra', r.status === 200, `${r.status}`);

console.log('\n== 10. Settings: sin secretos para no-admin ==');
r = await admin.req('/api/settings', { method: 'POST', body: { key: `salon_${salonId}_google_refresh_token`, value: 'secreto-de-prueba' } });
ok('superadmin guarda clave Google por salón', r.status === 200 && r.json?.success, `${r.status} ${r.text.slice(0, 150)}`);
r = await salon.req('/api/settings');
ok('admin del salón sí ve su clave Google', r.status === 200 && JSON.stringify(r.json || {}).includes('secreto-de-prueba'), JSON.stringify(r.json || {}).slice(0, 150));
r = await salon.req('/api/staff', { method: 'POST', body: { name: 'Recep', email: 'recep@salon.local', password: 'RecepSalon13X', role: 'recepcionista', phone: '3004445555' } });
ok('crear recepcionista', r.status === 200, `${r.status}`);
r = await recep.req('/api/auth/login', { method: 'POST', body: { email: 'recep@salon.local', password: 'RecepSalon13X' } });
ok('login recepcionista', r.status === 200, `${r.status}`);
r = await recep.req('/api/settings');
const settingsText = JSON.stringify(r.json || {});
ok('GET /api/settings como recepcionista NO trae refresh token de Google', r.status === 200 && !settingsText.includes('secreto-de-prueba') && !settingsText.includes('google_refresh_token'), settingsText.slice(0, 200));

console.log('\n== 11. Deletes con rol y 404 ==');
sql(`INSERT INTO leads (client_name, client_phone, status, salon_id) VALUES ('Prospecto Prueba', '+573009998877', 'new', ${salonId})`);
const leadId = Number(sql(`SELECT id FROM leads WHERE client_phone='+573009998877' ORDER BY id DESC LIMIT 1`));
r = await recep.req(`/api/leads/${leadId}`, { method: 'DELETE' });
ok('recepcionista NO borra leads (403)', r.status === 403, `${r.status}`);
r = await salon.req(`/api/leads/${leadId}`, { method: 'DELETE' });
ok('admin borra lead (200)', r.status === 200, `${r.status} ${r.text.slice(0, 100)}`);
r = await salon.req(`/api/leads/${leadId}`, { method: 'DELETE' });
ok('borrar de nuevo -> 404', r.status === 404, `${r.status}`);
sql(`INSERT INTO templates (title, content) VALUES ('Plantilla Prueba', 'Hola')`);
const tplId = Number(sql(`SELECT id FROM templates WHERE title='Plantilla Prueba'`));
r = await recep.req(`/api/templates/${tplId}`, { method: 'DELETE' });
ok('recepcionista NO borra plantillas (403)', r.status === 403, `${r.status}`);
r = await salon.req(`/api/templates/${tplId}`, { method: 'DELETE' });
ok('admin borra plantilla (200)', r.status === 200, `${r.status}`);

console.log('\n== 12. Factura: already_exists con alcance ==');
sql(`INSERT INTO services (id, date, time, client_name, client_phone, total_value, advances, deal_status, salon_id) VALUES ('svc-test-1', CURRENT_DATE, '10:00', 'Ana Torres', '+573001234567', 80000, 0, 'REALIZADO', ${salonId}) ON CONFLICT (id) DO NOTHING`);
r = await salon.req('/api/invoices', { method: 'POST', body: { service_id: 'svc-test-1' } });
ok('crear factura 201', (r.status === 200 || r.status === 201) && r.json?.number, `${r.status} ${r.text.slice(0, 200)}`);
r = await salon.req('/api/invoices', { method: 'POST', body: { service_id: 'svc-test-1' } });
ok('segunda factura mismo servicio -> already_exists', r.status === 200 && r.json?.already_exists === true, `${r.status} ${r.text.slice(0, 200)}`);

console.log('\n== 13. Retoques e inactivas ==');
sql(`INSERT INTO appointments (salon_id, group_id, service_id, service_name, professional_id, professional_ids, professional_name, client_phone, client_name, date, start_time, end_time, duration_minutes, status, price) VALUES (${salonId}, 'grp_test_1', ${serviceId}, 'Tinte V13', ${mariaId}, ARRAY[${mariaId}], 'María Pérez', '+573001234567', 'Ana Torres', CURRENT_DATE - INTERVAL '25 days', '10:00', '11:00', 60, 'completada', 80000)`);
const retouchAppt = Number(sql(`SELECT id FROM appointments WHERE group_id='grp_test_1'`));
r = await salon.req('/api/salon/retouches/due');
ok('retoque pendiente listado (25 días > ciclo 21)', r.status === 200 && Array.isArray(r.json) && r.json.some((x) => x.id === retouchAppt), `${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
r = await salon.req(`/api/salon/retouches/${retouchAppt}/send`, { method: 'POST' });
ok('enviar retoque sin WhatsApp -> 502 y no marca enviado', r.status === 502, `${r.status} ${r.text.slice(0, 150)}`);
ok('reminded_retouch_at sigue null', sql(`SELECT reminded_retouch_at FROM appointments WHERE id=${retouchAppt}`) === '', sql(`SELECT reminded_retouch_at FROM appointments WHERE id=${retouchAppt}`));
sql(`INSERT INTO salon_clients (salon_id, phone, name) VALUES (${salonId}, '+573005556677', 'Clienta Inactiva') ON CONFLICT DO NOTHING`);
sql(`INSERT INTO appointments (salon_id, group_id, service_id, service_name, professional_id, professional_ids, professional_name, client_phone, client_name, date, start_time, end_time, duration_minutes, status, price) VALUES (${salonId}, 'grp_test_2', ${serviceId}, 'Tinte V13', ${mariaId}, ARRAY[${mariaId}], 'María Pérez', '+573005556677', 'Clienta Inactiva', CURRENT_DATE - INTERVAL '60 days', '10:00', '11:00', 60, 'completada', 80000)`);
r = await salon.req('/api/salon/clients/inactive?days=45');
ok('clienta inactiva (60 días) listada', r.status === 200 && Array.isArray(r.json) && r.json.some((x) => x.phone === '+573005556677'), `${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);

console.log('\n== 14. Respaldo cifrado + descarga ==');
r = await admin.req('/api/system/backup', { method: 'POST' });
ok('respaldo manual 200 con clave', r.status === 200 && r.json?.ok && r.json?.encrypted === true, `${r.status} ${r.text.slice(0, 200)}`);
const backupFile = r.json?.file;
ok('archivo .enc en volumen persistente', Boolean(backupFile?.endsWith('.enc')) && execSync(`test -f ${process.env.TEST_PERSIST_DIR || '/tmp/salon13-persist'}/backups/${backupFile} && echo SI || echo NO`, { encoding: 'utf8' }).trim() === 'SI', String(backupFile));
r = await admin.req(`/api/system/backup/download?file=${encodeURIComponent(backupFile)}`);
ok('descarga del respaldo 200', r.status === 200, `${r.status}`);
r = await admin.req('/api/system/backup/download?file=..%2F..%2Fetc%2Fpasswd');
ok('descarga con traversal -> 400', r.status === 400, `${r.status}`);
const anon = jar();
r = await anon.req(`/api/system/backup/download?file=${encodeURIComponent(backupFile)}`);
ok('descarga sin auth -> 401', r.status === 401, `${r.status}`);
// Descifrar y verificar contenido SQL.
try {
  execSync(`cd /home/hatch/workspace/salon-multisalon/salon-v1-3 && BACKUP_ENCRYPTION_KEY=${process.env.BACKUP_ENCRYPTION_KEY || '38a12b6a4ae356e131e8f999cc7d41b8b792bc02e95afd01819228ee7f8a976a'} node scripts/decrypt-backup.js /tmp/salon13-persist/backups/${backupFile} /tmp/salon13-decrypted.sql.gz && gunzip -c /tmp/salon13-decrypted.sql.gz | head -5 | grep -qi "postgresql" && echo DECRYPT-OK`, { encoding: 'utf8' });
  ok('el .enc descifra a un dump SQL válido', true);
} catch (e) {
  ok('el .enc descifra a un dump SQL válido', false, String(e.message).slice(0, 200));
}

console.log('\n== 15. Logout revoca la sesión ==');
r = await salon.req('/api/auth/logout', { method: 'POST' });
ok('logout 200', r.status === 200, `${r.status}`);
r = await salon.req('/api/auth/me');
ok('tras logout, /api/auth/me 401', r.status === 401, `${r.status}`);

console.log(`\nRESULTADO: ${pass} ✓ / ${fail} ✗`);
process.exit(fail ? 1 : 0);
