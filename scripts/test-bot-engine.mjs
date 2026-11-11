// Prueba del motor del bot de reservas SIN WhatsApp real (v1.1).
// Simula mensajes entrantes con una tienda en memoria (FakeStore) que imita
// la tienda Postgres: huecos, creación con anti-doble-reserva (si dos
// clientas piden el mismo hueco, solo una gana), cancelación con política,
// reprogramación y sesiones. Uso: node scripts/test-bot-engine.mjs
import { createBotEngine } from '../bot-engine.js';

const pad = (n) => String(n).padStart(2, '0');
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(iso, n) { const d = new Date(`${iso}T12:00:00-05:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dm(iso) { const [, m, d] = iso.split('-'); return `${Number(d)}/${Number(m)}`; }

class FakeStore {
  constructor() {
    this.salon = { id: 1, name: 'Bella Luna', bot_enabled: true, default_deposit_pct: 20 };
    this.services = [
      { id: 1, name: 'Manicura', price: 50000, duration_minutes: 60, deposit_pct: 0, team_size: 1, active: true },
      { id: 2, name: 'Pedicura spa', price: 70000, duration_minutes: 90, deposit_pct: 20, team_size: 1, active: true },
      { id: 3, name: 'Acrílicas 4 manos', price: 120000, duration_minutes: 120, deposit_pct: 20, team_size: 2, active: true },
      { id: 4, name: 'Keratina', price: 150000, duration_minutes: 120, deposit_pct: null, team_size: 1, active: true },
    ];
    this.pros = [{ id: 10, name: 'Ana' }, { id: 11, name: 'Luz' }];
    this.appts = [];
    this.sessions = new Map();
    this.nextId = 1;
    this.taken = new Set(); // date|start|proIds
  }
  async getSalon() { return { ...this.salon }; }
  async listServices() { return this.services; }
  async listProfessionals(_sid, serviceId) {
    if (serviceId === 3) return this.pros;
    return this.pros;
  }
  async getSlots(_sid, service, professionalId, date) {
    const svc = typeof service === 'object' && service.duration_minutes ? service : this.services.find((s) => s.id === (service?.id ?? service));
    const team = Number(svc.team_size || 1) >= 2;
    // Como el computeSlots real: a 4 manos el hueco es una PAREJA (la
    // elegida primero + otra); si no, una sola profesional.
    const slotPros = team ? this.pros : (professionalId ? this.pros.filter((p) => p.id === professionalId) : this.pros.slice(0, 1));
    const slots = [];
    for (const start of ['09:00', '10:00', '11:00']) {
      const end = start === '09:00' ? '10:00' : start === '10:00' ? '11:00' : '12:00';
      const ids = slotPros.map((p) => p.id);
      const key = `${date}|${start}|${ids.join(',')}`;
      if (this.taken.has(key)) continue;
      slots.push({
        start, end,
        professionals: slotPros.map((p) => ({ id: p.id, name: p.name })),
        professionalId: slotPros[0].id, professionalName: slotPros[0].name,
      });
    }
    return slots;
  }
  async createAppointment(input) {
    const svc = this.services.find((s) => s.id === input.service.id);
    const proIds = input.professionalIds?.length ? input.professionalIds : [10];
    const key = `${input.date}|${input.startTime}|${proIds.join(',')}`;
    if (this.taken.has(key)) throw Object.assign(new Error('Ese horario ya no está libre'), { status: 409 });
    this.taken.add(key);
    // Como depositFor en el servidor: % del servicio si está fijado, si
    // no el del salón (20 %), si no 0. Con 0 % la cita nace confirmada.
    const effPct = svc.deposit_pct != null ? Number(svc.deposit_pct) : Number(this.salon.default_deposit_pct ?? 20);
    const depAmount = Math.round(Number(svc.price) * effPct / 100);
    const appt = {
      id: this.nextId++, salon_id: 1, service_id: svc.id, service_name: svc.name,
      professional_id: proIds[0], professional_ids: proIds,
      professional_name: this.pros.filter((p) => proIds.includes(p.id)).map((p) => p.name).join(' y '),
      client_phone: input.clientPhone, client_name: input.clientName,
      date: input.date, start_time: input.startTime, end_time: '10:00',
      status: depAmount > 0 ? 'pendiente' : 'confirmada',
      deposit_amount: depAmount, deposit_pct: effPct, deposit_status: 'pendiente',
    };
    this.appts.push(appt);
    return { created: [appt], professionals: this.pros.filter((p) => proIds.includes(p.id)), deposit: { pct: effPct, amount: depAmount }, salon: this.salon };
  }
  async findUpcoming(_sid, phone) {
    return this.appts.filter((a) => a.client_phone === phone && ['pendiente', 'confirmada'].includes(a.status) && a.date >= todayStr());
  }
  async confirmAppointment(id) {
    const a = this.appts.find((x) => x.id === id);
    if (a) { a.status = 'confirmada'; a.confirmation_status = 'confirmada_por_whatsapp'; }
  }
  async cancelAppointment(id) {
    const a = this.appts.find((x) => x.id === id);
    if (!a) throw new Error('no existe');
    const h = (new Date(`${a.date}T${a.start_time}:00-05:00`).getTime() - Date.now()) / 3600000;
    const refund = h >= 48 ? Number(a.deposit_amount) : h >= 24 ? Math.round(Number(a.deposit_amount) / 2) : 0;
    a.status = 'cancelada';
    a.deposit_status = refund > 0 ? 'reembolsado' : 'retenido';
    return { refund: { refund, kept: Number(a.deposit_amount) - refund, rule: h >= 48 ? 'gratuita' : h >= 24 ? '50%' : 'sin reembolso' } };
  }
  async rescheduleAppointment(id, newDate, newStart) {
    const a = this.appts.find((x) => x.id === id);
    if (!a) throw new Error('no existe');
    const key = `${newDate}|${newStart}|${(a.professional_ids || [a.professional_id]).join(',')}`;
    if (this.taken.has(key)) throw Object.assign(new Error('Ese horario ya está ocupado'), { status: 409 });
    this.taken.delete(`${a.date}|${a.start_time}|${(a.professional_ids || [a.professional_id]).join(',')}`);
    this.taken.add(key);
    a.date = newDate; a.start_time = newStart;
    return a;
  }
  async depositLink({ appointmentId }) {
    return { paymentUrl: `https://checkout.wompi.co/p/?test=ANT-${appointmentId}`, provider: 'wompi' };
  }
  async getClientName() { return null; }
  async getSession(salonId, phone) { return this.sessions.get(`${salonId}|${phone}`) || null; }
  async saveSession(session) { this.sessions.set(`${session.salon_id}|${session.client_phone}`, JSON.parse(JSON.stringify(session))); }
  async clearSession(salonId, phone) { this.sessions.delete(`${salonId}|${phone}`); }
}

