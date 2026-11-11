// SalonOS v1.3 — Rutas multisalón (AgendaPro-level para estilistas y manicuristas, Colombia).
// MÉTODOS DE PAGO v1.2 (fuente única en el backend; el frontend usa
// lib/paymentMethods.ts con los mismos valores):
//   efectivo, nequi, daviplata, breb_nu ("Bre-B / Llave Nu"), transferencia_banco,
//   tarjeta_bold, pse, wompi, payu.
// La clienta paga por Nequi, Daviplata, llave Nu (Bre-B) y banco: la llave Nu
// es UN método aparte de la transferencia banco, para que el cierre cuadre
// por banco y no se mezcle lo de Nu con lo de la cuenta del banco.
// Mapeo de métodos viejos (v1/v1.1): "transferencia" -> "transferencia_banco",
// "bre-b"/"breb" -> "breb_nu". Los registros viejos NO se reescriben en la
// base: se normalizan al leerlos (cierre) y al validarlos (cobros nuevos).
export const POS_METHODS = ['efectivo', 'nequi', 'daviplata', 'breb_nu', 'transferencia_banco', 'tarjeta_bold', 'pse', 'wompi', 'payu'];
export const PAYMENT_METHOD_LABELS = {
  efectivo: 'Efectivo', nequi: 'Nequi', daviplata: 'Daviplata',
  breb_nu: 'Bre-B / Llave Nu', transferencia_banco: 'Transferencia banco',
  tarjeta_bold: 'Tarjeta Bold', pse: 'PSE', wompi: 'Wompi', payu: 'PayU',
};
export const LEGACY_PAYMENT_METHODS = {
  transferencia: 'transferencia_banco', transferencia_bancaria: 'transferencia_banco',
  'bre-b': 'breb_nu', breb: 'breb_nu', bre_b: 'breb_nu',
  llave_nu: 'breb_nu', 'llave-nu': 'breb_nu', nu: 'breb_nu', tarjeta: 'tarjeta_bold',
};
// Métodos que se registran a mano en el salón. Wompi/PayU no van aquí:
// se cobran por link y solo el webhook los confirma como pagados.
export const MANUAL_PAYMENT_METHODS = ['efectivo', 'nequi', 'daviplata', 'breb_nu', 'transferencia_banco', 'tarjeta_bold', 'pse'];
export function normalizePaymentMethod(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (POS_METHODS.includes(s)) return s;
  if (LEGACY_PAYMENT_METHODS[s]) return LEGACY_PAYMENT_METHODS[s];
  // Variantes escritas a mano: "Bre-B / Llave Nu", "llave Nu", "breb nu".
  if (s.includes('llave') && s.includes('nu')) return 'breb_nu';
  if (s.includes('bre-b') || s.includes('breb')) return 'breb_nu';
  if (s.includes('transferencia')) return 'transferencia_banco';
  return null;
}
export function cleanPaymentReference(ref) {
  const r = String(ref || '').trim();
  return r ? r.slice(0, 120) : null;
}
// Resuelve un pago mixto contra el resto por cobrar (total - anticipo).
// Reglas: método exacto y válido; monto explícito > 0; a lo sumo UN método
// sin monto, que cobra el resto (remaining - suma explícita); la suma final
// debe ser igual al resto (tolerancia $1). Un amount:null NUNCA se
// multiplica ni se convierte en el total completo (bug R9 de v1.1).
// remaining <= 0 -> no hay nada que cobrar, devuelve [].
export function resolvePayments(rawPayments, remaining) {
  const rest = Math.round((Number(remaining) || 0) * 100) / 100;
  if (rest <= 0) return [];
  if (!Array.isArray(rawPayments) || !rawPayments.length) throw new Error('Se necesita al menos un método de pago');
  const explicit = [];
  let nullCount = 0;
  for (const p of rawPayments) {
    const method = normalizePaymentMethod(p && p.method);
    if (!method) throw new Error(`Método no válido: ${p && p.method}`);
    const rawAmt = p && p.amount;
    if (rawAmt == null || rawAmt === '') { nullCount++; explicit.push({ method, amount: null, reference: cleanPaymentReference(p && p.reference) }); continue; }
    const amount = Math.round((Number(rawAmt) || 0) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`El monto de ${PAYMENT_METHOD_LABELS[method]} debe ser mayor a $0`);
    explicit.push({ method, amount, reference: cleanPaymentReference(p && p.reference) });
  }
  if (nullCount > 1) throw new Error('Solo un método puede quedar sin monto (cobra el resto)');
  const explicitSum = Math.round(explicit.reduce((a, x) => a + (x.amount || 0), 0) * 100) / 100;
  if (nullCount === 1) {
    const restAmt = Math.round((rest - explicitSum) * 100) / 100;
    if (restAmt <= 0) throw new Error(`El pago ya suma $${explicitSum.toLocaleString('es-CO')} y el resto por cobrar es $${rest.toLocaleString('es-CO')}`);
    return explicit.map((x) => (x.amount == null ? { ...x, amount: restAmt } : x));
  }
  if (Math.abs(explicitSum - rest) > 1) throw new Error(`El pago suma $${explicitSum.toLocaleString('es-CO')} y el resto por cobrar es $${rest.toLocaleString('es-CO')}`);
  return explicit;
}

