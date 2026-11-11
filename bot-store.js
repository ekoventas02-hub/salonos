// Adaptador Postgres del bot de reservas (bot-engine.js).
// Reutiliza la lógica de salon-routes.js (salonApi.bot): los huecos salen de
// computeSlots (la misma que la reserva web, con limpieza y sin cruces) y la
// creación pasa por createAppointmentTx dentro de una transacción, así el
// trigger anti-cruce de Postgres decide quién gana si dos clientas piden el
// mismo hueco a la vez. El salón SIEMPRE llega por parámetro (desde la
// instancia/número), nunca del mensaje.
export class PgBotStore {
  constructor(pool, salonApi) {
    this.pool = pool;
    this.api = salonApi;
  }

  async getSalon(salonId) {
    const r = await this.pool.query('SELECT * FROM salons WHERE id=$1', [salonId]);
    return r.rows[0] || null;
  }

  async listServices(salonId) {
    const r = await this.pool.query(
      `SELECT id, name, category, duration_minutes, cleanup_minutes, price, commission_pct, deposit_pct, team_size, active
       FROM salon_services WHERE salon_id=$1 AND active=true ORDER BY category, name`,
      [salonId]);
    return r.rows;
  }

  async listProfessionals(salonId, serviceId) {
    const assigned = await this.pool.query('SELECT employee_id FROM service_professionals WHERE service_id=$1', [serviceId]);
    let q = "SELECT id, name FROM employees WHERE salon_id=$1 AND active=true AND role IN ('estilista','manicurista','operator')";
    const params = [salonId];
    if (assigned.rows.length) { q += ' AND id = ANY($2)'; params.push(assigned.rows.map((x) => x.employee_id)); }
    q += ' ORDER BY name';
    const r = await this.pool.query(q, params);
    return r.rows;
  }

  async getSlots(salonId, service, professionalId, date) {
    const client = await this.pool.connect();
    try {
      let svc = service;
      if (!svc || (!svc.duration_minutes && !svc.durationMinutes)) {
        const r = await client.query('SELECT * FROM salon_services WHERE id=$1 AND salon_id=$2 AND active=true', [svc?.id, salonId]);
        svc = r.rows[0];
        if (!svc) return [];
      }
      const slots = await this.api.computeSlots(client, salonId, svc, professionalId || null, String(date));
      return Array.isArray(slots) ? slots : [];
    } finally { client.release(); }
  }

  async createAppointment(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const svc = (await client.query('SELECT * FROM salon_services WHERE id=$1 AND salon_id=$2 AND active=true', [input.service.id, input.salonId])).rows[0];
      if (!svc) throw Object.assign(new Error('Servicio no encontrado'), { status: 404 });
      const dep = this.api.depositFor(svc, await this.api.getSalon(client, input.salonId));
      const r = await this.api.createAppointmentTx(client, input.salonId, {
        service: svc,
        date: String(input.date),
        startTime: String(input.startTime),
        clientName: input.clientName,
        clientPhone: input.clientPhone,
        professionalIds: input.professionalIds,
        source: 'whatsapp-bot',
        // Sin anticipo la cita queda confirmada de una vez (la clienta ya
        // dijo SÍ); con anticipo queda pendiente hasta que el webhook de
        // Wompi/PayU marque el pago.
        status: dep.amount > 0 ? 'pendiente' : 'confirmada',
      });
      await client.query('COMMIT');
      return r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally { client.release(); }
  }