// Harness: un engine por prueba (misma tienda cuando se quiere compartir estado).
function harness(store) {
  const sent = [];
  const engine = createBotEngine({
    store,
    send: async (m) => { sent.push(m); },
    logger: { info: () => {}, error: (...a) => console.error('[engine-error]', ...a), warn: () => {} },
  });
  const say = async (phone, content, channel = 'qr') => {
    const r = await engine.handleMessage({ salonId: 1, phone, content, channel, instanceId: channel === 'qr' ? 'principal' : null });
    return { r, last: sent.length ? sent[sent.length - 1]?.content : null, sent: [...sent] };
  };
  return { say, sent, engine };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const TOMORROW = addDays(todayStr(), 1);
const DAY_AFTER = addDays(todayStr(), 2);

// 1. Bot apagado = silencio total
{
  const store = new FakeStore();
  store.salon.bot_enabled = false;
  const h = harness(store);
  const { r } = await h.say('+573001111111', 'hola');
  check('1. Bot apagado = silencio (sin respuestas)', r.replied === false && h.sent.length === 0, `replied=${r.replied} enviados=${h.sent.length}`);
}

// 2. Bot encendido = responde con el nombre del salón
{
  const store = new FakeStore();
  const h = harness(store);
  const { r, last } = await h.say('+573001111111', 'hola');
  check('2. Bot encendido = saluda con el nombre del salón', r.replied === true && /Bella Luna/.test(last || ''), last?.split('\n')[0]);
}

// 3. Reserva completa sin anticipo (Manicura)
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573002222222';
  await h.say(phone, 'hola');
  await h.say(phone, '1'); // reservar
  await h.say(phone, '1'); // Manicura
  await h.say(phone, '0'); // primera disponible
  await h.say(phone, dm(TOMORROW));
  await h.say(phone, '1'); // hueco 09:00
  await h.say(phone, 'María Pérez');
  await h.say(phone, 'sí'); // teléfono ok
  const { last } = await h.say(phone, 'sí'); // confirmar
  check('3. Reserva completa sin anticipo → confirmada', /confirmada/i.test(last || '') && store.appts.length === 1 && store.appts[0].status === 'confirmada', last?.split('\n')[0]);
}