// Se registra desde server.js con registerSalonRoutes(app, deps). Todo el
// aislamiento multi-tenant sale del JWT (req.user.salonId), NUNCA de
// parámetros del cliente (?salon_id=, ?role=... se ignoran).
// Prioridades del informe investigacion-mejoras-colombia.md aplicadas en v1:
// (1) anticipo anti-no-show con política de cancelación, (2) recordatorios
// WhatsApp con confirmación S/N y lista de espera, (3) reserva sin cruces
// incl. 4 manos y walk-in, (4) caja/POS colombiano (pago mixto, propina,
// cierre por método, documento DEE POS / factura plena — ver nota DIAN),
// (5) comisiones con regla congelada al agendar + liquidación.
// NOTA DIAN HONESTA: este sistema NO emite DEE POS real con CUFE/CUDE ni
// transmite a la DIAN. Genera factura de venta interna (PDF/impresa) y
// export JSON DIAN-ready para un proveedor certificado (heredado de v5.2).
// El documento requerido se calcula y se guarda, pero dian_transmitted es
// siempre false hasta la integración real (v1.1). No prometer CUFE real.
export function registerSalonRoutes(app, deps) {
  const { pool, jwt, jwtSecret, normalizePhoneCO, normalizePhoneString,
    sendWhatsAppMessage, getMetaConfig, recordEvent, notifyUpdate, logger, hasDb, getSettingValue, googleCalendar } = deps;
  // v1.3: leer una cookie del request (el token de salón se emite también
  // en cookie HttpOnly; el de superadmin se guarda para volver).
  function cookieValue(req, name) {
    const h = req.headers?.cookie || '';
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }
  function cookieOpts(req, maxAge) {
    return { httpOnly: true, sameSite: 'strict', secure: req.secure || req.headers['x-forwarded-proto'] === 'https', maxAge, path: '/' };
  }

  const UVT_2026 = 52374;
  const FIVE_UVT = 5 * UVT_2026; // $261.870 COP en 2026
  // POS_METHODS, etiquetas y normalización: exportados arriba (v1.2).
  const APPT_STATUSES = ['pendiente', 'confirmada', 'completada', 'cancelada', 'no-show', 'en_curso'];

  // ---------- Helpers de tenant / roles ----------
  function salonIdNum(req) {
    const v = req.user && req.user.salonId != null ? Number(req.user.salonId) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  function isSuperadmin(req) { return String(req.user?.role || '').toLowerCase() === 'superadmin'; }
  function roleOf(req) { return String(req.user?.role || '').toLowerCase(); }
  // Contexto de salón obligatorio: el superadmin sin token de salón NO ve
  // datos operativos (debe usar POST /api/salons/:id/token para entrar).
  function requireSalon(req, res, next) {
    const sid = salonIdNum(req);
    if (!sid) return res.status(403).json({ error: 'Sin contexto de salón: el superadmin debe entrar a un salón (token de salón) para ver sus datos operativos' });
    req.salonId = sid; next();
  }
  function requireSuperadmin(req, res, next) {
    if (!isSuperadmin(req)) return res.status(403).json({ error: 'Solo el superadmin de la plataforma' });
    next();
  }
  function requireSalonAdmin(req, res, next) {
    if (roleOf(req) !== 'admin') return res.status(403).json({ error: 'Solo el administrador del salón' });
    next();
  }
  function requireSalonStaff(req, res, next) {
    // Admin y recepcionista gestionan agenda/caja; estilista/manicurista
    // solo lectura de lo suyo (los endpoints filtran por professional_id).
    if (!['admin', 'recepcionista'].includes(roleOf(req))) return res.status(403).json({ error: 'Solo administradores o recepcionistas' });
    next();
  }
  const ownOnly = (req) => ['estilista', 'manicurista'].includes(roleOf(req));
  const num = (v) => Number(v) || 0;
  const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

  // ---------- Tiempo ----------
  const toMin = (t) => { const [h, m] = String(t || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  // AUDITORÍA v1.1: node-pg devuelve DATE como objeto Date; String(date)
  // da "Fri Nov 06" y .slice(0,10) ya NO es la fecha (reembolsos daban 0,
  // el recordatorio 2h nunca se disparaba, PATCH corrompía la fecha).
  // dateStr() es la única forma segura de pasar una fecha a YYYY-MM-DD.
  const dateStr = (d) => {
    if (!d) return null;
    if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    const s = String(d);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const p = new Date(s);
    return Number.isNaN(p.getTime()) ? null : p.toISOString().slice(0, 10);
  };

  // Horario por defecto de un profesional (Lun-Sáb 09:00-19:00, Dom cerrado).
  // employees.schedule (JSONB) lo puede cambiar por día: { "1": ["09:00","19:00"], ... } (0=Dom).
  function scheduleForDay(schedule, dateStr) {
    const dow = new Date(`${dateStr}T12:00:00`).getDay();
    if (schedule && typeof schedule === 'object' && schedule[String(dow)]) {
      const [a, b] = schedule[String(dow)]; return a && b ? [a, b] : null;
    }
    if (dow === 0) return null;
    return ['09:00', '19:00'];
  }

  // ---------- WhatsApp por salón: QR > Meta > cola ----------
  async function sendSalonWhatsApp(salonId, phone, content) {
    const { phone: norm } = normalizePhoneCO(phone);
    if (!norm || !content) return { ok: false, channel: 'none', error: 'Teléfono o contenido vacío' };
    // 1) QR de ESTE salón, si hay una instancia lista.
    const qr = await sendWhatsAppMessage({ phone: norm, content, channel: 'qr', salonId });
    if (qr.ok) return qr;
    // 2) Meta de ESTE salón (token por salón en settings, si no el global).
    const meta = await getMetaConfig(salonId);
    if (meta.configured) {
      const r = await sendWhatsAppMessage({ phone: norm, content, channel: 'meta', salonId });
      if (r.ok) return r;
    }
    // 3) Cola: queda guardado para reintentar (POST /api/salon/wa/flush).
    try {
      await pool.query('INSERT INTO wa_queue (salon_id, phone, content, status) VALUES ($1, $2, $3, $4)', [salonId, norm, content, 'pendiente']);
    } catch (e) { logger && logger.error('No se pudo encolar WhatsApp', e); }
    return { ok: false, channel: 'cola', error: `Sin canal listo (${qr.error || 'QR no listo'}${meta.configured ? '' : '; Meta no configurado'}). Mensaje en cola.` };
  }

  function apptMessage(salon, appt, kind) {
    const fecha = appt.date instanceof Date ? appt.date.toISOString().slice(0, 10) : String(appt.date || '').slice(0, 10);
    const base = `Hola ${appt.client_name}, te escribe ${salon.name}. Tu cita de ${appt.service_name || 'servicio'} con ${appt.professional_name || ''} es el ${fecha} a las ${String(appt.start_time || '').slice(0, 5)}.`;
    if (kind === 'created') {
      // v1.3 (anticipo opcional): sin anticipo no se pide pago para confirmar.
      if (num(appt.deposit_amount) > 0) return `${base} Te pedimos anticipo para confirmarla. ¿Confirmas que asistes? Responde S o N.`;
      return `${base} Tu cita quedó confirmada (sin anticipo). ¿Confirmas que asistes? Responde S o N.`;
    }
    if (kind === 'reminder24') return `${base} ¿Sigues asistiendo mañana? Responde S para confirmar o N para cancelar.`;
    if (kind === 'reminder2h') return `${base} Te esperamos en 2 horas. ¿Confirmas? Responde S o N.`;
    if (kind === 'waitlist') return `Hola ${appt.client_name}, te escribe ${salon.name}. Se liberó un cupo de ${appt.service_name || 'servicio'} el ${fecha} a las ${String(appt.start_time || '').slice(0, 5)}. ¿Lo tomas? Responde S o N.`;
    return base;
  }

  // ---------- Catálogo preconfigurado por tipo de salón (mejora 11) ----------
  const CATALOG_SEEDS = {
    unas: [
      ['Manicure tradicional', 'uñas', 45, 35000, 50, 20], ['Manicure semipermanente', 'uñas', 60, 55000, 45, 20],
      ['Pedicure', 'uñas', 60, 50000, 50, 20], ['Acrílico esculpido', 'uñas', 120, 120000, 40, 50],
      ['Polygel', 'uñas', 120, 110000, 40, 50], ['Retiro de semipermanente', 'uñas', 30, 20000, 50, 0],
      ['Diseño / nail art', 'uñas', 30, 15000, 50, 0],
    ],
    peluqueria: [
      ['Corte mujer', 'cabello', 60, 60000, 40, 20], ['Corte hombre', 'cabello', 30, 35000, 40, 0],
      ['Tinte', 'cabello', 120, 150000, 40, 50], ['Balayage', 'cabello', 180, 280000, 40, 50],
      ['Keratina / alisado', 'cabello', 150, 250000, 40, 50], ['Cepillado', 'cabello', 45, 40000, 40, 0],
      ['Maquillaje', 'maquillaje', 60, 90000, 40, 20],
    ],
    barberia: [
      ['Corte + barba', 'cabello', 45, 40000, 40, 0], ['Corte', 'cabello', 30, 30000, 40, 0],
      ['Afeitado tradicional', 'cabello', 30, 25000, 40, 0], ['Diseño de barba', 'cabello', 30, 30000, 40, 0],
    ],
    spa: [
      ['Masaje relajante 60 min', 'spa', 60, 90000, 40, 20], ['Limpieza facial', 'spa', 60, 80000, 40, 20],
      ['Manicure spa', 'uñas', 60, 60000, 45, 20], ['Pedicure spa', 'uñas', 60, 65000, 45, 20],
    ],
    mixto: [],
  };
  CATALOG_SEEDS.mixto = [...CATALOG_SEEDS.unas.slice(0, 4), ...CATALOG_SEEDS.peluqueria.slice(0, 4)];

  async function seedCatalog(client, salonId, type) {
    const seed = CATALOG_SEEDS[type] || CATALOG_SEEDS.mixto;
    for (const [name, category, duration, price, commissionPct, depositPct] of seed) {
      await client.query(
        `INSERT INTO salon_services (salon_id, name, category, duration_minutes, price, commission_pct, deposit_pct, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT DO NOTHING`,
        [salonId, name, category, duration, price, commissionPct, depositPct]);
    }
  }

  // ---------- Política de cancelación / anticipo (mejora 1) ----------
  // Regla del informe: gratis hasta 48 h antes; 50 % de reembolso entre
  // 24 y 48 h; sin reembolso con menos de 24 h o no-show.
  function refundFor(salon, apptDate, apptStart, depositAmount) {
    const dstr = dateStr(apptDate);
    if (!dstr) return { refund: 0, kept: money(depositAmount), rule: 'fecha de cita inválida' };
    const at = new Date(`${dstr}T${String(apptStart).slice(0, 5)}:00-05:00`).getTime();
    const hours = (at - Date.now()) / 3600000;
    const freeH = num(salon.free_cancel_hours ?? 48) || 48;
    const partialH = num(salon.partial_cancel_hours ?? 24) || 24;
    const partialPct = num(salon.partial_refund_pct ?? 50) || 50;
    if (hours >= freeH) return { refund: money(depositAmount), kept: 0, rule: `cancelación gratuita (más de ${freeH} h antes)` };
    if (hours >= partialH) return { refund: money(depositAmount * partialPct / 100), kept: money(depositAmount * (100 - partialPct) / 100), rule: `reembolso parcial ${partialPct} % (entre ${partialH} y ${freeH} h antes)` };
    return { refund: 0, kept: money(depositAmount), rule: 'sin reembolso (menos de 24 h antes o no-show)' };
  }
  function depositFor(service, salon) {
    const pct = service.deposit_pct != null ? num(service.deposit_pct) : num(salon.default_deposit_pct ?? 20);
    return { pct, amount: money(num(service.price) * pct / 100) };
  }
  // v1.3 (anticipo opcional): el texto de la política dice explícitamente
  // si hay anticipo o no. Con 0 % la cita se confirma sin pago y no hay
  // nada que reembolsar; con >0 % sigue la política de siempre.
  function policyTextFor(dep) {
    if (!dep || num(dep.amount) <= 0) return 'Sin anticipo: la cita queda confirmada sin pago. Cancelación gratuita hasta 48 h antes; si cancelas con menos tiempo, avísanos para liberar el hueco (no hay anticipo que reembolsar).';
    return `Anticipo ${dep.pct}% ($${dep.amount.toLocaleString('es-CO')}). Cancelación gratuita hasta 48 h antes; entre 24 y 48 h reembolso del 50% del anticipo; menos de 24 h o no-show sin reembolso.`;
  }

  // ---------- Documento requerido (mejora 4 + nota DIAN) ----------
  function requiredDocument(total, clientNit, wantsInvoice) {
    if (wantsInvoice || (clientNit && String(clientNit).trim()) || num(total) > FIVE_UVT) {
      return { type: 'factura_electronica_plena', reason: num(total) > FIVE_UVT ? `venta mayor a 5 UVT ($${FIVE_UVT.toLocaleString('es-CO')})` : 'el cliente pidió factura plena o dio NIT' };
    }
    return { type: 'dee_pos', reason: 'venta de mostrador menor o igual a 5 UVT' };
  }

  // ---------- Disponibilidad sin cruces (mejora 3) ----------
  async function busyIntervals(client, salonId, dateStr, professionalIds) {
    const r = await client.query(
      `SELECT professional_ids, start_time, end_time, cleanup_minutes FROM appointments
        WHERE salon_id=$1 AND date=$2 AND status NOT IN ('cancelada','no-show') AND professional_ids && $3`,
      [salonId, dateStr, professionalIds]);
    return r.rows.map((x) => ({ ids: x.professional_ids || [], start: toMin(x.start_time), end: toMin(x.end_time) + num(x.cleanup_minutes || 0) }));
  }
  async function computeSlots(client, salonId, service, professionalId, dateStr) {
    const duration = num(service.duration_minutes) || 60;
    const cleanup = num(service.cleanup_minutes ?? 15);
    let pros = [];
    let chosenId = null;
    if (professionalId) {
      const p = await client.query("SELECT id, name, schedule FROM employees WHERE id=$1 AND salon_id=$2 AND active=true AND role IN ('estilista','manicurista','operator')", [professionalId, salonId]);
      if (!p.rows[0]) return { error: 'Profesional no encontrado en este salón' };
      // AUDITORÍA v1.1: a 4 manos con profesional elegido antes devolvía
      // cero huecos (el filtro pedía 2 libres entre 1 sola profesional).
      // Ahora se calculan los huecos de todas y se exige que la elegida
      // esté en la pareja.
      if (num(service.team_size || 1) >= 2) chosenId = Number(professionalId);
      else pros = p.rows;
    }
    if (!pros.length) {
      const assigned = await client.query('SELECT employee_id FROM service_professionals WHERE service_id=$1', [service.id]);
      let q = "SELECT id, name, schedule FROM employees WHERE salon_id=$1 AND active=true AND role IN ('estilista','manicurista','operator')";
      const params = [salonId];
      if (assigned.rows.length) { q += ' AND id = ANY($2)'; params.push(assigned.rows.map((x) => x.employee_id)); }
      q += ' ORDER BY name';
      pros = (await client.query(q, params)).rows;
    }
    const teamSize = num(service.team_size || 1);
    const slots = [];
    for (const pro of pros) {
      const sched = scheduleForDay(pro.schedule, dateStr);
      if (!sched) continue;
      const busy = await busyIntervals(client, salonId, dateStr, [pro.id]);
      let t = toMin(sched[0]);
      const endDay = toMin(sched[1]);
      while (t + duration <= endDay) {
        const e = t + duration;
        const free = !busy.some((b) => overlaps(t, e + cleanup, b.start, b.end));
        const isPast = dateStr === todayStr() && t < toMin(`${new Date().getHours()}:${String(new Date().getMinutes()).padStart(2, '0')}`);
        if (free && !isPast) slots.push({ professionalId: pro.id, professionalName: pro.name, start: toTime(t), end: toTime(e) });
        t += 15; // huecos cada 15 min
      }
    }
    // A 4 manos (team_size 2): solo valen los huecos donde 2 profesionales
    // que hacen el servicio están libres a la vez.
    if (teamSize >= 2) {
      const byTime = {};
      for (const s of slots) { (byTime[s.start] = byTime[s.start] || []).push(s); }
      return Object.entries(byTime)
        .filter(([, v]) => v.length >= 2 && (!chosenId || v.some((x) => x.professionalId === chosenId)))
        .map(([start, v]) => {
          const ordered = chosenId ? [...v.filter((x) => x.professionalId === chosenId), ...v.filter((x) => x.professionalId !== chosenId)] : v;
          return { start, end: toTime(toMin(start) + duration), professionals: ordered.slice(0, 2).map((x) => ({ id: x.professionalId, name: x.professionalName })) };
        });
    }
    return slots;
  }
  async function assertNoOverlap(client, salonId, professionalIds, dateStr, startMin, endMin, cleanup) {
    const busy = await busyIntervals(client, salonId, dateStr, professionalIds);
    const clash = busy.find((b) => overlaps(startMin, endMin + cleanup, b.start, b.end));
    if (clash) {
      const err = new Error('Ese horario ya está ocupado para ese profesional (la base rechaza el cruce)');
      err.status = 409; throw err;
    }
  }
  async function getSalon(client, salonId) {
    const r = await client.query('SELECT * FROM salons WHERE id=$1', [salonId]);
    return r.rows[0] || null;
  }
  async function upsertSalonClient(client, salonId, phone, name, extra = {}) {
    const norm = normalizePhoneString(phone);
    if (!norm) return null;
    await client.query(
      `INSERT INTO salon_clients (salon_id, phone, name, notes, allergies, formula, data_consent, data_consent_text, data_consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (salon_id, phone) DO UPDATE SET name=COALESCE(EXCLUDED.name, salon_clients.name),
         notes=COALESCE(EXCLUDED.notes, salon_clients.notes), allergies=COALESCE(EXCLUDED.allergies, salon_clients.allergies),
         formula=COALESCE(EXCLUDED.formula, salon_clients.formula),
         data_consent=COALESCE(EXCLUDED.data_consent, salon_clients.data_consent)`,
      [salonId, norm, (name || '').trim() || null, extra.notes || null, extra.allergies || null, extra.formula || null,
       extra.dataConsent === true, extra.dataConsentText || null, extra.dataConsent === true ? new Date().toISOString() : null]);
    const r = await client.query('SELECT * FROM salon_clients WHERE salon_id=$1 AND phone=$2', [salonId, norm]);
    return r.rows[0];
  }
  // AUDITORÍA v1.1: una cita a 4 manos son N filas con el mismo group_id.
  // Cancelar / no-show / anticipo / completar / reprogramar deben actuar
  // sobre TODO el grupo, no sobre una sola fila.
  async function groupRows(client, salonId, appt) {
    if (!appt.group_id) return [appt];
    const r = await client.query('SELECT * FROM appointments WHERE salon_id=$1 AND group_id=$2 ORDER BY id', [salonId, appt.group_id]);
    return r.rows.length ? r.rows : [appt];
  }
  function mapAppt(r) {
    return {
      id: r.id, salonId: r.salon_id, groupId: r.group_id, serviceId: r.service_id, serviceName: r.service_name,
      professionalId: r.professional_id, professionalIds: r.professional_ids || [], professionalName: r.professional_name,
      clientPhone: r.client_phone, clientName: r.client_name, date: r.date ? new Date(r.date).toISOString().slice(0, 10) : null,
      startTime: String(r.start_time || '').slice(0, 5), endTime: String(r.end_time || '').slice(0, 5),
      durationMinutes: num(r.duration_minutes), cleanupMinutes: num(r.cleanup_minutes),
      status: r.status, confirmationStatus: r.confirmation_status, source: r.source,
      price: num(r.price), discount: num(r.discount), tip: num(r.tip),
      commissionPctFrozen: num(r.commission_pct_frozen), commissionAmount: num(r.commission_amount),
      suppliesCost: num(r.supplies_cost), depositPctFrozen: num(r.deposit_pct_frozen),
      depositAmount: num(r.deposit_amount), depositStatus: r.deposit_status, depositRefundAmount: num(r.deposit_refund_amount),
      policyText: r.policy_text, policyAcceptedAt: r.policy_accepted_at, notes: r.notes,
      createdAt: r.created_at, completedAt: r.completed_at,
    };
  }

  // ================= RUTAS PÚBLICAS (sin login) =================
  // La clienta nunca ve el nombre de la plataforma: solo el salón.
  app.get('/api/public/branding/:slug', async (req, res) => {
    try {
      if (hasDb && !hasDb()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const r = await pool.query('SELECT name, slug, logo_url, primary_color, secondary_color, phone, address, city FROM salons WHERE slug=$1 AND active=true', [req.params.slug]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/public/reserva/:slug', async (req, res) => {
    try {
      if (hasDb && !hasDb()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const s = await pool.query('SELECT id, name, slug, logo_url, primary_color, secondary_color, phone, address, default_deposit_pct FROM salons WHERE slug=$1 AND active=true', [req.params.slug]);
      if (!s.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      const svc = await pool.query('SELECT id, name, category, duration_minutes, price, deposit_pct, team_size, description FROM salon_services WHERE salon_id=$1 AND active=true ORDER BY category, name', [s.rows[0].id]);
      const pros = await pool.query("SELECT id, name FROM employees WHERE salon_id=$1 AND active=true AND role IN ('estilista','manicurista','operator') ORDER BY name", [s.rows[0].id]);
      res.json({ salon: s.rows[0], services: svc.rows, professionals: pros.rows, policy: { freeCancelHours: 48, partialCancelHours: 24, partialRefundPct: 50, note: 'Cancelación gratuita hasta 48 h antes. Entre 24 y 48 h se reembolsa el 50 % del anticipo. Con menos de 24 h o no-show, el anticipo no se reembolsa.' } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/public/reserva/:slug/slots', async (req, res) => {
    try {
      if (hasDb && !hasDb()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const { serviceId, professionalId, date } = req.query;
      if (!serviceId || !date) return res.status(400).json({ error: 'serviceId y date son obligatorios' });
      const s = await pool.query('SELECT id FROM salons WHERE slug=$1 AND active=true', [req.params.slug]);
      if (!s.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      const svc = await pool.query('SELECT * FROM salon_services WHERE id=$1 AND salon_id=$2 AND active=true', [serviceId, s.rows[0].id]);
      if (!svc.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
      const client = await pool.connect();
      try { res.json(await computeSlots(client, s.rows[0].id, svc.rows[0], professionalId ? Number(professionalId) : null, String(date))); }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // Reserva pública: crea la cita en pendiente + anticipo pendiente.
  // NUNCA confía en el precio del frontend: precio, duración y comisión
  // salen del catálogo del salón.
  app.post('/api/public/reserva/:slug', async (req, res) => {
    try {
      if (hasDb && !hasDb()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const { serviceId, professionalId, date, startTime, clientName, clientPhone, notes, acceptPolicy, dataConsent } = req.body || {};
      if (!acceptPolicy) return res.status(400).json({ error: 'Debes aceptar la política de cancelación y anticipo' });
      if (!clientName || !clientPhone) return res.status(400).json({ error: 'Nombre y teléfono son obligatorios' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || String(date) < todayStr()) return res.status(400).json({ error: 'La fecha debe ser hoy o una fecha futura (AAAA-MM-DD)' });
      if (!/^\d{2}:\d{2}$/.test(String(startTime))) return res.status(400).json({ error: 'La hora no es válida (HH:MM)' });
      const s = await pool.query('SELECT * FROM salons WHERE slug=$1 AND active=true', [req.params.slug]);
      if (!s.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      const salon = s.rows[0];
      const svc = await pool.query('SELECT * FROM salon_services WHERE id=$1 AND salon_id=$2 AND active=true', [serviceId, salon.id]);
      if (!svc.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
      const service = svc.rows[0];
      const startMin = toMin(startTime);
      const endMin = startMin + num(service.duration_minutes);
      const cleanup = num(service.cleanup_minutes ?? 15);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Profesionales: el elegido, o el primero disponible (4 manos: 2).
        let proIds = [];
        if (professionalId) proIds = [Number(professionalId)];
        else {
          const slots = await computeSlots(client, salon.id, service, null, String(date));
          const slot = (Array.isArray(slots) ? slots : []).find((x) => x.start === String(startTime).slice(0, 5));
          if (!slot) throw Object.assign(new Error('Ese horario ya no está libre'), { status: 409 });
          proIds = slot.professionals ? slot.professionals.map((p) => p.id) : [slot.professionalId];
        }
        if (num(service.team_size || 1) >= 2 && proIds.length < 2) throw Object.assign(new Error('Este servicio es a 4 manos: se necesitan 2 profesionales libres a la vez'), { status: 409 });
        await assertNoOverlap(client, salon.id, proIds, String(date), startMin, endMin, cleanup);
        const proRes = await client.query('SELECT id, name, commission_pct FROM employees WHERE id = ANY($1) AND salon_id=$2', [proIds, salon.id]);
        if (proRes.rows.length !== proIds.length) throw Object.assign(new Error('Profesional no válido para este salón'), { status: 400 });
        const dep = depositFor(service, salon);
        const policyText = policyTextFor(dep);
        // v1.3 (anticipo opcional): sin anticipo la cita nace confirmada.
        const publicStatus = dep.amount > 0 ? 'pendiente' : 'confirmada';
        const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const created = [];
        for (const pro of proRes.rows) {
          const pctFrozen = service.commission_pct != null ? num(service.commission_pct) : num(pro.commission_pct || 0);
          const ins = await client.query(
            `INSERT INTO appointments (salon_id, group_id, service_id, service_name, professional_id, professional_ids, professional_name,
              client_phone, client_name, date, start_time, end_time, duration_minutes, cleanup_minutes, status, source, price,
              commission_pct_frozen, deposit_pct_frozen, deposit_amount, deposit_status, policy_text, policy_accepted_at, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$21,'online',$15,$16,$17,$18,'pendiente',$19,NOW(),$20) RETURNING *`,
            [salon.id, groupId, service.id, service.name, pro.id, proIds, pro.name,
             normalizePhoneString(clientPhone), String(clientName).trim(), date, String(startTime).slice(0, 5), toTime(endMin),
             num(service.duration_minutes), cleanup, num(service.price), pctFrozen, dep.pct, dep.amount, policyText, notes || null, publicStatus]);
          created.push(ins.rows[0]);
        }
        await upsertSalonClient(client, salon.id, clientPhone, clientName, { dataConsent: dataConsent === true, dataConsentText: dataConsent === true ? 'Autorizo el tratamiento de mis datos para gestionar mis citas (Ley 1581 de 2012).' : null });
        await client.query('COMMIT');
        // Confirmación inmediata por WhatsApp (QR > Meta > cola).
        const first = created[0];
        await sendSalonWhatsApp(salon.id, clientPhone, apptMessage(salon, { ...first, service_name: service.name, professional_name: proRes.rows.map((p) => p.name).join(' y ') }, 'created'));
        res.status(201).json({ success: true, appointments: created.map(mapAppt), deposit: dep, policy: policyText, note: dep.amount > 0 ? 'La cita queda pendiente hasta que se pague el anticipo (link de pago o Nequi en el salón).' : 'Cita confirmada: no requiere anticipo.' });
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ================= SUPERADMIN: SALONES =================
  app.get('/api/salons', requireSuperadmin, async (req, res) => {
    try {
      const r = await pool.query(`SELECT s.*, (SELECT COUNT(*)::int FROM employees WHERE salon_id=s.id AND active=true) AS staff_count,
        (SELECT COUNT(*)::int FROM appointments WHERE salon_id=s.id AND date=CURRENT_DATE) AS appointments_today,
        (SELECT COALESCE(SUM(total),0) FROM pos_sales WHERE salon_id=s.id AND created_at::date=CURRENT_DATE) AS sales_today
        FROM salons s ORDER BY s.created_at DESC`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salons', requireSuperadmin, async (req, res) => {
    try {
      const { name, slug, phone, address, city, type, plan } = req.body || {};
      if (!name || !slug) return res.status(400).json({ error: 'Nombre y slug son obligatorios' });
      const cleanSlug = String(slug).toLowerCase().trim().replace(/[^a-z0-9-]/g, '-');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query(
          `INSERT INTO salons (name, slug, phone, address, city, plan, active) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
          [String(name).trim(), cleanSlug, phone || null, address || null, city || null, plan || 'basico']);
        await seedCatalog(client, ins.rows[0].id, type || 'mixto');
        await client.query('COMMIT');
        await recordEvent('info', 'salons', `Salón creado: ${name} (/${cleanSlug}) con catálogo ${type || 'mixto'}`, { salon_id: ins.rows[0].id });
        res.status(201).json(ins.rows[0]);
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // v1.3 (anticipo opcional): el salón ve y cambia su anticipo por
  // defecto (0–100 %; 0 = sin anticipo salvo que el servicio diga otra
  // cosa). Regla efectiva: % del servicio si está fijado, si no el del
  // salón, si no 20 %.
  app.get('/api/salons/me', requireSalon, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM salons WHERE id=$1', [req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/salons/me/settings', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const pct = req.body?.default_deposit_pct;
      if (pct == null || !Number.isFinite(Number(pct)) || Number(pct) < 0 || Number(pct) > 100) return res.status(400).json({ error: 'El anticipo por defecto debe estar entre 0 y 100 % (0 = sin anticipo)' });
      const r = await pool.query('UPDATE salons SET default_deposit_pct=$1 WHERE id=$2 RETURNING *', [Number(pct), req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/salons/:id', async (req, res) => {
    try {
      if (!isSuperadmin(req) && salonIdNum(req) !== Number(req.params.id)) return res.status(403).json({ error: 'No puedes ver otro salón' });
      const r = await pool.query('SELECT * FROM salons WHERE id=$1', [req.params.id]);
      if (!r.rows[0] || (!isSuperadmin(req) && !r.rows[0].active)) return res.status(404).json({ error: 'Salón no encontrado' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/salons/:id', requireSuperadmin, async (req, res) => {
    try {
      const { name, phone, address, city, plan, logo_url, primary_color, secondary_color, default_deposit_pct, commission_after_supplies } = req.body || {};
      const r = await pool.query(
        `UPDATE salons SET name=COALESCE($1,name), phone=COALESCE($2,phone), address=COALESCE($3,address), city=COALESCE($4,city),
         plan=COALESCE($5,plan), logo_url=COALESCE($6,logo_url), primary_color=COALESCE($7,primary_color),
         secondary_color=COALESCE($8,secondary_color), default_deposit_pct=COALESCE($9,default_deposit_pct),
         commission_after_supplies=COALESCE($10,commission_after_supplies) WHERE id=$11 RETURNING *`,
        [name, phone, address, city, plan, logo_url, primary_color, secondary_color, default_deposit_pct, commission_after_supplies, req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.patch('/api/salons/:id/estado', requireSuperadmin, async (req, res) => {
    try {
      const r = await pool.query('UPDATE salons SET active=$1 WHERE id=$2 RETURNING *', [req.body.active !== false, req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Token de salón: el superadmin "entra" como admin de ese salón (1 h,
  // auditado). Es la única vía para que el superadmin vea datos operativos.
  app.post('/api/salons/:id/token', requireSuperadmin, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM salons WHERE id=$1 AND active=true', [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Salón no encontrado o inactivo' });
      // v1.3: el token de salón lleva tv (revocación) y se emite también en
      // cookie HttpOnly; el token de superadmin queda guardado en otra
      // cookie para poder volver con POST /api/salons/exit.
      const tvRow = await pool.query('SELECT token_version FROM employees WHERE id=$1', [req.user.id]);
      const tv = tvRow.rows[0]?.token_version ?? 0;
      const user = { id: `superadmin:${req.user.id}`, name: `Superadmin (${r.rows[0].name})`, role: 'admin', email: req.user.email, salonId: Number(req.params.id), tv };
      const token = jwt.sign(user, jwtSecret, { expiresIn: '1h' });
      const prev = cookieValue(req, 'salon_token')
        || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
      if (prev) res.cookie('salon_superadmin_token', prev, cookieOpts(req, 24 * 3600 * 1000));
      res.cookie('salon_token', token, cookieOpts(req, 3600 * 1000));
      await recordEvent('info', 'salons', `Superadmin entró al salón ${r.rows[0].name} con token de 1 h`, { salon_id: r.rows[0].id });
      res.json({ success: true, user, token, salon: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // v1.3: volver al superadmin. Restaura la cookie de sesión guardada al
  // entrar al salón (verificando tv). Si la guardada ya no vale, se borran
  // las cookies y el frontend vuelve con el token guardado en localStorage.
  app.post('/api/salons/exit', async (req, res) => {
    try {
      const saved = cookieValue(req, 'salon_superadmin_token');
      res.clearCookie('salon_token', { path: '/' });
      res.clearCookie('salon_superadmin_token', { path: '/' });
      if (!saved) return res.status(401).json({ error: 'No hay sesión de superadmin guardada' });
      let decoded;
      try { decoded = jwt.verify(saved, jwtSecret); }
      catch { return res.status(401).json({ error: 'La sesión de superadmin expiró: inicia sesión de nuevo' }); }
      if (String(decoded.role || '').toLowerCase() !== 'superadmin') return res.status(403).json({ error: 'La sesión guardada no es de superadmin' });
      const r = await pool.query('SELECT active, token_version FROM employees WHERE id=$1', [decoded.id]);
      if (!r.rows[0] || !r.rows[0].active) return res.status(401).json({ error: 'Cuenta desactivada' });
      if ((r.rows[0].token_version ?? 0) !== (decoded.tv ?? 0)) return res.status(401).json({ error: 'Sesión revocada, inicia sesión de nuevo' });
      res.cookie('salon_token', saved, cookieOpts(req, 24 * 3600 * 1000));
      res.json({ success: true, user: decoded });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Marca blanca del propio salón (admin del salón, sin "Purifica" en ningún lado).
  app.put('/api/salons/me/branding', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const { name, logo_url, primary_color, secondary_color } = req.body || {};
      if (primary_color && !/^#[0-9a-fA-F]{6}$/.test(primary_color)) return res.status(400).json({ error: 'primary_color debe ser #RRGGBB' });
      if (secondary_color && !/^#[0-9a-fA-F]{6}$/.test(secondary_color)) return res.status(400).json({ error: 'secondary_color debe ser #RRGGBB' });
      const r = await pool.query(
        `UPDATE salons SET name=COALESCE($1,name), logo_url=COALESCE($2,logo_url), primary_color=COALESCE($3,primary_color), secondary_color=COALESCE($4,secondary_color) WHERE id=$5 RETURNING *`,
        [name, logo_url, primary_color, secondary_color, req.salonId]);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= CATÁLOGO DE SERVICIOS =================
  app.get('/api/salon/catalog-services', requireSalon, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT s.*, (SELECT COALESCE(json_agg(sp.employee_id), '[]') FROM service_professionals sp WHERE sp.service_id=s.id) AS "professionalIds"
         FROM salon_services s WHERE s.salon_id=$1 ORDER BY s.category, s.name`, [req.salonId]);
      res.json(r.rows.map((x) => ({ id: x.id, salonId: x.salon_id, name: x.name, category: x.category, description: x.description, durationMinutes: num(x.duration_minutes), cleanupMinutes: num(x.cleanup_minutes), price: num(x.price), commissionPct: num(x.commission_pct), depositPct: num(x.deposit_pct), teamSize: num(x.team_size || 1), requiresConsent: !!x.requires_consent, active: !!x.active, retouchDays: x.retouch_days != null ? num(x.retouch_days) : null, professionalIds: Array.isArray(x.professionalIds) ? x.professionalIds.map(Number) : [] })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/catalog-services', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name || !b.durationMinutes || b.price == null) return res.status(400).json({ error: 'Nombre, duración y precio son obligatorios' });
      // v1.3 (anticipo opcional): 0 % permitido (sin anticipo); fuera de 0–100 no.
      if (b.depositPct != null && (!Number.isFinite(Number(b.depositPct)) || Number(b.depositPct) < 0 || Number(b.depositPct) > 100)) return res.status(400).json({ error: 'El anticipo debe estar entre 0 y 100 % (0 = sin anticipo)' });
      const r = await pool.query(
        `INSERT INTO salon_services (salon_id, name, category, description, duration_minutes, cleanup_minutes, price, commission_pct, deposit_pct, team_size, requires_consent, active, retouch_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) RETURNING *`,
        [req.salonId, String(b.name).trim(), b.category || 'general', b.description || null, Number(b.durationMinutes), Number(b.cleanupMinutes ?? 15), Number(b.price), Number(b.commissionPct ?? 0), Number(b.depositPct ?? 20), Number(b.teamSize || 1), !!b.requiresConsent, b.retouchDays != null ? Number(b.retouchDays) : null]);
      if (Array.isArray(b.professionalIds)) {
        const chk = await pool.query("SELECT COUNT(*)::int AS n FROM employees WHERE id = ANY($1) AND salon_id=$2 AND role IN ('estilista','manicurista','operator')", [b.professionalIds.map(Number), req.salonId]);
        if (chk.rows[0].n !== b.professionalIds.length) return res.status(400).json({ error: 'Un profesional no pertenece a este salón' });
        for (const pid of b.professionalIds) await pool.query('INSERT INTO service_professionals (service_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, pid]);
      }
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/salon/catalog-services/:id', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      // v1.3 (anticipo opcional): 0 % permitido (sin anticipo); fuera de 0–100 no.
      if (b.depositPct != null && (!Number.isFinite(Number(b.depositPct)) || Number(b.depositPct) < 0 || Number(b.depositPct) > 100)) return res.status(400).json({ error: 'El anticipo debe estar entre 0 y 100 % (0 = sin anticipo)' });
      const r = await pool.query(
        `UPDATE salon_services SET name=COALESCE($1,name), category=COALESCE($2,category), description=COALESCE($3,description),
         duration_minutes=COALESCE($4,duration_minutes), cleanup_minutes=COALESCE($5,cleanup_minutes), price=COALESCE($6,price),
         commission_pct=COALESCE($7,commission_pct), deposit_pct=COALESCE($8,deposit_pct), team_size=COALESCE($9,team_size),
         requires_consent=COALESCE($10,requires_consent), active=COALESCE($11,active), retouch_days=COALESCE($12,retouch_days)
         WHERE id=$13 AND salon_id=$14 RETURNING *`,
        [b.name, b.category, b.description, b.durationMinutes, b.cleanupMinutes, b.price, b.commissionPct, b.depositPct, b.teamSize, b.requiresConsent, b.active, b.retouchDays != null ? Number(b.retouchDays) : null, req.params.id, req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado en este salón' });
      if (Array.isArray(b.professionalIds)) {
        const chk = await pool.query("SELECT COUNT(*)::int AS n FROM employees WHERE id = ANY($1) AND salon_id=$2 AND role IN ('estilista','manicurista','operator')", [b.professionalIds.map(Number), req.salonId]);
        if (chk.rows[0].n !== b.professionalIds.length) return res.status(400).json({ error: 'Un profesional no pertenece a este salón' });
        await pool.query('DELETE FROM service_professionals WHERE service_id=$1', [req.params.id]);
        for (const pid of b.professionalIds) await pool.query('INSERT INTO service_professionals (service_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, pid]);
      }
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/salon/catalog-services/:id', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const r = await pool.query('UPDATE salon_services SET active=false WHERE id=$1 AND salon_id=$2 RETURNING id', [req.params.id, req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado en este salón' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= PROFESIONALES (vista Hoy incluida) =================
  app.get('/api/salon/professionals', requireSalon, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT e.id, e.name, e.email, e.role, e.phone, e.commission_pct AS "commissionPct", e.schedule, e.active,
         (SELECT COALESCE(json_agg(sp.service_id), '[]') FROM service_professionals sp WHERE sp.employee_id=e.id) AS "serviceIds"
         FROM employees e WHERE e.salon_id=$1 AND e.active=true AND e.role IN ('estilista','manicurista','operator') ORDER BY e.name`,
        [req.salonId]);
      let rows = r.rows;
      if (ownOnly(req)) rows = rows.filter((x) => String(x.id) === String(req.user.id));
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // v1.3 (disponibilidad por profesional, hoy en Bogotá): "Disponible
  // ahora" / "Ocupada hasta las X" / "Fuera de horario" / "Sin horario
  // definido", calculada con el horario del día (employees.schedule),
  // las citas de hoy y la hora actual. No se inventa nada: sin horario
  // no se dice "disponible". El estado en línea (is_online, manual) se
  // expone aparte; la etiqueta la mandan horario y citas.
  app.get('/api/salon/professionals/availability', requireSalon, async (req, res) => {
    try {
      const parts = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).formatToParts(new Date());
      const get = (t) => parts.find((p) => p.type === t)?.value;
      const date = `${get('year')}-${get('month')}-${get('day')}`;
      const nowMin = Number(get('hour')) * 60 + Number(get('minute'));
      const nowStr = `${String(get('hour')).padStart(2, '0')}:${String(get('minute')).padStart(2, '0')}`;
      let pros = (await pool.query(
        `SELECT e.id, e.name, e.role, e.schedule, COALESCE(e.is_online, true) AS "isOnline"
         FROM employees e WHERE e.salon_id=$1 AND e.active=true AND e.role IN ('estilista','manicurista','operator') ORDER BY e.name`,
        [req.salonId])).rows;
      if (ownOnly(req)) pros = pros.filter((x) => String(x.id) === String(req.user.id));
      const appts = (await pool.query(
        `SELECT professional_ids, start_time, end_time FROM appointments
         WHERE salon_id=$1 AND date=$2 AND status NOT IN ('cancelada','no-show') ORDER BY start_time`,
        [req.salonId, date])).rows;
      const out = pros.map((p) => {
        const sched = scheduleForDay(p.schedule, date);
        const mine = appts.filter((a) => (a.professional_ids || []).map(String).includes(String(p.id)));
        const current = mine.find((a) => toMin(a.start_time) <= nowMin && nowMin < toMin(a.end_time));
        let status, label, busyUntil = null;
        if (!sched) { status = 'sin_horario'; label = 'Sin horario definido'; }
        else if (nowMin < toMin(sched[0]) || nowMin >= toMin(sched[1])) { status = 'fuera_horario'; label = `Fuera de horario (${String(sched[0]).slice(0, 5)}–${String(sched[1]).slice(0, 5)})`; }
        else if (current) { status = 'ocupada'; busyUntil = String(current.end_time).slice(0, 5); label = `Ocupada hasta las ${busyUntil}`; }
        else { status = 'disponible'; label = 'Disponible ahora'; }
        return { id: p.id, name: p.name, role: p.role, isOnline: !!p.isOnline, schedule: sched ? [String(sched[0]).slice(0, 5), String(sched[1]).slice(0, 5)] : null, status, label, busyUntil, appointmentsToday: mine.length };
      });
      res.json({ date, now: nowStr, professionals: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/salon/professionals/:id/schedule', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const r = await pool.query('UPDATE employees SET schedule=$1 WHERE id=$2 AND salon_id=$3 RETURNING id', [JSON.stringify(req.body.schedule || {}), req.params.id, req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Profesional no encontrado en este salón' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Vista "Hoy" de la profesional (mejora 10): qué sigue, quién, cuánto falta.
  app.get('/api/salon/today', requireSalon, async (req, res) => {
    try {
      const date = req.query.date || todayStr();
      const professionalId = ownOnly(req) ? req.user.id : (req.query.professionalId || null);
      const params = [req.salonId, date];
      let q = `SELECT * FROM appointments WHERE salon_id=$1 AND date=$2 AND status NOT IN ('cancelada','no-show')`;
      if (professionalId) { params.push(Number(professionalId)); q += ` AND $${params.length} = ANY(professional_ids)`; }
      q += ' ORDER BY start_time ASC';
      const r = await pool.query(q, params);
      // AUDITORÍA v1.1: la profesional veía las ventas de TODO el salón.
      const sales = professionalId
        ? await pool.query("SELECT COALESCE(SUM(total),0) AS day_total, COALESCE(SUM(tip_amount),0) AS day_tips FROM pos_sales WHERE salon_id=$1 AND created_at::date=$2 AND professional_id=$3", [req.salonId, date, Number(professionalId)])
        : await pool.query("SELECT COALESCE(SUM(total),0) AS day_total, COALESCE(SUM(tip_amount),0) AS day_tips FROM pos_sales WHERE salon_id=$1 AND created_at::date=$2", [req.salonId, date]);
      const mySales = professionalId
        ? await pool.query("SELECT COALESCE(SUM(commission_amount),0) AS my_commission, COALESCE(SUM(tip_amount),0) AS my_tips FROM pos_sales WHERE salon_id=$1 AND created_at::date=$2 AND professional_id=$3", [req.salonId, date, Number(professionalId)])
        : { rows: [{ my_commission: 0, my_tips: 0 }] };
      res.json({ date, appointments: r.rows.map(mapAppt), dayTotal: num(sales.rows[0]?.day_total), dayTips: num(sales.rows[0]?.day_tips), myCommission: num(mySales.rows[0]?.my_commission), myTips: num(mySales.rows[0]?.my_tips) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/salon/availability', requireSalon, async (req, res) => {
    try {
      const { serviceId, professionalId, date } = req.query;
      const svc = await pool.query('SELECT * FROM salon_services WHERE id=$1 AND salon_id=$2 AND active=true', [serviceId, req.salonId]);
      if (!svc.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });
      const client = await pool.connect();
      try { res.json(await computeSlots(client, req.salonId, svc.rows[0], professionalId ? Number(professionalId) : null, String(date))); }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ================= AGENDA / CITAS =================
  app.get('/api/salon/appointments', requireSalon, async (req, res) => {
    try {
      const { date, from, to, professionalId, status } = req.query;
      const params = [req.salonId];
      const clauses = ['salon_id=$1'];
      if (date) { params.push(date); clauses.push(`date=$${params.length}`); }
      if (from) { params.push(from); clauses.push(`date >= $${params.length}`); }
      if (to) { params.push(to); clauses.push(`date <= $${params.length}`); }
      if (status) { params.push(status); clauses.push(`status=$${params.length}`); }
      const proId = ownOnly(req) ? Number(req.user.id) : (professionalId ? Number(professionalId) : null);
      if (proId) { params.push(proId); clauses.push(`$${params.length} = ANY(professional_ids)`); }
      const r = await pool.query(`SELECT * FROM appointments WHERE ${clauses.join(' AND ')} ORDER BY date ASC, start_time ASC LIMIT 500`, params);
      res.json(r.rows.map(mapAppt));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/salon/appointments/:id', requireSalon, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      if (ownOnly(req) && !(r.rows[0].professional_ids || []).map(String).includes(String(req.user.id))) return res.status(403).json({ error: 'Esa cita no es tuya' });
      res.json(mapAppt(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Crear cita interna o walk-in (source: 'interna' | 'walk-in'). Walk-in:
  // clienta sin cita que llega al salón; se crea confirmada si hay hueco.
  // ---------- LÓGICA DE CITAS REUTILIZABLE (web + bot de WhatsApp) ----------
  // El bot de reservas usa ESTAS mismas funciones, con la misma
  // transacción y el mismo trigger anti-cruce que la agenda web: si dos
  // clientas piden el mismo hueco a la vez, solo una gana (la otra recibe
  // 409 y se le ofrecen otros huecos). El llamador ya hizo BEGIN; estas
  // funciones NO hacen COMMIT.
  async function createAppointmentTx(client, salonId, input) {
    const { service, date, startTime, clientName, clientPhone } = input;
    const startMin = toMin(startTime);
    const endMin = startMin + num(service.duration_minutes);
    const cleanup = num(service.cleanup_minutes ?? 15);
    let proIds = Array.isArray(input.professionalIds) && input.professionalIds.length ? input.professionalIds.map(Number) : (input.professionalId ? [Number(input.professionalId)] : []);
    if (!proIds.length) {
      const slots = await computeSlots(client, salonId, service, null, String(date));
      const slot = (Array.isArray(slots) ? slots : []).find((x) => x.start === String(startTime).slice(0, 5));
      if (!slot) throw Object.assign(new Error('Ese horario ya no está libre'), { status: 409 });
      proIds = slot.professionals ? slot.professionals.map((p) => p.id) : [slot.professionalId];
    }
    if (num(service.team_size || 1) >= 2 && proIds.length < 2) throw Object.assign(new Error('Este servicio es a 4 manos: se necesitan 2 profesionales'), { status: 400 });
    await assertNoOverlap(client, salonId, proIds, String(date), startMin, endMin, cleanup);
    const proRes = await client.query("SELECT id, name, commission_pct FROM employees WHERE id = ANY($1) AND salon_id=$2 AND active=true AND role IN ('estilista','manicurista','operator')", [proIds, salonId]);
    if (proRes.rows.length !== proIds.length) throw Object.assign(new Error('Profesional no válido para este salón'), { status: 400 });
    const salon = await getSalon(client, salonId);
    const dep = depositFor(service, salon);
    // v1.3 (anticipo opcional): sin anticipo la cita queda confirmada de
    // una vez (walk-in ya lo hacía); con anticipo queda pendiente hasta
    // que se pague. Un status explícito del llamador (bot) manda.
    const status = input.source === 'walk-in' ? 'confirmada' : (input.status || (dep.amount > 0 ? 'pendiente' : 'confirmada'));
    const policyText = policyTextFor(dep);
    const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created = [];
    for (const pro of proRes.rows) {
      const pctFrozen = service.commission_pct != null ? num(service.commission_pct) : num(pro.commission_pct || 0);
      const ins = await client.query(
        `INSERT INTO appointments (salon_id, group_id, service_id, service_name, professional_id, professional_ids, professional_name,
          client_phone, client_name, date, start_time, end_time, duration_minutes, cleanup_minutes, status, source, price,
          commission_pct_frozen, deposit_pct_frozen, deposit_amount, deposit_status, policy_text, policy_accepted_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pendiente',$21,NOW(),$22) RETURNING *`,
        [salonId, groupId, service.id, service.name, pro.id, proIds, pro.name,
         normalizePhoneString(clientPhone), String(clientName).trim(), date, String(startTime).slice(0, 5), toTime(endMin),
         num(service.duration_minutes), cleanup, status, input.source || 'interna',
         Math.min(Math.max(0, num(input.price ?? service.price)), num(service.price)), pctFrozen, dep.pct, dep.amount, policyText, input.notes || null]);
      created.push(ins.rows[0]);
    }
    await upsertSalonClient(client, salonId, clientPhone, clientName, { notes: input.clientNotes, allergies: input.allergies, formula: input.formula, dataConsent: input.dataConsent === true });
    return { created, professionals: proRes.rows, deposit: dep, salon };
  }

  // Cancela TODO el grupo con la política de anticipo. El llamador ya hizo BEGIN.
  async function cancelAppointmentTx(client, salonId, appt, reason) {
    const salon = await getSalon(client, salonId);
    const ref = refundFor(salon, appt.date, appt.start_time, num(appt.deposit_amount));
    const where = appt.group_id ? 'group_id=$3 AND salon_id=$4' : 'id=$3 AND salon_id=$4';
    const r = await client.query(
      `UPDATE appointments SET status='cancelada', deposit_status=CASE WHEN deposit_amount>0 THEN CASE WHEN $1>0 THEN 'reembolsado' ELSE 'retenido' END ELSE deposit_status END,
       deposit_refund_amount=$1, notes=COALESCE($2,notes) WHERE ${where} RETURNING *`,
      [ref.refund, reason || null, appt.group_id || appt.id, salonId]);
    return { appointment: r.rows[0], refund: ref };
  }

  // Reprograma TODO el grupo revalidando el cruce. El llamador ya hizo BEGIN.
  async function rescheduleAppointmentTx(client, salonId, appt, newDate, newStart) {
    const newEnd = toTime(toMin(newStart) + num(appt.duration_minutes));
    const rows = await client.query(
      `SELECT id, group_id, start_time, end_time, cleanup_minutes FROM appointments WHERE salon_id=$1 AND date=$2 AND status NOT IN ('cancelada','no-show') AND professional_ids && $3`,
      [salonId, newDate, appt.professional_ids || [appt.professional_id]]);
    const clash = rows.rows
      .filter((x) => !(appt.group_id ? x.group_id === appt.group_id : x.id === appt.id))
      .some((x) => overlaps(toMin(newStart), toMin(newEnd) + num(appt.cleanup_minutes || 0), toMin(x.start_time), toMin(x.end_time) + num(x.cleanup_minutes || 0)));
    if (clash) throw Object.assign(new Error('Ese horario ya está ocupado para ese profesional'), { status: 409 });
    const where = appt.group_id ? 'group_id=$3 AND salon_id=$4' : 'id=$3 AND salon_id=$4';
    const r = await client.query(
      `UPDATE appointments SET date=$1, start_time=$2, end_time=$5 WHERE ${where} RETURNING *`,
      [newDate, newStart, appt.group_id || appt.id, salonId, newEnd]);
    return r.rows[0];
  }

  // Link de pago del anticipo (Wompi checkout / PayU WebCheckout).
  // Referencia ANT-<id de cita>: el webhook la reconoce y marca el
  // anticipo como pagado. Devuelve { paymentUrl } o { error }.
  async function buildDepositLink(provider, amount, reference, serviceName, clientName) {
    const amt = money(amount);
    // v1.3 (anticipo opcional): nunca se genera un link de $0.
    if (amt <= 0) return { error: 'Este servicio no pide anticipo' };
    if (provider === 'wompi') {
      const pk = (process.env.WOMPI_PUBLIC_KEY || '').trim();
      if (!pk) return { error: 'Wompi no configurado: falta WOMPI_PUBLIC_KEY en .env' };
      const p = new URLSearchParams({ 'public-key': pk, currency: 'COP', 'amount-in-cents': String(Math.round(amt * 100)), reference });
      return { paymentUrl: `https://checkout.wompi.co/p/?${p.toString()}` };
    }
    if (provider === 'payu') {
      const merchantId = (process.env.PAYU_MERCHANT_ID || '').trim();
      const apiKey = (process.env.PAYU_API_KEY || '').trim();
      const accountId = (process.env.PAYU_ACCOUNT_ID || '').trim();
      if (!merchantId || !apiKey || !accountId) return { error: 'PayU no configurado: faltan PAYU_MERCHANT_ID, PAYU_API_KEY o PAYU_ACCOUNT_ID' };
      const amountStr = amt.toFixed(2);
      const crypto = await import('node:crypto');
      const signature = crypto.createHash('md5').update(`${apiKey}~${merchantId}~${reference}~${amountStr}~COP`).digest('hex');
      const p = new URLSearchParams({ merchantId, accountId, description: `Anticipo ${serviceName} - ${clientName}`, referenceCode: reference, amount: amountStr, tax: '0', taxReturnBase: '0', currency: 'COP', signature, test: '0' });
      return { paymentUrl: `https://checkout.payulatam.com/ppp-web-gateway-payu/?${p.toString()}` };
    }
    return { error: "provider debe ser 'wompi' o 'payu'" };
  }

  app.post('/api/salon/appointments', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const b = req.body || {};
      const service = (await pool.query('SELECT * FROM salon_services WHERE id=$1 AND salon_id=$2 AND active=true', [b.serviceId, req.salonId])).rows[0];
      if (!service) return res.status(404).json({ error: 'Servicio no encontrado' });
      if (!b.clientName || !b.clientPhone || !b.date || !b.startTime) return res.status(400).json({ error: 'Cliente, fecha y hora son obligatorios' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) || String(b.date) < todayStr()) return res.status(400).json({ error: 'La fecha debe ser hoy o una fecha futura (AAAA-MM-DD)' });
      if (!/^\d{2}:\d{2}$/.test(String(b.startTime))) return res.status(400).json({ error: 'La hora no es válida (HH:MM)' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { created, professionals, salon } = await createAppointmentTx(client, req.salonId, {
          service, date: String(b.date), startTime: String(b.startTime), clientName: b.clientName, clientPhone: b.clientPhone,
          professionalIds: b.professionalIds, professionalId: b.professionalId, source: b.source, status: b.status,
          price: b.price, notes: b.notes, clientNotes: b.clientNotes, allergies: b.allergies, formula: b.formula, dataConsent: b.dataConsent,
        });
        await client.query('COMMIT');
        await sendSalonWhatsApp(req.salonId, b.clientPhone, apptMessage(salon, { ...created[0], service_name: service.name, professional_name: professionals.map((p) => p.name).join(' y ') }, 'created'));
        // v1.3: Google Calendar (best-effort, nunca rompe la cita: sin
        // credenciales queda pendiente y se sincroniza desde el panel).
        try {
          const cal = await googleCalendar.syncAppointmentToCalendar(req.salonId, created[0]);
          if (!cal.synced) recordEvent('warn', 'calendar', `Google Calendar: cita ${created[0].id} sin sincronizar (${cal.reason})`, { salon_id: req.salonId });
        } catch (e) { recordEvent('warn', 'calendar', `Google Calendar: error sincronizando cita ${created[0].id}: ${e.message}`, { salon_id: req.salonId }); }
        res.status(201).json(created.map(mapAppt));
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // Cambiar estado / reprogramar (revalida el cruce, salvo que sea la misma cita).
  // AUDITORÍA v1.1: antes PATCH permitía status='completada' sin pago ni
  // comisión y 'cancelada' sin reembolso, y reprogramaba UNA fila de un
  // grupo de 4 manos dejando la otra en el horario viejo. Ahora:
  // - completada solo por POST .../complete; cancelada solo por .../cancel.
  // - la profesional solo puede poner 'en_curso' en sus citas.
  // - reprogramar mueve TODO el grupo; citas cerradas no se reprograman.
  app.patch('/api/salon/appointments/:id', requireSalon, async (req, res) => {
    try {
      const b = req.body || {};
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      if (ownOnly(req) && !(cur.professional_ids || []).map(String).includes(String(req.user.id))) return res.status(403).json({ error: 'Esa cita no es tuya' });
      if (ownOnly(req) && b.status && b.status !== 'en_curso') return res.status(403).json({ error: 'La profesional solo puede empezar sus citas' });
      if (ownOnly(req) && (b.date || b.startTime)) return res.status(403).json({ error: 'La profesional no puede reprogramar citas' });
      if (b.status && ['completada', 'cancelada', 'no-show'].includes(b.status)) return res.status(400).json({ error: 'Ese cambio no se hace aquí: usa Cobrar / Terminar para completar y Cancelar para cancelar (aplica la política de anticipo)' });
      const closed = ['completada', 'cancelada', 'no-show'].includes(cur.status);
      if (closed && (b.date || b.startTime)) return res.status(400).json({ error: 'La cita ya está cerrada: no se puede reprogramar' });
      const newDate = b.date ? String(b.date) : dateStr(cur.date);
      const newStart = b.startTime ? String(b.startTime).slice(0, 5) : String(cur.start_time).slice(0, 5);
      if (b.date && (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || newDate < todayStr())) return res.status(400).json({ error: 'La fecha debe ser hoy o una fecha futura' });
      if (b.startTime && !/^\d{2}:\d{2}$/.test(newStart)) return res.status(400).json({ error: 'La hora no es válida (HH:MM)' });
      const newEnd = toTime(toMin(newStart) + num(cur.duration_minutes));
      if (b.date || b.startTime) {
        const client = await pool.connect();
        try {
          const r2 = await client.query(
            `SELECT id, group_id, start_time, end_time, cleanup_minutes FROM appointments WHERE salon_id=$1 AND date=$2 AND status NOT IN ('cancelada','no-show') AND professional_ids && $3`,
            [req.salonId, newDate, cur.professional_ids || [cur.professional_id]]);
          // AUDITORÍA v1.1 (corrección propia): excluir solo el propio
          // grupo/cita, en JS — `group_id<>$3` con group_id NULL excluía
          // del chequeo a TODAS las citas simples.
          const clash2 = r2.rows
            .filter((x) => !(cur.group_id ? x.group_id === cur.group_id : x.id === cur.id))
            .some((x) => overlaps(toMin(newStart), toMin(newEnd) + num(cur.cleanup_minutes || 0), toMin(x.start_time), toMin(x.end_time) + num(x.cleanup_minutes || 0)));
          if (clash2) return res.status(409).json({ error: 'Ese horario ya está ocupado para ese profesional' });
        } finally { client.release(); }
      }
      const status = b.status && ['pendiente', 'confirmada', 'en_curso'].includes(b.status) ? b.status : cur.status;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const where = cur.group_id ? 'group_id=$6 AND salon_id=$7' : 'id=$6 AND salon_id=$7';
        const r = await client.query(
          `UPDATE appointments SET status=$1, date=$2, start_time=$3, end_time=$4, notes=COALESCE($5,notes),
           confirmation_status=CASE WHEN $1='confirmada' THEN 'confirmada' ELSE confirmation_status END
           WHERE ${where} RETURNING *`,
          [status, newDate, newStart, newEnd, b.notes || null, cur.group_id || req.params.id, req.salonId]);
        await client.query('COMMIT');
        notifyUpdate('appointment');
        // v1.3: si se reprogramó, el evento de Google se actualiza (mismo
        // id de evento, best-effort: si falla, queda el aviso en eventos).
        if (b.date || b.startTime) {
          try {
            const cal = await googleCalendar.syncAppointmentToCalendar(req.salonId, r.rows[0]);
            if (!cal.synced) recordEvent('warn', 'calendar', `Google Calendar: cita ${r.rows[0].id} sin re-sincronizar (${cal.reason})`, { salon_id: req.salonId });
          } catch (e) { recordEvent('warn', 'calendar', `Google Calendar: error re-sincronizando cita ${r.rows[0].id}: ${e.message}`, { salon_id: req.salonId }); }
        }
        res.json(mapAppt(r.rows[0]));
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // Cancelar con política: calcula reembolso del anticipo y lo guarda.
  // AUDITORÍA v1.1: no se puede cancelar una cita ya cerrada, y la
  // cancelación mueve TODO el grupo de 4 manos.
  app.post('/api/salon/appointments/:id/cancel', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      if (['completada', 'cancelada', 'no-show'].includes(cur.status)) return res.status(400).json({ error: `La cita ya está ${cur.status}: no se puede cancelar` });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { appointment, refund } = await cancelAppointmentTx(client, req.salonId, cur, req.body.reason);
        await client.query('COMMIT');
        await notifyWaitlist(req.salonId, cur);
        // v1.3: al cancelar, el evento de Google se borra (best-effort).
        try {
          const del = await googleCalendar.deleteAppointmentFromCalendar(req.salonId, cur);
          if (!del.deleted && del.reason !== 'Sin evento de Google Calendar') {
            recordEvent('warn', 'calendar', `Google Calendar: evento de la cita ${cur.id} sin borrar (${del.reason})`, { salon_id: req.salonId });
          }
        } catch (e) { recordEvent('warn', 'calendar', `Google Calendar: error borrando evento de la cita ${cur.id}: ${e.message}`, { salon_id: req.salonId }); }
        res.json({ appointment: mapAppt(appointment), refund });
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // ---------- GOOGLE CALENDAR (v1.3, CRM v5.3) ----------
  // Estado/prueba/sincronización del calendario del salón. La configuración
  // (credenciales por salón) se guarda con POST /api/salon/calendar/config
  // o con POST /api/settings (claves salon_<id>_google_*).
  app.get('/api/salon/calendar/status', requireSalon, async (req, res) => {
    try { res.json(await googleCalendar.googleCalendarStatus(req.salonId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/calendar/config', requireSalon, requireSalonAdmin, async (req, res) => {
    const allowed = ['client_id', 'client_secret', 'refresh_token', 'calendar_id', 'duration_minutes', 'enabled'];
    const { key, value } = req.body || {};
    if (!allowed.includes(key)) return res.status(400).json({ error: `Clave no permitida: ${key}` });
    if (key === 'duration_minutes' && value && (!/^\d+$/.test(String(value).trim()) || +value < 15 || +value > 1440)) {
      return res.status(400).json({ error: 'duration_minutes debe estar entre 15 y 1440' });
    }
    if (key === 'enabled' && value && !['true', 'false'].includes(String(value).trim())) {
      return res.status(400).json({ error: "enabled debe ser 'true' o 'false'" });
    }
    try {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [`salon_${req.salonId}_google_${key}`, String(value ?? '')]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/calendar/test', requireSalon, requireSalonAdmin, async (req, res) => {
    try { res.json(await googleCalendar.testGoogleCalendar(req.salonId)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/calendar/sync', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const st = await googleCalendar.googleCalendarStatus(req.salonId);
      if (!st.configured) return res.json({ ok: false, reason: st.reason, total: 0, synced: 0, failed: 0 });
      const r = await pool.query(`SELECT * FROM appointments WHERE salon_id=$1 AND status IN ('pendiente','confirmada') AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '30 days' ORDER BY date, start_time`, [req.salonId]);
      let synced = 0, failed = 0;
      const errors = [];
      for (const a of r.rows) {
        const out = await googleCalendar.syncAppointmentToCalendar(req.salonId, a);
        if (out.synced) synced++;
        else { failed++; if (errors.length < 5) errors.push(out.reason); }
      }
      res.json({ ok: failed === 0, total: r.rows.length, synced, failed, errors });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/appointments/:id/sync-calendar', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      if (cur.status === 'cancelada') {
        const d = await googleCalendar.deleteAppointmentFromCalendar(req.salonId, cur);
        return res.json({ ok: d.deleted, ...d });
      }
      const out = await googleCalendar.syncAppointmentToCalendar(req.salonId, cur);
      res.json({ ok: out.synced, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- SEGUIMIENTO DE RETOQUE (v1.3, adaptado de FollowUps del CRM) ----------
  // El CRM recuerda a los 3/6 meses; en salón el ciclo lo marca el SERVICIO
  // (retouch_days: tinte 21 días, keratina 90, manicura 15...). Solo 1 a 1
  // por WhatsApp, nunca campañas masivas (el bot prohíbe el spam).
  app.get('/api/salon/retouches/due', requireSalon, async (req, res) => {
    try {
      const r = await pool.query(`
        SELECT a.id, a.service_name, a.client_name, a.client_phone, a.date AS completed_date,
               a.professional_name, s.retouch_days,
               (CURRENT_DATE - a.date) AS days_since,
               (CURRENT_DATE - a.date - s.retouch_days) AS days_overdue
        FROM appointments a JOIN salon_services s ON s.id = a.service_id
        WHERE a.salon_id=$1 AND a.status='completada' AND a.reminded_retouch_at IS NULL
          AND s.retouch_days IS NOT NULL AND s.retouch_days > 0
          AND a.date <= CURRENT_DATE - s.retouch_days
          AND a.date >= CURRENT_DATE - INTERVAL '180 days'
        ORDER BY days_overdue DESC, a.date ASC LIMIT 200`, [req.salonId]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/retouches/:id/send', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const cur = (await pool.query(`SELECT a.*, s.retouch_days FROM appointments a JOIN salon_services s ON s.id=a.service_id WHERE a.id=$1 AND a.salon_id=$2 AND a.status='completada'`, [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada o no está completada' });
      if (cur.reminded_retouch_at) return res.status(400).json({ error: 'El recordatorio de retoque ya se envió para esta cita' });
      const days = Math.floor((Date.now() - new Date(cur.date).getTime()) / 86400000);
      const tpl = (await getSettingValue(`salon_${req.salonId}_retouch_message`, '')) || 'Hola {nombre} 💇‍♀️ Ya pasaron {dias} días desde tu {servicio} en {salon}. ¿Te agendo el retoque esta semana?';
      const salon = (await pool.query('SELECT name FROM salons WHERE id=$1', [req.salonId])).rows[0];
      const text = tpl.replaceAll('{nombre}', cur.client_name || '').replaceAll('{dias}', String(days)).replaceAll('{servicio}', cur.service_name || '').replaceAll('{salon}', salon?.name || '');
      let out = await sendWhatsAppMessage({ phone: cur.client_phone, content: text, channel: 'qr', salonId: req.salonId });
      if (!out.ok) {
        const meta = await getMetaConfig(req.salonId);
        if (meta.configured) out = await sendWhatsAppMessage({ phone: cur.client_phone, content: text, channel: 'meta', salonId: req.salonId });
      }
      if (!out.ok) return res.status(502).json({ error: 'No se pudo enviar por WhatsApp (ni QR ni Meta listos)' });
      await pool.query('UPDATE appointments SET reminded_retouch_at=NOW() WHERE id=$1', [req.params.id]);
      res.json({ success: true, sent: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Clientas inactivas (base para campañas 1 a 1, nunca masivas): sin cita
  // completada en los últimos N días (45 por defecto). No hay envío masivo
  // en esta versión: cada mensaje se manda desde el chat de la clienta.
  app.get('/api/salon/clients/inactive', requireSalon, async (req, res) => {
    try {
      const days = Math.min(365, Math.max(7, parseInt(req.query.days || '45', 10) || 45));
      const r = await pool.query(`
        SELECT c.phone, c.name, MAX(a.date) AS last_visit, COUNT(a.id) AS visits,
               (CURRENT_DATE - MAX(a.date)) AS days_since
        FROM salon_clients c LEFT JOIN appointments a ON a.client_phone = c.phone AND a.salon_id = c.salon_id AND a.status = 'completada'
        WHERE c.salon_id = $1
        GROUP BY c.phone, c.name
        HAVING MAX(a.date) IS NULL OR MAX(a.date) <= CURRENT_DATE - ($2 * INTERVAL '1 day')
        ORDER BY last_visit ASC NULLS FIRST LIMIT 200`, [req.salonId, days]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Marcar no-show: anticipo retenido (sin reembolso) + lista de espera.
  // AUDITORÍA v1.1: guarda de estado + todo el grupo.
  app.post('/api/salon/appointments/:id/no-show', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      if (['completada', 'cancelada', 'no-show'].includes(cur.status)) return res.status(400).json({ error: `La cita ya está ${cur.status}` });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const where = cur.group_id ? 'group_id=$1 AND salon_id=$2' : 'id=$1 AND salon_id=$2';
        const r = await client.query(
          `UPDATE appointments SET status='no-show', deposit_status=CASE WHEN deposit_amount>0 THEN 'retenido' ELSE deposit_status END, deposit_refund_amount=0
           WHERE ${where} RETURNING *`, [cur.group_id || req.params.id, req.salonId]);
        await client.query('COMMIT');
        await notifyWaitlist(req.salonId, cur);
        res.json(mapAppt(r.rows[0]));
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Anticipo: registrar pago manual (Nequi / Daviplata / Bre-B-Llave Nu /
  // transferencia banco / efectivo, métodos separados v1.2) o
  // generar link Wompi/PayU. Al pagarse, la cita queda confirmada.
  // AUDITORÍA v1.1: solo citas abiertas; método contra POS_METHODS; el
  // anticipo no se puede pagar de más; marca TODO el grupo.
  app.post('/api/salon/appointments/:id/deposit', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const { method, reference, amount } = req.body || {};
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      if (['completada', 'cancelada', 'no-show'].includes(cur.status)) return res.status(400).json({ error: `La cita ya está ${cur.status}: no se puede cobrar anticipo` });
      if (num(cur.deposit_amount) <= 0) return res.status(400).json({ error: 'Este servicio no pide anticipo' });
      if (cur.deposit_status === 'pagado') return res.status(400).json({ error: 'El anticipo ya está pagado' });
      const normMethod = method ? normalizePaymentMethod(method) : null;
      if (method && !normMethod) return res.status(400).json({ error: `Método no válido: ${method}` });
      const paid = amount != null ? money(amount) : money(cur.deposit_amount);
      if (paid < money(cur.deposit_amount)) return res.status(400).json({ error: `El anticipo es de $${money(cur.deposit_amount).toLocaleString('es-CO')}` });
      if (paid > money(cur.deposit_amount)) return res.status(400).json({ error: `El anticipo es de $${money(cur.deposit_amount).toLocaleString('es-CO')} como máximo` });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const where = cur.group_id ? 'group_id=$1 AND salon_id=$2' : 'id=$1 AND salon_id=$2';
        const r = await client.query(
          `UPDATE appointments SET deposit_status='pagado', status=CASE WHEN status='pendiente' THEN 'confirmada' ELSE status END,
           confirmation_status='confirmada' WHERE ${where} RETURNING *`,
          [cur.group_id || req.params.id, req.salonId]);
        // El anticipo queda como abono en caja (pos_sales, sin factura aún).
        // No se crea fila en payments: esa tabla es de abonos a facturas.
        await client.query(
          `INSERT INTO pos_sales (salon_id, appointment_id, professional_id, client_phone, client_name, items, subtotal, discount, tip_amount, total, payment_methods, document_type, dian_transmitted, cashier_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$7,$8,'anticipo',false,$9)`,
          [req.salonId, cur.id, cur.professional_id, cur.client_phone, cur.client_name,
           JSON.stringify([{ name: `Anticipo: ${cur.service_name}`, qty: 1, price: paid }]), paid,
           JSON.stringify([{ method: normMethod || 'nequi', amount: paid, reference: cleanPaymentReference(reference) }]), String(req.user.id)]);
        await client.query('COMMIT');
        res.json({ appointment: mapAppt(r.rows[0]), depositPaid: paid });
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/appointments/:id/deposit-link', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const { provider } = req.body || {};
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      const amount = money(cur.deposit_amount);
      // v1.3 (anticipo opcional): sin anticipo no hay link que generar.
      if (amount <= 0) return res.status(400).json({ error: 'Este servicio no pide anticipo' });
      const reference = `ANT-${cur.id}`;
      const link = await buildDepositLink(provider, amount, reference, cur.service_name, cur.client_name);
      if (link.error) return res.status(400).json({ error: link.error });
      res.json({ paymentUrl: link.paymentUrl, provider, reference, amount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Completar cita: cobra en caja + comisión congelada + descuento de insumos.
  // AUDITORÍA v1.1 (antes: doble cobro): el anticipo ya pagado SE
  // DESCUENTA — la clienta paga solo el resto (total+propina-anticipo).
  // La venta de caja registra ese resto, así el cierre cuadra: anticipos
  // + restos = lo cobrado en el día. Completa TODO el grupo de 4 manos
  // (una sola venta, comisión por profesional con su % congelado). No se
  // puede completar una cita cancelada/no-show, ni con precio inflado.
  app.post('/api/salon/appointments/:id/complete', requireSalon, async (req, res) => {
    try {
      const b = req.body || {};
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      if (ownOnly(req) && !(cur.professional_ids || []).map(String).includes(String(req.user.id))) return res.status(403).json({ error: 'Esa cita no es tuya' });
      if (cur.status === 'completada') return res.status(400).json({ error: 'La cita ya está completada' });
      if (['cancelada', 'no-show'].includes(cur.status)) return res.status(400).json({ error: `La cita está ${cur.status}: no se puede completar` });
      const salon = await getSalon(pool, req.salonId);
      const svc = (await pool.query('SELECT price FROM salon_services WHERE id=$1 AND salon_id=$2', [cur.service_id, req.salonId])).rows[0];
      const catalogPrice = num(svc?.price ?? cur.price);
      const price = b.price != null ? Math.min(Math.max(0, money(b.price)), catalogPrice) : money(cur.price);
      const discount = Math.max(0, money(b.discount ?? cur.discount ?? 0));
      const tip = Math.max(0, money(b.tip ?? 0));
      const supplies = Math.max(0, money(b.suppliesCost ?? cur.supplies_cost ?? 0));
      const total = money(Math.max(0, price - discount));
      const depositPaid = cur.deposit_status === 'pagado' ? money(cur.deposit_amount) : 0;
      const remaining = money(Math.max(0, total + tip - depositPaid));
      // v1.2: pago mixto con métodos exactos y montos validados en el
      // servidor (resolvePayments). El resto es total + propina - anticipo
      // ya pagado; un null solo cobra ese resto, nunca el total completo.
      let payments;
      try {
        const rawPayments = Array.isArray(b.payments) && b.payments.length ? b.payments
          : (remaining > 0 ? [{ method: b.paymentMethod || 'efectivo', amount: null, reference: b.reference || null }] : []);
        payments = resolvePayments(rawPayments, remaining);
      } catch (e) { return res.status(400).json({ error: e.message }); }
      const doc = requiredDocument(total, b.clientNit, b.wantsInvoice === true);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const rows = await groupRows(client, req.salonId, cur);
        let totalCommission = 0;
        for (const row of rows) {
          const base = salon.commission_after_supplies !== false ? Math.max(0, price - discount - supplies) : Math.max(0, price - discount);
          const commission = money(base * num(row.commission_pct_frozen) / 100);
          totalCommission = money(totalCommission + commission);
          await client.query(
            `UPDATE appointments SET status='completada', completed_at=NOW(), price=$1, discount=$2, tip=$3, supplies_cost=$4, commission_amount=$5
             WHERE id=$6 AND salon_id=$7`,
            [price, discount, tip, supplies, commission, row.id, req.salonId]);
        }
        const first = rows[0];
        const sale = await client.query(
          `INSERT INTO pos_sales (salon_id, appointment_id, professional_id, client_phone, client_name, items, subtotal, discount, tip_amount, total, payment_methods, document_type, dian_transmitted, cashier_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13) RETURNING *`,
          [req.salonId, cur.id, first.professional_id, cur.client_phone, cur.client_name,
           JSON.stringify([{ name: cur.service_name, qty: 1, price }]), price, discount, tip, remaining,
           JSON.stringify(payments), doc.type, String(req.user.id)]);
        if (Array.isArray(b.consumedProducts)) {
          for (const c of b.consumedProducts) {
            const qty = Number(c.qty) || 0;
            if (qty < 0) throw Object.assign(new Error('La cantidad consumida no puede ser negativa'), { status: 400 });
            await client.query('UPDATE salon_products SET stock = GREATEST(0, stock - $1) WHERE id=$2 AND salon_id=$3', [qty, c.productId, req.salonId]);
          }
        }
        await client.query('COMMIT');
        const upd = (await pool.query('SELECT * FROM appointments WHERE id=$1', [cur.id])).rows[0];
        res.json({ appointment: mapAppt(upd), sale: sale.rows[0], commission: totalCommission, depositPaid, remaining, document: doc, note: doc.type === 'factura_electronica_plena' ? 'Se requiere factura electrónica plena: genera el export DIAN-ready y emítela con tu proveedor certificado. Este sistema NO transmite a la DIAN.' : 'Documento equivalente POS (tiquete): este sistema NO transmite DEE POS a la DIAN todavía (pendiente v1.1).' });
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // Recordatorio manual de una cita.
  app.post('/api/salon/appointments/:id/remind', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const cur = (await pool.query('SELECT * FROM appointments WHERE id=$1 AND salon_id=$2', [req.params.id, req.salonId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cita no encontrada en este salón' });
      const salon = await getSalon(pool, req.salonId);
      const kind = req.body.kind === 'reminder2h' ? 'reminder2h' : 'reminder24';
      const r = await sendSalonWhatsApp(req.salonId, cur.client_phone, apptMessage(salon, cur, kind));
      if (r.ok) await pool.query(`UPDATE appointments SET ${kind === 'reminder2h' ? 'reminded_2h_at' : 'reminded_24h_at'}=NOW() WHERE id=$1`, [req.params.id]);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Lista de espera: avisar al primero cuando se libera un cupo.
  async function notifyWaitlist(salonId, appt) {
    try {
      const w = await pool.query(
        `SELECT * FROM waitlist WHERE salon_id=$1 AND service_id=$2 AND status='esperando' AND (professional_id IS NULL OR professional_id=$3) ORDER BY created_at ASC LIMIT 1`,
        [salonId, appt.service_id, appt.professional_id]);
      if (!w.rows[0]) return null;
      const salon = await getSalon(pool, salonId);
      const r = await sendSalonWhatsApp(salonId, w.rows[0].client_phone, apptMessage(salon, { ...appt, client_name: w.rows[0].client_name }, 'waitlist'));
      await pool.query("UPDATE waitlist SET status='avisado', notified_at=NOW() WHERE id=$1", [w.rows[0].id]);
      return r;
    } catch (e) { logger && logger.error('Lista de espera', e); return null; }
  }
  app.get('/api/salon/waitlist', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM waitlist WHERE salon_id=$1 ORDER BY created_at DESC LIMIT 200', [req.salonId]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/waitlist', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.serviceId || !b.clientPhone) return res.status(400).json({ error: 'Servicio y teléfono son obligatorios' });
      const r = await pool.query(
        `INSERT INTO waitlist (salon_id, service_id, professional_id, client_phone, client_name, date_wanted, status) VALUES ($1,$2,$3,$4,$5,$6,'esperando') RETURNING *`,
        [req.salonId, b.serviceId, b.professionalId || null, normalizePhoneString(b.clientPhone), b.clientName || null, b.dateWanted || null]);
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Recordatorios vencidos: citas en 24 h sin recordatorio, y en 2 h.
  // Se dispara con un cron externo simple (curl cada 30 min) o a mano:
  //   curl -X POST /api/salon/reminders/send-due -H "Authorization: Bearer <token>"
  app.get('/api/salon/reminders/due', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT * FROM appointments WHERE salon_id=$1 AND status IN ('pendiente','confirmada')
         AND ((date=CURRENT_DATE+1 AND reminded_24h_at IS NULL) OR (date=CURRENT_DATE AND start_time >= (NOW() - INTERVAL '15 minutes')::time AND start_time <= (NOW() + INTERVAL '2 hours')::time AND reminded_2h_at IS NULL))
         ORDER BY date, start_time`, [req.salonId]);
      res.json(r.rows.map(mapAppt));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/reminders/send-due', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const salon = await getSalon(pool, req.salonId);
      const r = await pool.query(
        `SELECT * FROM appointments WHERE salon_id=$1 AND status IN ('pendiente','confirmada')
         AND ((date=CURRENT_DATE+1 AND reminded_24h_at IS NULL) OR (date=CURRENT_DATE AND start_time >= (NOW() - INTERVAL '15 minutes')::time AND start_time <= (NOW() + INTERVAL '2 hours')::time AND reminded_2h_at IS NULL))
         ORDER BY date, start_time`, [req.salonId]);
      let sent = 0, queued = 0, failed = 0;
      for (const a of r.rows) {
        const is2h = dateStr(a.date) === todayStr();
        const res2 = await sendSalonWhatsApp(req.salonId, a.client_phone, apptMessage(salon, a, is2h ? 'reminder2h' : 'reminder24'));
        if (res2.ok) { sent++; await pool.query(`UPDATE appointments SET ${is2h ? 'reminded_2h_at' : 'reminded_24h_at'}=NOW() WHERE id=$1`, [a.id]); }
        else if (res2.channel === 'cola') queued++; else failed++;
      }
      res.json({ total: r.rows.length, sent, queued, failed });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= CLIENTES / FICHA (mejora 6: Ley 1581) =================
  app.get('/api/salon/clients', requireSalon, async (req, res) => {
    try {
      const { search } = req.query;
      const params = [req.salonId];
      let q = 'SELECT * FROM salon_clients WHERE salon_id=$1';
      if (search) {
        const pats = [`%${search}%`];
        const { phone } = normalizePhoneCO(search);
        if (phone) { pats.push(`%${phone}%`, `%${phone.replace('+', '')}%`, `%${phone.slice(3)}%`); }
        params.push(pats);
        q += ` AND (name ILIKE ANY($${params.length}) OR phone ILIKE ANY($${params.length}))`;
      }
      q += ' ORDER BY name ASC LIMIT 200';
      const r = await pool.query(q, params);
      let rows = r.rows;
      if (ownOnly(req)) {
        const phones = await pool.query('SELECT DISTINCT client_phone FROM appointments WHERE salon_id=$1 AND professional_id=$2', [req.salonId, Number(req.user.id)]);
        const set = new Set(phones.rows.map((x) => x.client_phone));
        rows = rows.filter((x) => set.has(x.phone));
      }
      res.json(rows.map((x) => ({ id: x.id, salonId: x.salon_id, phone: x.phone, name: x.name, notes: x.notes, allergies: x.allergies, formula: x.formula, dataConsent: !!x.data_consent, dataConsentAt: x.data_consent_at, createdAt: x.created_at })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/salon/clients/:phone', requireSalon, async (req, res) => {
    try {
      const phone = normalizePhoneString(req.params.phone);
      const c = (await pool.query('SELECT * FROM salon_clients WHERE salon_id=$1 AND phone=$2', [req.salonId, phone])).rows[0];
      if (!c) return res.status(404).json({ error: 'Clienta no encontrada en este salón' });
      if (ownOnly(req)) {
        const has = await pool.query('SELECT 1 FROM appointments WHERE salon_id=$1 AND client_phone=$2 AND professional_id=$3 LIMIT 1', [req.salonId, phone, Number(req.user.id)]);
        if (!has.rows[0]) return res.status(403).json({ error: 'Esa clienta no es tuya' });
      }
      const appts = await pool.query('SELECT * FROM appointments WHERE salon_id=$1 AND client_phone=$2 ORDER BY date DESC, start_time DESC LIMIT 100', [req.salonId, phone]);
      const sales = await pool.query('SELECT COALESCE(SUM(total),0) AS spent, COUNT(*)::int AS sales FROM pos_sales WHERE salon_id=$1 AND client_phone=$2', [req.salonId, phone]);
      const next = await pool.query("SELECT * FROM appointments WHERE salon_id=$1 AND client_phone=$2 AND status IN ('pendiente','confirmada') AND date >= CURRENT_DATE ORDER BY date ASC, start_time ASC LIMIT 1", [req.salonId, phone]);
      res.json({ client: { id: c.id, phone: c.phone, name: c.name, notes: c.notes, allergies: c.allergies, formula: c.formula, dataConsent: !!c.data_consent, dataConsentAt: c.data_consent_at }, history: appts.rows.map(mapAppt), totalSpent: num(sales.rows[0]?.spent), totalSales: num(sales.rows[0]?.sales), nextAppointment: next.rows[0] ? mapAppt(next.rows[0]) : null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/clients', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.phone) return res.status(400).json({ error: 'El teléfono es obligatorio' });
      const c = await upsertSalonClient(pool, req.salonId, b.phone, b.name, { notes: b.notes, allergies: b.allergies, formula: b.formula, dataConsent: b.dataConsent === true, dataConsentText: b.dataConsent === true ? 'Autorizo el tratamiento de mis datos para gestionar mis citas (Ley 1581 de 2012).' : null });
      res.status(201).json(c);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/salon/clients/:phone', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const phone = normalizePhoneString(req.params.phone);
      const b = req.body || {};
      const r = await pool.query(
        `UPDATE salon_clients SET name=COALESCE($1,name), notes=COALESCE($2,notes), allergies=COALESCE($3,allergies), formula=COALESCE($4,formula),
         data_consent=COALESCE($5,data_consent) WHERE salon_id=$6 AND phone=$7 RETURNING *`,
        [b.name, b.notes, b.allergies, b.formula, b.dataConsent, req.salonId, phone]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Clienta no encontrada en este salón' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= INVENTARIO (retail en v1; consumo en complete) =================
  app.get('/api/salon/products', requireSalon, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM salon_products WHERE salon_id=$1 ORDER BY category, name', [req.salonId]);
      res.json(r.rows.map((x) => ({ id: x.id, salonId: x.salon_id, name: x.name, category: x.category, stock: num(x.stock), minStock: num(x.min_stock), cost: num(x.cost), price: num(x.price), barcode: x.barcode, active: !!x.active, lowStock: num(x.stock) <= num(x.min_stock) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/salon/products/alerts', requireSalon, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM salon_products WHERE salon_id=$1 AND active=true AND stock <= min_stock ORDER BY stock ASC', [req.salonId]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/products', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ error: 'El nombre es obligatorio' });
      const r = await pool.query(
        `INSERT INTO salon_products (salon_id, name, category, stock, min_stock, cost, price, barcode, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING *`,
        [req.salonId, String(b.name).trim(), b.category || 'general', Number(b.stock || 0), Number(b.minStock ?? 2), Number(b.cost || 0), Number(b.price || 0), b.barcode || null]);
      res.status(201).json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/salon/products/:id', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await pool.query(
        `UPDATE salon_products SET name=COALESCE($1,name), category=COALESCE($2,category), stock=COALESCE($3,stock), min_stock=COALESCE($4,min_stock),
         cost=COALESCE($5,cost), price=COALESCE($6,price), barcode=COALESCE($7,barcode), active=COALESCE($8,active)
         WHERE id=$9 AND salon_id=$10 RETURNING *`,
        [b.name, b.category, b.stock, b.minStock, b.cost, b.price, b.barcode, b.active, req.params.id, req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Producto no encontrado en este salón' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // AUDITORÍA v1.1: no existía DELETE de producto (el frontend lo pedía).
  // Se desactiva (no se borra el historial de ventas que lo referencia).
  app.delete('/api/salon/products/:id', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const r = await pool.query('UPDATE salon_products SET active=false WHERE id=$1 AND salon_id=$2 RETURNING *', [req.params.id, req.salonId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Producto no encontrado en este salón' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= POS / CAJA (mejora 4) =================
  // Venta de mostrador (retail) con pago mixto. Los totales se calculan
  // en el servidor a partir de los productos del salón, nunca del total
  // que manda el frontend.
  app.post('/api/salon/pos/sale', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const b = req.body || {};
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) return res.status(400).json({ error: 'La venta necesita al menos un producto' });
      const rawPayments = Array.isArray(b.payments) && b.payments.length ? b.payments : [{ method: b.paymentMethod || 'efectivo', amount: null, reference: b.reference || null }];
      for (const p of rawPayments) if (!normalizePaymentMethod(p.method)) return res.status(400).json({ error: `Método no válido: ${p.method}` });
      const discount = money(b.discount || 0);
      const tip = money(b.tip || 0);
      const tipProfessionalId = b.tipProfessionalId ? Number(b.tipProfessionalId) : null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let subtotal = 0;
        const lines = [];
        for (const it of items) {
          const prod = (await client.query('SELECT * FROM salon_products WHERE id=$1 AND salon_id=$2 AND active=true FOR UPDATE', [it.productId, req.salonId])).rows[0];
          if (!prod) throw Object.assign(new Error(`Producto no encontrado: ${it.productId}`), { status: 404 });
          const qty = Number(it.qty) || 0;
          if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error(`Cantidad no válida para ${prod.name}`), { status: 400 });
          if (num(prod.stock) < qty) throw Object.assign(new Error(`Sin stock suficiente de ${prod.name} (quedan ${prod.stock})`), { status: 409 });
          subtotal += num(prod.price) * qty;
          lines.push({ productId: prod.id, name: prod.name, qty, price: num(prod.price) });
          await client.query('UPDATE salon_products SET stock = stock - $1 WHERE id=$2', [qty, prod.id]);
        }
        const total = money(Math.max(0, subtotal - discount));
        // v1.2: un solo null cobra el resto; dos nulls o suma distinta = 400.
        // Antes cada null se convertía en total+propina (bug R9 de v1.1).
        let finalPayments;
        try { finalPayments = resolvePayments(rawPayments, money(total + tip)); }
        catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
        const doc = requiredDocument(total, b.clientNit, b.wantsInvoice === true);
        const sale = await client.query(
          `INSERT INTO pos_sales (salon_id, appointment_id, professional_id, client_phone, client_name, items, subtotal, discount, tip_amount, tip_professional_id, total, payment_methods, document_type, dian_transmitted, cashier_id)
           VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13) RETURNING *`,
          [req.salonId, tipProfessionalId, b.clientPhone ? normalizePhoneString(b.clientPhone) : null, b.clientName || null,
           JSON.stringify(lines), money(subtotal), discount, tip, tipProfessionalId, total, JSON.stringify(finalPayments), doc.type, String(req.user.id)]);
        await client.query('COMMIT');
        res.status(201).json({ sale: sale.rows[0], document: doc, note: 'Documento generado como tiquete/factura interna. NO se transmitió nada a la DIAN (pendiente v1.1: integración con proveedor certificado).' });
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  // v1.2: métodos de pago canónicos con etiquetas y mapeo de viejos.
  // El frontend los lee de aquí; si mañana se añade un método, se añade
  // en un solo lugar (POS_METHODS arriba + lib/paymentMethods.ts).
  app.get('/api/salon/pos/payment-methods', requireSalon, async (req, res) => {
    res.json({ methods: POS_METHODS, labels: PAYMENT_METHOD_LABELS, manualMethods: MANUAL_PAYMENT_METHODS, legacyMap: LEGACY_PAYMENT_METHODS, note: 'El pago directo por Nequi / Daviplata / Bre-B-Llave Nu en el salón es manual: se marca como recibido en caja, no se auto-confirma. Wompi/PayU solo se confirman por webhook.' });
  });
  app.get('/api/salon/pos/sales', requireSalon, async (req, res) => {
    try {
      const date = req.query.date || todayStr();
      const params = [req.salonId, date];
      let q = 'SELECT * FROM pos_sales WHERE salon_id=$1 AND created_at::date=$2';
      if (ownOnly(req)) { params.push(Number(req.user.id)); q += ` AND professional_id=$${params.length}`; }
      q += ' ORDER BY created_at DESC LIMIT 300';
      const r = await pool.query(q, params);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Cierre de caja por día y por salón, con totales POR MÉTODO sacados de
  // la base (payment_methods es JSONB; se agregan en el servidor).
  app.get('/api/salon/pos/cash-close', requireSalon, async (req, res) => {
    try {
      const date = req.query.date || todayStr();
      const params = [req.salonId, date];
      let q = 'SELECT * FROM pos_sales WHERE salon_id=$1 AND created_at::date=$2';
      if (ownOnly(req)) { params.push(Number(req.user.id)); q += ` AND professional_id=$${params.length}`; }
      const r = await pool.query(q, params);
      // v1.2: los 9 métodos siempre presentes (0 si no hubo ventas con ese
      // método). Los pagos viejos se normalizan: "transferencia" suma en
      // transferencia_banco y "bre-b" en breb_nu (Bre-B / Llave Nu), sin
      // reescribir la base. Así la llave Nu nunca se mezcla con el banco.
      const byMethod = Object.fromEntries(POS_METHODS.map((m) => [m, 0]));
      let total = 0, tips = 0, discounts = 0, count = 0, depositTotal = 0;
      for (const s of r.rows) {
        count++; total += num(s.total); tips += num(s.tip_amount); discounts += num(s.discount);
        if (s.document_type === 'anticipo') depositTotal += num(s.total);
        const pays = Array.isArray(s.payment_methods) ? s.payment_methods : [];
        for (const p of pays) {
          const m = normalizePaymentMethod(p.method) || p.method;
          byMethod[m] = money((byMethod[m] || 0) + num(p.amount));
        }
      }
      for (const m of Object.keys(byMethod)) byMethod[m] = money(byMethod[m]);
      const byMethodSum = money(Object.values(byMethod).reduce((a, v) => a + num(v), 0));
      // AUDITORÍA v1.1: byMethod suma los pagos (incluyen propina); total
      // es el neto de ventas sin propina. collected = total + tips debe
      // ser igual a la suma por método: si no, la caja no cuadra.
      res.json({ date, salonId: req.salonId, salesCount: count, total: money(total), tips: money(tips), discounts: money(discounts), depositTotal: money(depositTotal), byMethod, labels: PAYMENT_METHOD_LABELS, collected: money(total + tips), byMethodSum, note: 'Totales calculados en el servidor sobre todas las ventas del día. collected (total+propinas) debe ser igual a la suma por método. Bre-B / Llave Nu es un método aparte de Transferencia banco.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= LIQUIDACIÓN DE COMISIONES (mejora 5) =================
  // La comisión de cada cita quedó CONGELADA al agendar (commission_pct_frozen
  // y commission_amount al completar). La liquidación solo SUMA lo guardado:
  // si mañana cambia el % del catálogo, las citas viejas no se reescriben.
  app.get('/api/salon/liquidations', requireSalon, async (req, res) => {
    try {
      const { professionalId, from, to } = req.query;
      const proId = ownOnly(req) ? Number(req.user.id) : (professionalId ? Number(professionalId) : null);
      const params = [req.salonId];
      const clauses = [`salon_id=$1`, `status='completada'`];
      if (from) { params.push(from); clauses.push(`date >= $${params.length}`); }
      if (to) { params.push(to); clauses.push(`date <= $${params.length}`); }
      if (proId) { params.push(proId); clauses.push(`professional_id=$${params.length}`); }
      const r = await pool.query(
        `SELECT professional_id, professional_name, COUNT(*)::int AS appointments,
         COALESCE(SUM(price),0) AS gross, COALESCE(SUM(discount),0) AS discounts,
         COALESCE(SUM(supplies_cost),0) AS supplies, COALESCE(SUM(commission_amount),0) AS commission,
         COALESCE(SUM(tip),0) AS tips
         FROM appointments WHERE ${clauses.join(' AND ')} GROUP BY professional_id, professional_name ORDER BY professional_name`,
        params);
      // AUDITORÍA v1.1: cada fila de un grupo a 4 manos guarda el precio
      // completo; SUM(price) contaba el mismo servicio 2 veces. El bruto
      // se toma de una sola fila por grupo (la primera).
      const grossRows = await pool.query(
        `SELECT professional_id, COALESCE(SUM(price),0) AS gross FROM (SELECT DISTINCT ON (group_id) * FROM appointments WHERE ${clauses.join(' AND ')} ORDER BY group_id, id) g GROUP BY professional_id`,
        params);
      const grossByPro = Object.fromEntries(grossRows.rows.map((x) => [x.professional_id, num(x.gross)]));
      const lines = [];
      for (const row of r.rows) {
        const detParams = [req.salonId, row.professional_id];
        let detQ = `SELECT * FROM appointments WHERE salon_id=$1 AND professional_id=$2 AND status='completada'`;
        if (from) { detParams.push(from); detQ += ` AND date >= $${detParams.length}`; }
        if (to) { detParams.push(to); detQ += ` AND date <= $${detParams.length}`; }
        detQ += ' ORDER BY date, start_time';
        const det = await pool.query(detQ, detParams);
        lines.push({
          professionalId: row.professional_id, professionalName: row.professional_name,
          appointments: num(row.appointments), gross: money(grossByPro[row.professional_id] ?? row.gross), discounts: money(row.discounts),
          supplies: money(row.supplies), commission: money(row.commission), tips: money(row.tips),
          salonKeeps: money(num(row.gross) - num(row.discounts) - num(row.supplies) - num(row.commission)),
          totalToPay: money(num(row.commission) + num(row.tips)),
          detail: det.rows.map((a) => ({ id: a.id, date: dateStr(a.date), service: a.service_name, client: a.client_name, price: num(a.price), discount: num(a.discount), supplies: num(a.supplies_cost), commissionPctFrozen: num(a.commission_pct_frozen), commission: num(a.commission_amount), tip: num(a.tip) })),
        });
      }
      res.json({ from: from || null, to: to || null, professionals: lines, totals: { gross: money(lines.reduce((a, x) => a + x.gross, 0)), commission: money(lines.reduce((a, x) => a + x.commission, 0)), tips: money(lines.reduce((a, x) => a + x.tips, 0)), totalToPay: money(lines.reduce((a, x) => a + x.totalToPay, 0)) }, note: 'Comisión por cita con el % congelado al agendar. Propinas 100 % para la profesional.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= DASHBOARD DEL SALÓN =================
  app.get('/api/salon/dashboard', requireSalon, async (req, res) => {
    try {
      const date = todayStr();
      const proId = ownOnly(req) ? Number(req.user.id) : null;
      const [today, salesDay, salesMonth, topServices, newClients, lowStock] = await Promise.all([
        pool.query(`SELECT status, COUNT(*)::int AS n FROM appointments WHERE salon_id=$1 AND date=$2 ${proId ? 'AND $3 = ANY(professional_ids)' : ''} GROUP BY status`, proId ? [req.salonId, date, proId] : [req.salonId, date]).catch(() => ({ rows: [] })),
        pool.query(proId ? 'SELECT COALESCE(SUM(total),0) AS t, COUNT(*)::int AS n FROM pos_sales WHERE salon_id=$1 AND created_at::date=CURRENT_DATE AND professional_id=$2' : 'SELECT COALESCE(SUM(total),0) AS t, COUNT(*)::int AS n FROM pos_sales WHERE salon_id=$1 AND created_at::date=CURRENT_DATE', proId ? [req.salonId, proId] : [req.salonId]),
        pool.query(proId ? 'SELECT COALESCE(SUM(total),0) AS t, COUNT(*)::int AS n FROM pos_sales WHERE salon_id=$1 AND professional_id=$2 AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM CURRENT_DATE)' : 'SELECT COALESCE(SUM(total),0) AS t, COUNT(*)::int AS n FROM pos_sales WHERE salon_id=$1 AND EXTRACT(MONTH FROM created_at)=EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM CURRENT_DATE)', proId ? [req.salonId, proId] : [req.salonId]),
        pool.query(`SELECT service_name, COUNT(*)::int AS n, COALESCE(SUM(price),0) AS total FROM appointments WHERE salon_id=$1 AND status='completada' AND date >= CURRENT_DATE - INTERVAL '30 days' ${proId ? 'AND professional_id=$2' : ''} GROUP BY service_name ORDER BY n DESC LIMIT 5`, proId ? [req.salonId, proId] : [req.salonId]),
        pool.query('SELECT COUNT(*)::int AS n FROM salon_clients WHERE salon_id=$1 AND created_at >= DATE_TRUNC(\'month\', CURRENT_DATE)', [req.salonId]),
        pool.query('SELECT COUNT(*)::int AS n FROM salon_products WHERE salon_id=$1 AND active=true AND stock <= min_stock', [req.salonId]),
      ]);
      const byStatus = {};
      for (const r of today.rows) byStatus[r.status] = num(r.n);
      res.json({
        date, scope: { role: roleOf(req), professionalId: proId },
        appointmentsToday: byStatus, appointmentsTodayTotal: Object.values(byStatus).reduce((a, b) => a + b, 0),
        salesToday: { total: money(salesDay.rows[0]?.t), count: num(salesDay.rows[0]?.n) },
        salesMonth: { total: money(salesMonth.rows[0]?.t), count: num(salesMonth.rows[0]?.n) },
        topServices: topServices.rows.map((x) => ({ service: x.service_name, count: num(x.n), total: money(x.total) })),
        newClientsMonth: num(newClients.rows[0]?.n), lowStockCount: num(lowStock.rows[0]?.n),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ================= WHATSAPP POR SALÓN: config Meta + cola =================
  app.post('/api/salon/wa/meta-config', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const { token, phoneNumberId } = req.body || {};
      if (token) await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`salon_${req.salonId}_meta_wa_token`, String(token)]);
      if (phoneNumberId) {
        if (!/^\d+$/.test(String(phoneNumberId).trim())) return res.status(400).json({ error: 'El phone number id debe ser solo dígitos' });
        await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`salon_${req.salonId}_meta_wa_phone_number_id`, String(phoneNumberId).trim()]);
      }
      res.json({ success: true, configured: true, note: 'El token nunca se devuelve al frontend.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // ================= BOT DE RESERVAS POR WHATSAPP v1.1 =================
  // Interruptor por salón (APAGADO por defecto en salones nuevos). El cambio
  // tiene efecto inmediato, sin reiniciar el servidor: el motor lee
  // salons.bot_enabled en cada mensaje. Queda auditado quién/cuándo lo cambió.
  app.get('/api/salon/bot/status', requireSalon, async (req, res) => {
    try {
      const r = await pool.query('SELECT bot_enabled, bot_enabled_changed_by, bot_enabled_changed_at FROM salons WHERE id=$1', [req.salonId]);
      res.json({ enabled: !!r.rows[0]?.bot_enabled, changedBy: r.rows[0]?.bot_enabled_changed_by || null, changedAt: r.rows[0]?.bot_enabled_changed_at || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/bot/toggle', requireSalon, requireSalonAdmin, async (req, res) => {
    try {
      const enabled = (req.body || {}).enabled === true;
      const r = await pool.query(
        'UPDATE salons SET bot_enabled=$1, bot_enabled_changed_by=$2, bot_enabled_changed_at=NOW() WHERE id=$3 RETURNING bot_enabled, bot_enabled_changed_by, bot_enabled_changed_at',
        [enabled, req.user?.email || req.user?.name || 'admin', req.salonId]);
      await recordEvent('info', 'bot', `Bot de reservas ${enabled ? 'ENCENDIDO' : 'APAGADO'} en el salón ${req.salonId} por ${req.user?.email || 'admin'}`, { salon_id: req.salonId, enabled });
      res.json({ enabled: !!r.rows[0]?.bot_enabled, changedBy: r.rows[0]?.bot_enabled_changed_by || null, changedAt: r.rows[0]?.bot_enabled_changed_at || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // El superadmin también puede encender/apagar el bot de cualquier salón.
  app.post('/api/salons/:id/bot', requireSuperadmin, async (req, res) => {
    try {
      const enabled = (req.body || {}).enabled === true;
      const r = await pool.query(
        'UPDATE salons SET bot_enabled=$1, bot_enabled_changed_by=$2, bot_enabled_changed_at=NOW() WHERE id=$3 RETURNING bot_enabled',
        [enabled, req.user?.email || 'superadmin', req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Salón no encontrado' });
      await recordEvent('info', 'bot', `Bot de reservas ${enabled ? 'ENCENDIDO' : 'APAGADO'} en el salón ${req.params.id} por superadmin`, { salon_id: Number(req.params.id), enabled });
      res.json({ enabled: !!r.rows[0]?.bot_enabled });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Conversaciones activas con el bot (para ver a quién está atendiendo).
  app.get('/api/salon/bot/sessions', requireSalon, async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT client_phone, state, updated_at FROM wa_bot_sessions WHERE salon_id=$1 AND state NOT IN ('done') ORDER BY updated_at DESC LIMIT 50",
        [req.salonId]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Volver a encender el bot para una clienta que quedó en manos humanas
  // (borra su sesión: el próximo mensaje vuelve al menú del bot).
  app.post('/api/salon/bot/resume', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const phone = normalizePhoneString((req.body || {}).phone);
      if (!phone) return res.status(400).json({ error: 'Teléfono requerido' });
      await pool.query('DELETE FROM wa_bot_sessions WHERE salon_id=$1 AND client_phone=$2', [req.salonId, phone]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/salon/wa/flush', requireSalon, requireSalonStaff, async (req, res) => {
    try {
      const q = await pool.query("SELECT * FROM wa_queue WHERE salon_id=$1 AND status='pendiente' ORDER BY created_at ASC LIMIT 50", [req.salonId]);
      let sent = 0, failed = 0, skipped = 0;
      for (const m of q.rows) {
        // v1.3 (lección CRM en vivo): antes de reintentar, verifica si ya
        // salió (mismo contenido, misma conversación, enviado en los
        // últimos 10 min): si ya salió, no se manda dos veces.
        const digits = String(m.phone || '').replace(/\D/g, '');
        const dup = await pool.query("SELECT id FROM messages WHERE conversation_id=$1 AND sender='agent' AND content=$2 AND status='enviado' AND timestamp >= NOW() - INTERVAL '10 minutes' ORDER BY id DESC LIMIT 1", [`wa_${digits}`, m.content]);
        if (dup.rows[0]) {
          await pool.query("UPDATE wa_queue SET status='enviado', sent_at=NOW() WHERE id=$1", [m.id]);
          skipped++;
          continue;
        }
        const r = await sendWhatsAppMessage({ phone: m.phone, content: m.content, channel: 'qr', salonId: req.salonId });
        let ok = r.ok;
        if (!ok) {
          const meta = await getMetaConfig(req.salonId);
          if (meta.configured) ok = (await sendWhatsAppMessage({ phone: m.phone, content: m.content, channel: 'meta', salonId: req.salonId })).ok;
        }
        if (ok) {
          await pool.query("UPDATE wa_queue SET status='enviado', sent_at=NOW(), attempts=attempts+1 WHERE id=$1", [m.id]);
          sent++;
        } else {
          // v1.3: reintentos con tope (5): al quinto fallo queda 'fallido'
          // con el motivo, en vez de reintentarse para siempre a mano.
          const upd = await pool.query('UPDATE wa_queue SET attempts=attempts+1, last_error=$2 WHERE id=$1 RETURNING attempts', [m.id, (r.error || 'Error de envío')]);
          if ((upd.rows[0]?.attempts || 0) >= 5) await pool.query("UPDATE wa_queue SET status='fallido' WHERE id=$1", [m.id]);
          failed++;
        }
      }
      res.json({ total: q.rows.length, sent, failed, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/salon/wa/queue', requireSalon, async (req, res) => {
    try {
      const r = await pool.query("SELECT id, phone, LEFT(content, 120) AS content, status, attempts, last_error, created_at FROM wa_queue WHERE salon_id=$1 ORDER BY created_at DESC LIMIT 100", [req.salonId]);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API para el bot de reservas por WhatsApp (bot-engine.js): la misma
  // lógica de huecos, creación, cancelación y anticipo que la agenda web.
  return {
    bot: {
      computeSlots, createAppointmentTx, cancelAppointmentTx, rescheduleAppointmentTx,
      refundFor, notifyWaitlist, getSalon, buildDepositLink, mapAppt, depositFor,
    },
  };
}
