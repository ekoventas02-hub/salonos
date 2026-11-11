
import React, { useEffect, useState } from 'react';
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
export { PAYMENT_METHODS as METHODS } from '../lib/paymentMethods';

export function PublicBooking({ slug }: { slug: string }) {
  const [data, setData] = useState<any>(null);
  const [slots, setSlots] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<any>(null);
  const [form, setForm] = useState({ serviceId: '', professionalId: '', date: todayStr(), startTime: '', clientName: '', clientPhone: '', notes: '', acceptPolicy: false, dataConsent: false });
  useEffect(() => { fetch(`/api/public/reserva/${slug}`).then((r) => r.json()).then((d) => d.error ? setErr(d.error) : setData(d)).catch((e: any) => setErr(e.message)); }, [slug]);
  const loadSlots = async () => {
    if (!form.serviceId) return;
    try { const s = await (await fetch(`/api/public/reserva/${slug}/slots?serviceId=${form.serviceId}&professionalId=${form.professionalId || ''}&date=${form.date}`)).json(); setSlots(Array.isArray(s) ? s : []); if ((s as any).error) setErr((s as any).error); }
    catch (e: any) { setErr(e.message); }
  };
  const submit = async (e: any) => {
    e.preventDefault(); setErr('');
    try {
      const r = await fetch(`/api/public/reserva/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, serviceId: Number(form.serviceId), professionalId: form.professionalId ? Number(form.professionalId) : undefined }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'No se pudo crear la cita');
      setDone(d);
    } catch (ex: any) { setErr(ex.message); }
  };
  if (err && !data) return <div className="min-h-screen flex items-center justify-center p-6 text-red-600">{err}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center p-6 text-slate-500">Cargando…</div>;
  const salon = data.salon;
  const service = data.services.find((s: any) => String(s.id) === String(form.serviceId));
  // v1.3 (anticipo opcional): % efectivo del servicio = % propio si está
  // fijado, si no el del salón, si no 20 %. Con 0 % no hay anticipo.
  const effDepositPct = (s: any) => (s.deposit_pct != null ? Number(s.deposit_pct) : Number(data.salon.default_deposit_pct ?? 20));
  const effPct = service ? effDepositPct(service) : null;
  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="bg-white rounded-3xl p-6 text-center border">
          {salon.logo_url && <img src={salon.logo_url} alt={salon.name} className="w-16 h-16 object-contain mx-auto mb-2" />}
          <h1 className="text-2xl font-black" style={{ color: salon.primary_color || '#db2777' }}>{salon.name}</h1>
          <p className="text-sm text-slate-500">{salon.address || ''} {salon.phone ? `· ${salon.phone}` : ''}</p>
          <p className="text-sm font-bold mt-1">Reserva tu cita en línea</p>
        </div>
        {done ? (
          <div className="bg-white rounded-3xl p-6 border text-center">
            <h2 className="text-lg font-black text-emerald-700">¡Cita creada!</h2>
            <p className="text-sm mt-2">Te enviamos la confirmación por WhatsApp. {done.deposit.amount > 0 ? <>Anticipo: <b>{COP(done.deposit.amount)} ({done.deposit.pct}%)</b>.</> : <>Sin anticipo: tu cita quedó <b>confirmada</b>.</>}</p>
            <p className="text-sm text-slate-500 mt-2">{done.policy}</p>
            <p className="text-sm mt-2">{done.note}</p>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-white rounded-3xl p-6 border space-y-3">
            {err && <p className="text-sm text-red-600">{err}</p>}
            <select className={input} value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })} required>
              <option value="">Elige el servicio *</option>
              {data.services.map((s: any) => <option key={s.id} value={s.id}>{s.name} · {s.duration_minutes} min · {COP(s.price)} · {effDepositPct(s) > 0 ? `anticipo ${effDepositPct(s)}%` : 'sin anticipo'}</option>)}
            </select>
            <select className={input} value={form.professionalId} onChange={(e) => setForm({ ...form, professionalId: e.target.value })}>
              <option value="">Primera disponible</option>
              {data.professionals.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="date" className={input} value={form.date} min={todayStr()} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            <button type="button" className="w-full px-4 py-2 rounded-xl border text-sm font-bold" onClick={loadSlots}>Ver horas libres</button>
            <select className={input} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required>
              <option value="">Elige la hora *</option>
              {slots.map((s: any, i: number) => <option key={i} value={s.start}>{s.start} - {s.end} · {s.professionalName || (s.professionals || []).map((p: any) => p.name).join(' y ')}</option>)}
            </select>
            <input className={input} placeholder="Tu nombre *" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} required />
            <input className={input} placeholder="Tu WhatsApp (300 123 4567) *" value={form.clientPhone} onChange={(e) => setForm({ ...form, clientPhone: e.target.value })} required />
            <input className={input} placeholder="Notas (opcional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <label className="flex gap-2 text-xs text-slate-600"><input type="checkbox" checked={form.acceptPolicy} onChange={(e) => setForm({ ...form, acceptPolicy: e.target.checked })} required /> Acepto la política de anticipo y cancelación: {data.policy.note}</label>
            <label className="flex gap-2 text-xs text-slate-600"><input type="checkbox" checked={form.dataConsent} onChange={(e) => setForm({ ...form, dataConsent: e.target.checked })} /> Autorizo el tratamiento de mis datos para gestionar mi cita (Ley 1581 de 2012).</label>
            <button className="w-full py-3 rounded-xl text-white font-black" style={{ background: salon.primary_color || '#db2777' }}>Confirmar reserva</button>
            {service && <p className="text-xs text-slate-500 text-center">{effPct === 0 ? 'Sin anticipo: la cita se confirma sin pago.' : <>Anticipo estimado: {COP(Number(service.price) * Number(effPct) / 100)} ({effPct}%). La cita queda pendiente hasta pagar el anticipo.</>}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