// 4. Reserva con anticipo (Pedicura spa 20%) → link Wompi
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573003333333';
  await h.say(phone, 'reservar');
  await h.say(phone, '2'); // Pedicura spa
  await h.say(phone, '1'); // Ana
  await h.say(phone, dm(TOMORROW));
  await h.say(phone, '1');
  await h.say(phone, 'Laura Gómez');
  await h.say(phone, 'sí');
  const { last } = await h.say(phone, 'sí');
  check('4. Reserva con anticipo → link de pago y cita pendiente', /anticipo/i.test(last || '') && /checkout\.wompi\.co/.test(last || '') && store.appts[0].status === 'pendiente', last?.split('\n').slice(0, 3).join(' | '));
}

// 4b. v1.3 (anticipo opcional): servicio SIN % fijado (null) + salón con
// default 20 % → el bot muestra el anticipo ($30.000) en la confirmación
// y manda el link; antes mostraba "sin anticipo" y luego pedía el pago.
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573003333334';
  await h.say(phone, 'reservar');
  await h.say(phone, '4'); // Keratina (deposit_pct null → default del salón 20 %)
  await h.say(phone, '1'); // Ana
  await h.say(phone, dm(TOMORROW));
  await h.say(phone, '1');
  await h.say(phone, 'Carmen Ruiz');
  const confirm = await h.say(phone, 'sí'); // teléfono ok → pantalla de confirmación
  const showsDeposit = /Anticipo/i.test(confirm.last || '') && /30\.000/.test(confirm.last || '');
  const { last } = await h.say(phone, 'sí'); // confirmar
  check('4b. Servicio sin % + default del salón 20 % → anticipo $30.000 y link', showsDeposit && /anticipo/i.test(last || '') && /checkout\.wompi\.co/.test(last || '') && store.appts[0].status === 'pendiente' && store.appts[0].deposit_amount === 30000, `confirmación: ${confirm.last?.split('\n').slice(-2).join(' | ')}`);
}

// 5. Hueco ocupado (carrera real): B ve el hueco libre, A lo toma antes
//    de que B confirme → B recibe 409 y se le ofrecen otros huecos.
{
  const store = new FakeStore();
  const ha = harness(store);
  const hb = harness(store);
  // B llega hasta elegir el hueco de las 09:00 (todavía libre).
  await hb.say('+573005555555', 'reservar');
  await hb.say('+573005555555', '1');
  await hb.say('+573005555555', '1');
  await hb.say('+573005555555', dm(TOMORROW));
  await hb.say('+573005555555', '1'); // hueco 09:00, queda en 'name'
  // A reserva ese mismo hueco antes de que B confirme.
  const bookA = async () => {
    await ha.say('+573004444444', 'reservar');
    await ha.say('+573004444444', '1');
    await ha.say('+573004444444', '1');
    await ha.say('+573004444444', dm(TOMORROW));
    await ha.say('+573004444444', '1');
    await ha.say('+573004444444', 'Clienta A');
    await ha.say('+573004444444', 'sí');
    return ha.say('+573004444444', 'sí');
  };
  const ra = await bookA();
  await hb.say('+573005555555', 'Clienta B');
  await hb.say('+573005555555', 'sí');
  const rb = await hb.say('+573005555555', 'sí'); // confirmar → 409
  check('5a. Primera clienta confirma el hueco', /confirmada/i.test(ra.last || ''), ra.last?.split('\n')[0]);
  check('5b. Segunda clienta: hueco ocupado y se le ofrecen otros', /se acaba de ocupar/i.test(rb.last || '') && /Huecos libres/.test(rb.last || ''), rb.last?.split('\n')[0]);
  await hb.say('+573005555555', '1'); // otro hueco de la lista nueva
  await hb.say('+573005555555', 'Clienta B');
  await hb.say('+573005555555', 'sí');
  const rd = await hb.say('+573005555555', 'sí');
  check('5c. Segunda clienta confirma otro hueco', /confirmada/i.test(rd.last || '') && store.appts.length === 2, `citas=${store.appts.length}`);
}