  async findUpcoming(salonId, phone) {
    const r = await this.pool.query(
      `SELECT * FROM appointments WHERE salon_id=$1 AND client_phone=$2
       AND status IN ('pendiente','confirmada') AND date >= CURRENT_DATE
       ORDER BY date ASC, start_time ASC`,
      [salonId, phone]);
    // Una cita a 4 manos son varias filas con el mismo group_id: se muestra una sola.
    const seen = new Set();
    return r.rows.filter((a) => {
      const key = a.group_id || `s_${a.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async confirmAppointment(apptId) {
    const cur = (await this.pool.query('SELECT * FROM appointments WHERE id=$1', [apptId])).rows[0];
    if (!cur) throw Object.assign(new Error('Cita no encontrada'), { status: 404 });
    const where = cur.group_id ? 'group_id=$1' : 'id=$1';
    await this.pool.query(
      `UPDATE appointments SET status='confirmada', confirmation_status='confirmada_por_whatsapp' WHERE ${where} AND status IN ('pendiente','confirmada')`,
      [cur.group_id || apptId]);
  }

  async cancelAppointment(apptId, reason) {
    const cur = (await this.pool.query('SELECT * FROM appointments WHERE id=$1', [apptId])).rows[0];
    if (!cur) throw Object.assign(new Error('Cita no encontrada'), { status: 404 });
    if (['completada', 'cancelada', 'no-show'].includes(cur.status)) throw Object.assign(new Error(`La cita ya está ${cur.status}`), { status: 400 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await this.api.cancelAppointmentTx(client, cur.salon_id, cur, reason);
      await client.query('COMMIT');
      await this.api.notifyWaitlist(cur.salon_id, cur);
      return r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally { client.release(); }
  }

  async rescheduleAppointment(apptId, newDate, newStart) {
    const cur = (await this.pool.query('SELECT * FROM appointments WHERE id=$1', [apptId])).rows[0];
    if (!cur) throw Object.assign(new Error('Cita no encontrada'), { status: 404 });
    if (['completada', 'cancelada', 'no-show'].includes(cur.status)) throw Object.assign(new Error(`La cita ya está ${cur.status}`), { status: 400 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await this.api.rescheduleAppointmentTx(client, cur.salon_id, cur, String(newDate), String(newStart));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally { client.release(); }
  }

  async depositLink({ appointmentId, amount, serviceName, clientName }) {
    const preferred = (process.env.WOMPI_PUBLIC_KEY || '').trim() ? 'wompi'
      : ((process.env.PAYU_MERCHANT_ID || '').trim() ? 'payu' : null);
    if (!preferred) return { paymentUrl: null, provider: null };
    const link = await this.api.buildDepositLink(preferred, amount, `ANT-${appointmentId}`, serviceName, clientName);
    if (link.error) return { paymentUrl: null, provider: preferred, error: link.error };
    return { paymentUrl: link.paymentUrl, provider: preferred };
  }

  async getClientName(salonId, phone) {
    const r = await this.pool.query('SELECT name FROM salon_clients WHERE salon_id=$1 AND phone=$2', [salonId, phone]);
    return r.rows[0]?.name || null;
  }

  // Sesiones de conversación (una por salón+teléfono).
  async getSession(salonId, phone) {
    const r = await this.pool.query('SELECT * FROM wa_bot_sessions WHERE salon_id=$1 AND client_phone=$2', [salonId, phone]);
    if (!r.rows[0]) return null;
    return { salon_id: r.rows[0].salon_id, client_phone: r.rows[0].client_phone, state: r.rows[0].state, data: r.rows[0].data || {}, attempts: r.rows[0].attempts || 0 };
  }

  async saveSession(session) {
    await this.pool.query(
      `INSERT INTO wa_bot_sessions (salon_id, client_phone, state, data, attempts, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (salon_id, client_phone) DO UPDATE SET state=EXCLUDED.state, data=EXCLUDED.data, attempts=EXCLUDED.attempts, updated_at=NOW()`,
      [session.salon_id, session.client_phone, session.state, JSON.stringify(session.data || {}), session.attempts || 0]);
  }

  async clearSession(salonId, phone) {
    await this.pool.query('DELETE FROM wa_bot_sessions WHERE salon_id=$1 AND client_phone=$2', [salonId, phone]);
  }

  async listActiveSessions(salonId) {
    const r = await this.pool.query(
      "SELECT client_phone, state, updated_at FROM wa_bot_sessions WHERE salon_id=$1 AND state NOT IN ('done') ORDER BY updated_at DESC LIMIT 50",
      [salonId]);
    return r.rows;
  }
}
