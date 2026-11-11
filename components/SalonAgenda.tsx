
import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { PAYMENT_METHODS, MANUAL_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '../lib/paymentMethods';
export const COP = (v: any) => '$' + (Number(v) || 0).toLocaleString('es-CO');
export async function j(res: Response) {
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || ('Error ' + res.status));
  return d;
}
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const btn = 'bg-brand-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-brand-700 disabled:opacity-50';
export const input = 'w-full border border-slate-300 rounded-xl px-3 py-2 text-sm';
export const card = 'bg-white border border-slate-200 rounded-2xl p-4';

export function SalonAgenda({ currentUser }: any) {
  const [date, setDate] = useState(todayStr());
  const [list, setList] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [pros, setPros] = useState<any[]>([]);
  const [avail, setAvail] = useState<any[]>([]);
  const [slots, setSlots] = useState<any[]>([]);
  const [waitlist, setWaitlist] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState<any>({ serviceId: '', professionalId: '', startTime: '', clientName: '', clientPhone: '', source: 'interna', notes: '' });
  const [complete, setComplete] = useState<any>({ id: null, paymentMethod: 'efectivo', tip: 0, suppliesCost: 0, reference: '' });
  const load = () => {
    apiFetch(`/api/salon/appointments?date=${date}`).then(j).then(setList).catch((e: any) => setErr(e.message));
    apiFetch('/api/salon/waitlist').then(j).then(setWaitlist).catch(() => {});
  };
  useEffect(() => { apiFetch('/api/salon/catalog-services').then(j).then(setServices).catch(() => {}); apiFetch('/api/salon/professionals').then(j).then(setPros).catch(() => {}); apiFetch('/api/salon/professionals/availability').then(j).then((d: any) => setAvail(d.professionals || [])).catch(() => {}); }, []);
  // v1.3: disponibilidad de hoy (solo tiene sentido para la fecha de hoy).
  const availLabel = (id: number) => {
    if (date !== todayStr()) return '';
    const a = avail.find((x: any) => x.id === id);
    return a ? ` — ${a.label}` : '';
  };
  useEffect(load, [date]);
  const loadSlots = async () => {
    if (!form.serviceId) return;
    try { const s = await j(await apiFetch(`/api/salon/availability?serviceId=${form.serviceId}&professionalId=${form.professionalId || ''}&date=${date}`)); setSlots(Array.isArray(s) ? s : []); }
    catch (e: any) { setErr(e.message); }
  };
  const create = async (e: any) => {
    e.preventDefault(); setErr(''); setMsg('');
    try {
      const created = await j(await apiFetch('/api/salon/appointments', { method: 'POST', body: JSON.stringify({ ...form, serviceId: Number(form.serviceId), professionalId: form.professionalId ? Number(form.professionalId) : undefined, date }) }));
      // v1.3 (anticipo opcional): sin anticipo la cita nace confirmada.
      const first = created[0] || {};
      setMsg(first.status === 'confirmada' && !(first.depositAmount > 0) ? 'Cita confirmada (sin anticipo). La confirmación salió por WhatsApp.' : `Cita creada. Anticipo: ${COP(first.depositAmount || 0)} (${first.depositPctFrozen || 0}%). La confirmación salió por WhatsApp.`);
      setForm({ serviceId: '', professionalId: '', startTime: '', clientName: '', clientPhone: '', source: 'interna', notes: '' });
      setSlots([]); load();
    } catch (ex: any) { setErr(ex.message); }
  };
  const patch = async (id: number, body: any) => { try { await j(await apiFetch(`/api/salon/appointments/${id}`, { method: 'PATCH', body: JSON.stringify(body) })); load(); } catch (e: any) { setErr(e.message); } };
  const cancel = async (a: any) => {
    const reason = prompt('Motivo de la cancelación (se aplica la política de anticipo automáticamente):', '');
    if (reason === null) return;
    try { const r = await j(await apiFetch(`/api/salon/appointments/${a.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) })); setMsg(`Cancelada. ${r.refund.rule}: se reembolsan ${COP(r.refund.refund)} y se retienen ${COP(r.refund.kept)}.`); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const doComplete = async () => {
    try {
      const r = await j(await apiFetch(`/api/salon/appointments/${complete.id}/complete`, { method: 'POST', body: JSON.stringify({ paymentMethod: complete.paymentMethod, reference: complete.reference || null, tip: Number(complete.tip), suppliesCost: Number(complete.suppliesCost) }) }));
      setMsg(`Cobrada. Comisión de la profesional: ${COP(r.commission)}. Documento: ${r.document.type === 'dee_pos' ? 'DEE POS (tiquete)' : 'factura electrónica plena'}. ${r.note}`);
      setComplete({ id: null, paymentMethod: 'efectivo', tip: 0, suppliesCost: 0, reference: '' }); load();
    } catch (e: any) { setErr(e.message); }
  };
  const depositLink = async (a: any, provider: string) => {
    try { const r = await j(await apiFetch(`/api/salon/appointments/${a.id}/deposit-link`, { method: 'POST', body: JSON.stringify({ provider }) })); window.open(r.paymentUrl, '_blank'); }
    catch (e: any) { setErr(e.message); }
  };
  const [depMethod, setDepMethod] = useState('nequi');
  const markDeposit = async (a: any) => {
    // AUDITORÍA v1.1: antes el método se pedía con prompt() de texto libre
    // y un error de tipeo ("neqiu") quedaba guardado y aparecía en el
    // cierre. Ahora es una lista cerrada.
    try { await j(await apiFetch(`/api/salon/appointments/${a.id}/deposit`, { method: 'POST', body: JSON.stringify({ method: depMethod }) })); setMsg('Anticipo registrado y cita confirmada.'); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const [wl, setWl] = useState<any>({ serviceId: '', clientName: '', clientPhone: '', dateWanted: '' });
  const addWaitlist = async (e: any) => {
    e.preventDefault(); setErr(''); setMsg('');
    try {
      await j(await apiFetch('/api/salon/waitlist', { method: 'POST', body: JSON.stringify({ serviceId: Number(wl.serviceId), clientName: wl.clientName, clientPhone: wl.clientPhone, dateWanted: wl.dateWanted || null }) }));
      setMsg('Añadida a la lista de espera. Si se cancela una cita de ese servicio, se le avisa por WhatsApp.');
      setWl({ serviceId: '', clientName: '', clientPhone: '', dateWanted: '' }); load();
    } catch (ex: any) { setErr(ex.message); }
  };
  const remind = async (a: any) => { try { await j(await apiFetch(`/api/salon/appointments/${a.id}/remind`, { method: 'POST', body: JSON.stringify({}) })); setMsg('Recordatorio enviado por WhatsApp.'); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <h1 className="text-xl font-black text-slate-800">Agenda</h1>
        <input type="date" className={input + ' w-auto'} value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">{msg}</p>}
      <form onSubmit={create} className={`${card} grid grid-cols-2 md:grid-cols-3 gap-3`}>
        <select className={input} value={form.serviceId} onChange={(e) => { setForm({ ...form, serviceId: e.target.value }); }} required>
          <option value="">Servicio *</option>
          {services.map((s: any) => <option key={s.id} value={s.id}>{s.name} · {s.durationMinutes} min · {COP(s.price)} · {Number(s.depositPct) > 0 ? `anticipo ${s.depositPct}%` : 'sin anticipo'}</option>)}
        </select>
        <select className={input} value={form.professionalId} onChange={(e) => setForm({ ...form, professionalId: e.target.value })}>
          <option value="">Primera disponible</option>
          {pros.map((p: any) => <option key={p.id} value={p.id}>{p.name}{availLabel(p.id)}</option>)}
        </select>
        <button type="button" className="px-4 py-2 rounded-xl text-sm font-bold border" onClick={loadSlots}>Ver huecos libres</button>
        <select className={input} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required>
          <option value="">Hora *</option>
          {slots.map((s: any, i: number) => <option key={i} value={s.start}>{s.start} - {s.end} · {s.professionalName || (s.professionals || []).map((p: any) => p.name).join(' y ')}</option>)}
        </select>
        <input className={input} placeholder="Nombre de la clienta *" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} required />
        <input className={input} placeholder="Teléfono (300 123 4567) *" value={form.clientPhone} onChange={(e) => setForm({ ...form, clientPhone: e.target.value })} required />
        <select className={input} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}><option value="interna">Cita normal</option><option value="walk-in">Walk-in (llegó sin cita)</option></select>
        <input className={input} placeholder="Notas" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <button className={btn}>Crear cita</button>
      </form>
      <div className={card}>
        {list.map((a: any) => (
          <div key={a.id} className="py-3 border-b border-slate-100">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span><b>{a.startTime} - {a.endTime}</b> · {a.serviceName} · {a.clientName} ({a.clientPhone}) · {a.professionalName} · <b>{a.status}</b> · {COP(a.price)}</span>
              <span className="text-slate-500">Anticipo {a.depositStatus} ({COP(a.depositAmount)}) · Comisión {a.commissionPctFrozen}%</span>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {a.status === 'pendiente' && <><button className="text-xs font-bold bg-emerald-600 text-white px-3 py-1.5 rounded-lg" onClick={() => patch(a.id, { status: 'confirmada' })}>Confirmar</button>
                <button className="text-xs font-bold border px-3 py-1.5 rounded-lg" onClick={() => depositLink(a, 'wompi')}>Link anticipo Wompi</button>
                <button className="text-xs font-bold border px-3 py-1.5 rounded-lg" onClick={() => depositLink(a, 'payu')}>Link anticipo PayU</button>
                <select className="text-xs border rounded-lg px-2 py-1.5" value={depMethod} onChange={(e) => setDepMethod(e.target.value)}>{MANUAL_PAYMENT_METHODS.map((m: string) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m] || m}</option>)}</select>
                <button className="text-xs font-bold border px-3 py-1.5 rounded-lg" onClick={() => markDeposit(a)}>Anticipo ya pagado</button></>}
              {['pendiente', 'confirmada'].includes(a.status) && <button className="text-xs font-bold border px-3 py-1.5 rounded-lg" onClick={() => remind(a)}>Recordar por WhatsApp</button>}
              {a.status === 'confirmada' && <button className="text-xs font-bold bg-brand-600 text-white px-3 py-1.5 rounded-lg" onClick={() => patch(a.id, { status: 'en_curso' })}>Empezar</button>}
              {a.status === 'en_curso' && <button className="text-xs font-bold bg-brand-600 text-white px-3 py-1.5 rounded-lg" onClick={() => setComplete({ id: a.id, paymentMethod: 'efectivo', tip: 0, suppliesCost: 0, reference: '' })}>Cobrar / Terminar</button>}
              {['pendiente', 'confirmada'].includes(a.status) && <><button className="text-xs font-bold text-red-600 border border-red-200 px-3 py-1.5 rounded-lg" onClick={() => cancel(a)}>Cancelar (aplica política)</button>
                <button className="text-xs font-bold text-red-600 border border-red-200 px-3 py-1.5 rounded-lg" onClick={async () => { await j(await apiFetch(`/api/salon/appointments/${a.id}/no-show`, { method: 'POST', body: JSON.stringify({}) })); load(); }}>No-show</button></>}
            </div>
            {complete.id === a.id && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 bg-slate-50 p-3 rounded-xl">
                <select className={input} value={complete.paymentMethod} onChange={(e) => setComplete({ ...complete, paymentMethod: e.target.value })}>
                  {PAYMENT_METHODS.map((m: string) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m] || m}</option>)}
                </select>
                <input className={input} type="number" placeholder="Propina" value={complete.tip} onChange={(e) => setComplete({ ...complete, tip: Number(e.target.value) })} />
                <input className={input} type="number" placeholder="Costo insumos" value={complete.suppliesCost} onChange={(e) => setComplete({ ...complete, suppliesCost: Number(e.target.value) })} />
                <input className={input} placeholder="Ref. / comprobante (opcional)" value={complete.reference || ''} onChange={(e) => setComplete({ ...complete, reference: e.target.value })} />
                <button className={btn} onClick={doComplete}>Confirmar cobro</button>
              </div>
            )}
          </div>
        ))}
        {list.length === 0 && <p className="text-sm text-slate-500">Sin citas este día.</p>}
      </div>
      <div className={card}>
        <h2 className="font-bold mb-2">Lista de espera</h2>
        {waitlist.filter((w: any) => w.status === 'esperando').map((w: any) => (
          <p key={w.id} className="text-sm py-1 border-b border-slate-100">{w.client_name} · {w.client_phone} · servicio {w.service_id} · {w.date_wanted || 'cualquier día'}</p>
        ))}
        {waitlist.filter((w: any) => w.status === 'esperando').length === 0 && <p className="text-sm text-slate-500">Nadie en lista de espera. Cuando se cancele una cita, el sistema avisa automáticamente a la primera persona de la lista.</p>}
        <form onSubmit={addWaitlist} className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
          <select className={input} value={wl.serviceId} onChange={(e) => setWl({ ...wl, serviceId: e.target.value })} required>
            <option value="">Servicio *</option>
            {services.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input className={input} placeholder="Nombre *" value={wl.clientName} onChange={(e) => setWl({ ...wl, clientName: e.target.value })} required />
          <input className={input} placeholder="Teléfono *" value={wl.clientPhone} onChange={(e) => setWl({ ...wl, clientPhone: e.target.value })} required />
          <input className={input} type="date" value={wl.dateWanted} onChange={(e) => setWl({ ...wl, dateWanted: e.target.value })} />
          <button className={btn}>Añadir a la espera</button>
        </form>
      </div>
    </div>
  );
}