// 6. Cancelar con política de anticipo
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573006666666';
  await h.say(phone, 'reservar');
  await h.say(phone, '2'); // Pedicura spa (anticipo 20% de 70000 = 14000)
  await h.say(phone, '1');
  await h.say(phone, dm(addDays(todayStr(), 3))); // >48h → reembolso completo
  await h.say(phone, '1');
  await h.say(phone, 'Sofía Ruiz');
  await h.say(phone, 'sí');
  await h.say(phone, 'sí');
  await h.say(phone, 'cancelar');
  const { last: listMsg } = await h.say(phone, '1');
  check('6a. Cancelar muestra la política de reembolso', /reembols|gratuita/i.test(listMsg || ''), listMsg?.split('\n')[0]);
  const { last } = await h.say(phone, 'sí');
  check('6b. Cancelar → cita cancelada y reembolso', /cancelada/i.test(last || '') && /14\.000/.test(last || '') && store.appts[0].status === 'cancelada', last);
}

// 7. Reprogramar
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573007777777';
  await h.say(phone, 'reservar');
  await h.say(phone, '1');
  await h.say(phone, '1');
  await h.say(phone, dm(TOMORROW));
  await h.say(phone, '1');
  await h.say(phone, 'Ana Torres');
  await h.say(phone, 'sí');
  await h.say(phone, 'sí');
  await h.say(phone, 'reprogramar');
  await h.say(phone, '1');
  await h.say(phone, dm(DAY_AFTER));
  await h.say(phone, '1');
  const { last } = await h.say(phone, 'sí');
  check('7. Reprogramar → nueva fecha confirmada', /quedó para el/i.test(last || '') && store.appts[0].date === DAY_AFTER, last);
}

// 8. Hablar con una persona → pausa; "bot" reanuda
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573008888888';
  const { last: l1 } = await h.say(phone, 'hablar con una persona');
  const { r: r2 } = await h.say(phone, 'hola, ¿siguen ahí?');
  const { last: l3 } = await h.say(phone, 'bot');
  check('8a. Pide persona → pasa a humano', /persona del salón/i.test(l1 || ''), l1?.split('\n')[0]);
  check('8b. Pausado: silencio ante nuevos mensajes', r2.replied === false, `replied=${r2.replied}`);
  check('8c. "bot" reanuda el menú', /Bella Luna/.test(l3 || ''), l3?.split('\n')[0]);
}

// 9. Tres intentos sin entender → humano
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573009999999';
  await h.say(phone, 'reservar');
  await h.say(phone, 'zzz');
  await h.say(phone, 'zzz');
  const { last } = await h.say(phone, 'zzz');
  check('9. 3 intentos fallidos → pasa a humano', /persona del salón/i.test(last || ''), last?.split('\n')[0]);
}

// 10. S/N a un recordatorio (sin sesión activa)
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573001010101';
  await h.say(phone, 'reservar');
  await h.say(phone, '1');
  await h.say(phone, '1');
  await h.say(phone, dm(TOMORROW));
  await h.say(phone, '1');
  await h.say(phone, 'Camila Díaz');
  await h.say(phone, 'sí');
  await h.say(phone, 'sí');
  // Sesión terminada (done). Llega el recordatorio y responde "S".
  const { last } = await h.say(phone, 'S');
  check('10. Respuesta "S" al recordatorio → cita confirmada', /queda confirmada/i.test(last || '') && store.appts[0].status === 'confirmada', last?.split('\n')[0]);
}

// 11. Reserva a 4 manos con profesional elegida
{
  const store = new FakeStore();
  const h = harness(store);
  const phone = '+573001212121';
  await h.say(phone, 'reservar');
  await h.say(phone, '3'); // Acrílicas 4 manos
  await h.say(phone, '1'); // Ana (debe ir en la pareja)
  await h.say(phone, dm(TOMORROW));
  const { last: slotsMsg } = await h.say(phone, '1');
  await h.say(phone, 'Valentina Ríos');
  await h.say(phone, 'sí');
  const { last } = await h.say(phone, 'sí');
  check('11. 4 manos con profesional elegida → confirma con las dos', /confirmada|apartada/i.test(last || '') && store.appts[0].professional_ids.length === 2, `pros=${store.appts[0]?.professional_ids}`);
}

const fails = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} pruebas pasaron.`);
if (fails) { console.log('FALLARON:', results.filter((r) => !r.ok).map((r) => r.name).join(' | ')); process.exit(1); }
