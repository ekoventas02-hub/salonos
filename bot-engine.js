// Bot de reservas por WhatsApp de SalonOS v1.1 — motor por reglas/menú, sin IA externa.
// Un solo motor para los dos canales que ya existen: QR (whatsapp-web.js) y
// Meta Cloud API (webhook). El salón se resuelve SIEMPRE por instancia/número
// (lo pasa quien llama a handleMessage), NUNCA por lo que diga la clienta.
// La creación de citas usa la misma transacción/trigger anti-cruce que la
// agenda web (ver bot-store.js -> salonApi.createAppointmentTx).
// Reglas de seguridad: no responde a grupos, estados ni mensajes propios
// (eso se filtra en server.js antes de llamar aquí); con el bot apagado hay
// CERO respuestas automáticas; máximo 3 intentos por paso y luego humano.

export function createBotEngine(deps) {
  const { store, send, logger } = deps;
  const log = logger || { info: () => {}, error: () => {}, warn: () => {} };

  const YES = new Set(['s', 'si', 'sí', 'yes', 'ok', 'confirmo', 'dale']);
  const NO = new Set(['n', 'no']);
  const HUMAN_RE = /(hablar con (una )?persona|persona|humano|asesor(a)?|operador|ayuda|que me atienda)/i;
  const MENU_RE = /^(men[uú]|inicio|hola|buenas|buenos d[ií]as|buenas tardes|buenas noches)\b/i;
  const BOOK_RE = /(reservar|reserva|agendar|cita|quiero (una )?cita|apartar)/i;
  const CANCEL_RE = /(cancelar|anular)/i;
  const RESCHED_RE = /(reprogramar|cambiar (la )?(cita|fecha|hora)|mover)/i;

  function normPhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 10 && digits.startsWith('3')) return `+57${digits}`;
    if (digits.length === 12 && digits.startsWith('57')) return `+57${digits.slice(2)}`;
    if (digits.length === 13 && digits.startsWith('57')) return `+${digits}`;
    return digits ? `+${digits}` : '';
  }

  function fmtMoney(v) { return '$' + (Number(v) || 0).toLocaleString('es-CO'); }
  function fmtDateLong(iso) {
    try {
      const d = new Date(`${iso}T12:00:00-05:00`);
      return d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' });
    } catch { return iso; }
  }
  function fmtDateShort(iso) {
    try {
      const d = new Date(`${iso}T12:00:00-05:00`);
      return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'America/Bogota' });
    } catch { return iso; }
  }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function addDays(iso, n) {
    const d = new Date(`${iso}T12:00:00-05:00`);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseDate(input) {
    const t = String(input || '').trim().toLowerCase();
    if (t === 'hoy') return todayStr();
    if (t === 'mañana' || t === 'manana') return addDays(todayStr(), 1);
    const m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (m) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : new Date().getFullYear();
      const iso = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
      const d = new Date(`${iso}T12:00:00-05:00`);
      if (Number.isNaN(d.getTime())) return null;
      return iso;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    return null;
  }
  function hoursUntil(date, start) {
    const at = new Date(`${date}T${String(start).slice(0, 5)}:00-05:00`).getTime();
    return (at - Date.now()) / (1000 * 60 * 60);
  }
  function refundNote(appt) {
    const h = hoursUntil(appt.date, appt.start_time || appt.startTime);
    const dep = Number(appt.deposit_amount ?? appt.depositAmount ?? 0);
    if (!dep) return '';
    if (h >= 48) return 'Cancelación gratuita: te reembolsamos el anticipo completo.';
    if (h >= 24) return 'Te reembolsamos el 50% del anticipo.';
    return 'Con menos de 24 h el anticipo no se reembolsa.';
  }
  function apptLine(a, i) {
    return `${i + 1}️⃣ ${fmtDateShort(a.date)} ${String(a.start_time || a.startTime).slice(0, 5)} · ${a.service_name || a.serviceName} · ${a.professional_name || a.professionalName || ''}`;
  }

  // v1.3 (lección CRM en vivo): un envío sin confirmación es "sin
  // confirmar", no "enviado". Antes say() tragaba el error y devolvía
  // replied:true aunque el mensaje nunca hubiera salido.
  async function say(ctx, text) {
    try {
      const r = await send({ phone: ctx.phone, content: text, channel: ctx.channel, instanceId: ctx.instanceId || null, salonId: ctx.salonId });
      if (r && r.ok === false) {
        log.error('Bot: el envío no se confirmó', r.error);
        return { replied: false, reply: text, error: r.error || 'Envío sin confirmar' };
      }
    } catch (e) {
      log.error('Bot: no se pudo enviar la respuesta', e);
      return { replied: false, reply: text, error: e.message };
    }
    return { replied: true, reply: text };
  }

  async function handover(ctx, session, reason) {
    session.state = 'human';
    session.data = { ...session.data, handoverReason: reason || null };
    session.attempts = 0;
    await store.saveSession(session);
    return say(ctx, 'Te paso con una persona del salón 👩‍💼. Te van a responder por aquí mismo.\nSi prefieres volver conmigo, escribe *bot*.');
  }

  async function invalid(ctx, session, retryText) {
    session.attempts = (session.attempts || 0) + 1;
    if (session.attempts >= 3) {
      await store.saveSession(session);
      return handover(ctx, session, 'max_intentos');
    }
    await store.saveSession(session);
    return say(ctx, retryText);
  }

  function menuText(salon) {
    return `Hola 👋 Soy el asistente de *${salon.name}*. ¿Qué quieres hacer?\n1️⃣ Reservar una cita\n2️⃣ Cancelar una cita\n3️⃣ Reprogramar una cita\n4️⃣ Hablar con una persona\nResponde con el número.`;
  }

  async function showServices(ctx, session, salon) {
    const services = await store.listServices(salon.id);
    const active = (services || []).filter((s) => s.active !== false);
    if (!active.length) {
      session.state = 'menu';
      await store.saveSession(session);
      return say(ctx, 'Este salón todavía no tiene servicios publicados. Escribe *persona* y te atiende alguien del salón.');
    }
    session.state = 'services';
    session.data = { ...session.data, services: active };
    session.attempts = 0;
    await store.saveSession(session);
    const lines = active.map((s, i) => `${i + 1}️⃣ ${s.name} — ${fmtMoney(s.price)} · ${s.duration_minutes || s.durationMinutes} min${Number(s.team_size || s.teamSize || 1) >= 2 ? ' 👥 (a 4 manos)' : ''}`).join('\n');
    return say(ctx, `¿Qué servicio quieres?\n${lines}\n0️⃣ Volver al menú`);
  }

  async function showProfessionals(ctx, session, salon) {
    const svc = session.data.service;
    const pros = await store.listProfessionals(salon.id, svc.id);
    session.state = 'professional';
    session.data = { ...session.data, professionals: pros || [] };
    session.attempts = 0;
    await store.saveSession(session);
    const lines = (pros || []).map((p, i) => `${i + 1}️⃣ ${p.name}`).join('\n');
    return say(ctx, `¿Con quién quieres el servicio *${svc.name}*?\n${lines}\n0️⃣ Primera disponible`);
  }

  async function askDate(ctx, session) {
    session.state = 'date';
    session.attempts = 0;
    await store.saveSession(session);
    return say(ctx, '¿Para qué día? Escríbelo así: *15/11* (o *15/11/2026*). También puedes escribir *hoy* o *mañana*.');
  }

  async function showSlots(ctx, session, salon, note) {
    const svc = session.data.service;
    const slots = await store.getSlots(salon.id, svc, session.data.professionalId || null, session.data.date);
    const list = Array.isArray(slots) ? slots : [];
    if (!list.length) {
      session.state = 'date';
      session.attempts = 0;
      await store.saveSession(session);
      return say(ctx, `${note ? note + '\n' : ''}No hay huecos libres el ${fmtDateLong(session.data.date)} 😔 ¿Pruebas otro día? Escríbelo así: *15/11*.`);
    }
    session.state = 'slots';
    session.data = { ...session.data, slots: list };
    session.attempts = 0;
    await store.saveSession(session);
    const lines = list.map((s, i) => {
      const who = s.professionalName || (s.professionals || []).map((p) => p.name).join(' y ') || '';
      return `${i + 1}️⃣ ${String(s.start).slice(0, 5)} - ${String(s.end).slice(0, 5)}${who ? ` · ${who}` : ''}`;
    }).join('\n');
    return say(ctx, `${note ? note + '\n' : ''}Huecos libres el ${fmtDateLong(session.data.date)}:\n${lines}\nResponde con el número del hueco.`);
  }

  async function askName(ctx, session) {
    session.state = 'name';
    session.attempts = 0;
    await store.saveSession(session);
    const known = session.data.knownName;
    if (known) return say(ctx, `Te tengo registrada como *${known}*. Responde *SÍ* para seguir con ese nombre, o escribe tu nombre.`);
    return say(ctx, '¿A nombre de quién es la cita?');
  }

  async function askPhone(ctx, session) {
    session.state = 'phone';
    session.attempts = 0;
    await store.saveSession(session);
    return say(ctx, `Tu número es ${ctx.phone} ¿está bien para confirmarte la cita? Responde *SÍ* o escribe otro número (ej: 300 123 4567).`);
  }

  async function askConfirm(ctx, session, salon) {
    session.state = 'confirm';
    session.attempts = 0;
    await store.saveSession(session);
    const d = session.data;
    const dep = d.deposit || { pct: 0, amount: 0 };
    const depLine = Number(dep.amount) > 0
      ? `\n🔒 Anticipo: ${fmtMoney(dep.amount)} (${dep.pct}%). Te mando el link de pago y la cita queda confirmada al pagarlo.`
      : '';
    return say(ctx, `¿Confirmamos así?\n💅 ${d.service.name}\n👩 ${d.professionalNames}\n📅 ${fmtDateLong(d.date)}\n🕐 ${String(d.start).slice(0, 5)} - ${String(d.end).slice(0, 5)}\n💰 ${fmtMoney(d.service.price)}${depLine}\nResponde *SÍ* para confirmar o *NO* para cancelar.`);
  }

  async function doCreate(ctx, session, salon) {
    const d = session.data;
    try {
      const r = await store.createAppointment({
        salonId: salon.id,
        service: d.service,
        professionalIds: d.professionalIds,
        date: d.date,
        startTime: d.start,
        clientName: d.clientName,
        clientPhone: d.clientPhone,
      });
      const appt = r.created[0];
      const dep = r.deposit || { pct: 0, amount: 0 };
      session.state = 'done';
      session.data = {};
      session.attempts = 0;
      await store.saveSession(session);
      if (Number(dep.amount) > 0) {
        const link = await store.depositLink({ appointmentId: appt.id, amount: dep.amount, serviceName: d.service.name, clientName: d.clientName });
        if (link?.paymentUrl) {
          return say(ctx, `¡Cita apartada! ✅\n💅 ${d.service.name} · 👩 ${d.professionalNames}\n📅 ${fmtDateLong(d.date)} · 🕐 ${String(d.start).slice(0, 5)}\n🔒 Falta el anticipo de ${fmtMoney(dep.amount)}. Págalo aquí y la cita queda confirmada:\n${link.paymentUrl}\nEn cuanto se confirme el pago te aviso por aquí.`);
        }
        return say(ctx, `¡Cita apartada! ✅\n💅 ${d.service.name} · 👩 ${d.professionalNames}\n📅 ${fmtDateLong(d.date)} · 🕐 ${String(d.start).slice(0, 5)}\n🔒 Falta el anticipo de ${fmtMoney(dep.amount)}. El salón te escribirá con el link de pago.`);
      }
      return say(ctx, `¡Listo! ✅ Tu cita está confirmada.\n💅 ${d.service.name} · 👩 ${d.professionalNames}\n📅 ${fmtDateLong(d.date)} · 🕐 ${String(d.start).slice(0, 5)}\nTe esperamos en ${salon.name}. Si necesitas cambiarla, escríbeme *cancelar* o *reprogramar*.`);
    } catch (e) {
      if (e?.status === 409 || /ocupado|ya no está libre/i.test(e?.message || '')) {
        return showSlots(ctx, session, salon, 'Ese hueco se acaba de ocupar 😔 Te muestro los que quedan libres:');
      }
      log.error('Bot: error creando la cita', e);
      session.state = 'menu';
      session.attempts = 0;
      await store.saveSession(session);
      return say(ctx, 'No pude crear la cita por un error del sistema. Escribe *persona* y te atiende alguien del salón.');
    }
  }

  async function showUpcoming(ctx, session, salon, nextState, title) {
    const list = await store.findUpcoming(salon.id, ctx.phone);
    if (!list.length) {
      session.state = 'menu';
      await store.saveSession(session);
      return say(ctx, `No tienes citas próximas en ${salon.name}. ¿Quieres reservar una? Escribe *reservar*.`);
    }
    session.state = nextState;
    session.data = { ...session.data, upcoming: list };
    session.attempts = 0;
    await store.saveSession(session);
    return say(ctx, `${title}\n${list.map((a, i) => apptLine(a, i)).join('\n')}\n0️⃣ Volver al menú`);
  }

  // Entrada principal. Devuelve { replied: boolean, reply?: string }.
  async function handleMessage(ctxIn) {
    const ctx = { ...ctxIn, phone: normPhone(ctxIn.phone) };
    const content = String(ctxIn.content || '').trim();
    if (!content || !ctx.salonId || !ctx.phone) return { replied: false };
    let salon;
    try { salon = await store.getSalon(ctx.salonId); } catch (e) { log.error('Bot: no se pudo leer el salón', e); return { replied: false }; }
    if (!salon) return { replied: false };
    // Bot apagado: CERO respuestas automáticas. El mensaje queda en el
    // inbox/cola sin contestar por el bot.
    if (!salon.bot_enabled) return { replied: false };

    let session = await store.getSession(ctx.salonId, ctx.phone);
    if (!session) session = { salon_id: ctx.salonId, client_phone: ctx.phone, state: 'menu', data: {}, attempts: 0 };
    const low = content.toLowerCase();

    // Pausado para humano: silencio, salvo que pida volver al bot.
    if (session.state === 'human') {
      if (/^(bot|asistente|volver|men[uú])\b/i.test(low)) {
        session.state = 'menu'; session.data = {}; session.attempts = 0;
        await store.saveSession(session);
        return say(ctx, menuText(salon));
      }
      return { replied: false };
    }
    // Conversación terminada (reserva/cancelación hecha): la próxima
    // palabra se interpreta como un menú nuevo (reservar, cancelar,
    // reprogramar o S/N a un recordatorio).
    if (session.state === 'done') { session.state = 'menu'; session.data = {}; session.attempts = 0; }

    // Pasar a humano (en cualquier paso).
    if (HUMAN_RE.test(low)) return handover(ctx, session, 'cliente_pidio_persona');
    // Volver al menú.
    if (MENU_RE.test(low) && session.state !== 'confirm' && session.state !== 'cancel-confirm' && session.state !== 'reschedule-confirm') {
      session.state = 'menu'; session.data = {}; session.attempts = 0;
      await store.saveSession(session);
      return say(ctx, menuText(salon));
    }

    const pick = (arr, raw) => {
      const n = Number(String(raw).trim());
      if (!Number.isInteger(n)) return null;
      return arr[n - 1] || null;
    };

    switch (session.state) {
      case 'menu': {
        if (low === '1' || BOOK_RE.test(low)) return showServices(ctx, session, salon);
        if (low === '2' || CANCEL_RE.test(low)) return showUpcoming(ctx, session, salon, 'cancel-list', '¿Cuál cita quieres cancelar?');
        if (low === '3' || RESCHED_RE.test(low)) return showUpcoming(ctx, session, salon, 'reschedule-list', '¿Cuál cita quieres reprogramar?');
        if (low === '4') return handover(ctx, session, 'menu_opcion_4');
        // S/N a un recordatorio (sin sesión activa): S confirma la cita
        // más próxima, N abre la confirmación de cancelación. El S/N del
        // servidor (handleIncomingWhatsApp) no se dispara cuando el bot
        // está encendido, para que no haya doble respuesta.
        if (YES.has(low) || NO.has(low)) {
          const list = await store.findUpcoming(salon.id, ctx.phone);
          if (list.length) {
            const appt = list[0];
            const when = `${fmtDateLong(appt.date)} a las ${String(appt.start_time || appt.startTime).slice(0, 5)}`;
            if (YES.has(low)) {
              await store.confirmAppointment(appt.id);
              session.state = 'done'; session.data = {}; session.attempts = 0;
              await store.saveSession(session);
              return say(ctx, `¡Perfecto! ✅ Tu cita del ${when} (${appt.service_name || appt.serviceName}) queda confirmada. Te esperamos en ${salon.name}.`);
            }
            session.state = 'cancel-confirm';
            session.data = { ...session.data, cancelAppt: appt };
            session.attempts = 0;
            await store.saveSession(session);
            return say(ctx, `¿Cancelamos la cita del ${when} (${appt.service_name || appt.serviceName})? ${refundNote(appt)}\nResponde *SÍ* o *NO*.`);
          }
        }
        session.state = 'menu';
        await store.saveSession(session);
        return say(ctx, menuText(salon));
      }
      case 'services': {
        if (low === '0') { session.state = 'menu'; session.data = {}; await store.saveSession(session); return say(ctx, menuText(salon)); }
        const svc = pick(session.data.services || [], content);
        if (!svc) return invalid(ctx, session, 'No entendí el número. Responde con el número del servicio (o 0 para volver).');
        session.data = { ...session.data, service: svc };
        return showProfessionals(ctx, session, salon);
      }
      case 'professional': {
        const pros = session.data.professionals || [];
        if (low === '0') {
          session.data = { ...session.data, professionalId: null, professionalIds: null, professionalNames: 'Primera disponible' };
          return askDate(ctx, session);
        }
        const pro = pick(pros, content);
        if (!pro) return invalid(ctx, session, 'No entendí el número. Responde con el número de la profesional (o 0 para la primera disponible).');
        session.data = { ...session.data, professionalId: pro.id, professionalIds: [pro.id], professionalNames: pro.name };
        return askDate(ctx, session);
      }
      case 'date': {
        const iso = parseDate(content);
        if (!iso) return invalid(ctx, session, 'No entendí la fecha. Escríbela así: *15/11*, o *hoy* / *mañana*.');
        if (iso < todayStr()) return invalid(ctx, session, 'Esa fecha ya pasó. Escríbeme una fecha de hoy en adelante.');
        if (iso > addDays(todayStr(), 60)) return invalid(ctx, session, 'Solo se puede reservar hasta 60 días adelante. Escríbeme otra fecha.');
        session.data = { ...session.data, date: iso };
        return showSlots(ctx, session, salon);
      }
      case 'slots': {
        const slot = pick(session.data.slots || [], content);
        if (!slot) return invalid(ctx, session, 'No entendí el número. Responde con el número del hueco que quieres.');
        const pros = slot.professionals || (slot.professionalId ? [{ id: slot.professionalId, name: slot.professionalName }] : []);
        session.data = {
          ...session.data,
          start: String(slot.start).slice(0, 5),
          end: String(slot.end).slice(0, 5),
          professionalIds: pros.map((p) => p.id),
          professionalNames: pros.map((p) => p.name).join(' y ') || 'Primera disponible',
        };
        // El anticipo exacto se calcula al crear (depositFor); aquí solo
        // se guarda el % para mostrarlo en la confirmación. La regla es
        // la misma que en el servidor: % del servicio si está fijado, si
        // no el del salón, si no 20 %. Con 0 % no hay paso de pago.
        const svc = session.data.service;
        const pct = Number(svc.deposit_pct ?? svc.depositPct ?? salon.default_deposit_pct ?? 20);
        session.data.deposit = { pct, amount: Math.round(Number(svc.price) * pct / 100) };
        const known = await store.getClientName(salon.id, ctx.phone).catch(() => null);
        session.data = { ...session.data, knownName: known || null };
        return askName(ctx, session);
      }
      case 'name': {
        if (session.data.knownName && YES.has(low)) session.data = { ...session.data, clientName: session.data.knownName };
        else if (content.length < 2) return invalid(ctx, session, 'Escríbeme tu nombre, por favor.');
        else session.data = { ...session.data, clientName: content };
        return askPhone(ctx, session);
      }
      case 'phone': {
        if (YES.has(low)) {
          session.data = { ...session.data, clientPhone: ctx.phone };
        } else {
          const p = normPhone(content);
          if (!/^\+57\d{10}$/.test(p)) return invalid(ctx, session, 'Ese número no parece un celular colombiano. Escríbelo así: 300 123 4567, o responde *SÍ* si tu número está bien.');
          session.data = { ...session.data, clientPhone: p };
        }
        return askConfirm(ctx, session, salon);
      }
      case 'confirm': {
        if (YES.has(low)) return doCreate(ctx, session, salon);
        if (NO.has(low)) {
          session.state = 'menu'; session.data = {}; session.attempts = 0;
          await store.saveSession(session);
          return say(ctx, 'Sin problema, no se creó la cita. ¿Quieres hacer otra cosa? Escribe *menú*.');
        }
        return invalid(ctx, session, 'Responde *SÍ* para confirmar la cita o *NO* para cancelar.');
      }
      case 'cancel-list': {
        if (low === '0') { session.state = 'menu'; session.data = {}; await store.saveSession(session); return say(ctx, menuText(salon)); }
        const appt = pick(session.data.upcoming || [], content);
        if (!appt) return invalid(ctx, session, 'No entendí el número. Responde con el número de la cita a cancelar (o 0 para volver).');
        session.state = 'cancel-confirm';
        session.data = { ...session.data, cancelAppt: appt };
        session.attempts = 0;
        await store.saveSession(session);
        return say(ctx, `¿Cancelamos la cita del ${fmtDateLong(appt.date)} a las ${String(appt.start_time || appt.startTime).slice(0, 5)} (${appt.service_name || appt.serviceName})? ${refundNote(appt)}\nResponde *SÍ* o *NO*.`);
      }
      case 'cancel-confirm': {
        if (YES.has(low)) {
          const appt = session.data.cancelAppt;
          try {
            const r = await store.cancelAppointment(appt.id, 'Cancelada por WhatsApp (bot)');
            session.state = 'done'; session.data = {}; session.attempts = 0;
            await store.saveSession(session);
            const ref = r?.refund || {};
            const refLine = Number(ref.refund) > 0 ? ` Te reembolsamos ${fmtMoney(ref.refund)}.` : (Number(appt.deposit_amount ?? appt.depositAmount ?? 0) > 0 ? ' El anticipo queda retenido según la política.' : '');
            return say(ctx, `Listo, tu cita quedó cancelada.${refLine} ¿Necesitas otra cita? Escribe *reservar*.`);
          } catch (e) {
            log.error('Bot: error cancelando', e);
            return say(ctx, 'No pude cancelar la cita. Escribe *persona* y te ayuda alguien del salón.');
          }
        }
        if (NO.has(low)) { session.state = 'menu'; session.data = {}; session.attempts = 0; await store.saveSession(session); return say(ctx, menuText(salon)); }
        return invalid(ctx, session, 'Responde *SÍ* para cancelar la cita o *NO* para dejarla como está.');
      }
      case 'reschedule-list': {
        if (low === '0') { session.state = 'menu'; session.data = {}; await store.saveSession(session); return say(ctx, menuText(salon)); }
        const appt = pick(session.data.upcoming || [], content);
        if (!appt) return invalid(ctx, session, 'No entendí el número. Responde con el número de la cita a reprogramar (o 0 para volver).');
        session.state = 'reschedule-date';
        session.data = { ...session.data, rescheduleAppt: appt };
        session.attempts = 0;
        await store.saveSession(session);
        return say(ctx, `¿Para qué día la movemos? Escríbelo así: *15/11*, o *hoy* / *mañana*.`);
      }
      case 'reschedule-date': {
        const iso = parseDate(content);
        if (!iso) return invalid(ctx, session, 'No entendí la fecha. Escríbela así: *15/11*, o *hoy* / *mañana*.');
        if (iso < todayStr()) return invalid(ctx, session, 'Esa fecha ya pasó. Escríbeme una fecha de hoy en adelante.');
        session.data = { ...session.data, newDate: iso };
        const svc = { id: session.data.rescheduleAppt.service_id || session.data.rescheduleAppt.serviceId };
        const slots = await store.getSlots(salon.id, svc, null, iso).catch(() => []);
        const list = (Array.isArray(slots) ? slots : []).filter((s) => {
          const names = (s.professionals || []).map((p) => p.id);
          const cur = session.data.rescheduleAppt.professional_ids || [session.data.rescheduleAppt.professional_id];
          return names.some((id) => (cur || []).map(String).includes(String(id)));
        });
        if (!list.length) {
          session.state = 'reschedule-date';
          await store.saveSession(session);
          return say(ctx, `No hay huecos libres con tu profesional el ${fmtDateLong(iso)} 😔 ¿Pruebas otro día?`);
        }
        session.state = 'reschedule-slots';
        session.data = { ...session.data, rescheduleSlots: list };
        session.attempts = 0;
        await store.saveSession(session);
        return say(ctx, `Huecos libres el ${fmtDateLong(iso)}:\n${list.map((s, i) => `${i + 1}️⃣ ${String(s.start).slice(0, 5)} - ${String(s.end).slice(0, 5)}`).join('\n')}\nResponde con el número del hueco.`);
      }
      case 'reschedule-slots': {
        const slot = pick(session.data.rescheduleSlots || [], content);
        if (!slot) return invalid(ctx, session, 'No entendí el número. Responde con el número del hueco.');
        session.state = 'reschedule-confirm';
        session.data = { ...session.data, newStart: String(slot.start).slice(0, 5) };
        session.attempts = 0;
        await store.saveSession(session);
        const appt = session.data.rescheduleAppt;
        return say(ctx, `¿Movemos tu cita de ${appt.service_name || appt.serviceName} al ${fmtDateLong(session.data.newDate)} a las ${session.data.newStart}? Responde *SÍ* o *NO*.`);
      }
      case 'reschedule-confirm': {
        if (YES.has(low)) {
          const appt = session.data.rescheduleAppt;
          const newDate = session.data.newDate;
          const newStart = session.data.newStart;
          try {
            await store.rescheduleAppointment(appt.id, newDate, newStart);
            session.state = 'done'; session.data = {}; session.attempts = 0;
            await store.saveSession(session);
            return say(ctx, `Listo ✅ Tu cita quedó para el ${fmtDateLong(newDate)} a las ${newStart}. Te esperamos en ${salon.name}.`);
          } catch (e) {
            if (e?.status === 409) {
              session.state = 'reschedule-date';
              await store.saveSession(session);
              return say(ctx, 'Ese hueco se acaba de ocupar 😔 ¿Pruebas otro día? Escríbelo así: *15/11*.');
            }
            log.error('Bot: error reprogramando', e);
            return say(ctx, 'No pude reprogramar la cita. Escribe *persona* y te ayuda alguien del salón.');
          }
        }
        if (NO.has(low)) { session.state = 'menu'; session.data = {}; session.attempts = 0; await store.saveSession(session); return say(ctx, menuText(salon)); }
        return invalid(ctx, session, 'Responde *SÍ* para mover la cita o *NO* para dejarla como está.');
      }
      default: {
        session.state = 'menu'; session.data = {}; session.attempts = 0;
        await store.saveSession(session);
        return say(ctx, menuText(salon));
      }
    }
  }

  return { handleMessage };
}
