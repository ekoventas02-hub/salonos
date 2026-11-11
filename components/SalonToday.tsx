
import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
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

export function SalonToday({ currentUser }: any) {
  const [d, setD] = useState<any>(null);
  const [avail, setAvail] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => { apiFetch('/api/salon/today').then(j).then(setD).catch((e: any) => setErr(e.message)); apiFetch('/api/salon/professionals/availability').then(j).then((a: any) => setAvail(a.professionals || [])).catch(() => {}); };
  useEffect(() => { load(); }, []);
  const act = async (id: number, status: string, body: any = {}) => {
    setBusy(String(id) + status);
    try {
      // AUDITORÍA v1.1: antes se mandaba payments:[{amount:null}] y el
      // servidor sumaba 0 y devolvía 400 siempre. Ahora se manda el método
      // y el servidor cobra el resto (total+propina-anticipo).
      if (status === 'completada') await j(await apiFetch(`/api/salon/appointments/${id}/complete`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'efectivo', ...body }) }));
      else await j(await apiFetch(`/api/salon/appointments/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }));
      load();
    } catch (e: any) { setErr(e.message); }
    setBusy('');
  };
  if (err) return <div className="p-6 text-red-600 text-sm">{err}</div>;
  if (!d) return <div className="p-6 text-sm text-slate-500">Cargando tu día…</div>;
  const next = d.appointments.find((a: any) => ['pendiente', 'confirmada', 'en_curso'].includes(a.status));
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Hoy, {d.date}</h1>
      {avail.length > 0 && (
        <div className={`${card} flex flex-wrap gap-2 text-sm`}>
          <span className="font-bold">Disponibilidad ahora:</span>
          {avail.map((a: any) => (
            <span key={a.id} className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${a.status === 'disponible' ? 'bg-emerald-100 text-emerald-800' : a.status === 'ocupada' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>{a.name}: {a.label}{!a.isOnline ? ' · sin conexión' : ''}</span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className={card}><p className="text-xs uppercase text-slate-500 font-bold">{['estilista', 'manicurista'].includes(currentUser.role) ? 'Mis ventas hoy' : 'Ventas del salón hoy'}</p><p className="text-2xl font-black">{COP(d.dayTotal)}</p></div>
        <div className={card}><p className="text-xs uppercase text-slate-500 font-bold">Mi comisión hoy</p><p className="text-2xl font-black">{COP(d.myCommission)}</p></div>
        <div className={card}><p className="text-xs uppercase text-slate-500 font-bold">Mis propinas hoy</p><p className="text-2xl font-black">{COP(d.myTips)}</p></div>
      </div>
      {next && (
        <div className={`${card} border-brand-600`}>
          <p className="text-xs uppercase text-brand-600 font-black">Ahora sigue</p>
          <p className="text-lg font-bold">{next.serviceName} — {next.clientName}</p>
          <p className="text-sm text-slate-500">{next.startTime} - {next.endTime} · {COP(next.price)} · Anticipo: {next.depositStatus}</p>
          <div className="flex gap-2 mt-3">
            {next.status !== 'en_curso' && <button className={btn} disabled={!!busy} onClick={() => act(next.id, 'en_curso')}>Empezar</button>}
            <button className={btn} disabled={!!busy} onClick={() => act(next.id, 'completada')}>Cobrar / Terminar</button>
          </div>
        </div>
      )}
      <div className={card}>
        <h2 className="font-bold mb-2">Mis citas de hoy</h2>
        {d.appointments.map((a: any) => (
          <div key={a.id} className="flex flex-wrap justify-between gap-2 py-2 border-b border-slate-100 text-sm">
            <span><b>{a.startTime}</b> · {a.serviceName} · {a.clientName} · {a.status}</span>
            <span>{COP(a.price)} · comisión {a.commissionPctFrozen}% ({COP(a.commissionAmount)})</span>
          </div>
        ))}
        {d.appointments.length === 0 && <p className="text-sm text-slate-500">No tienes citas hoy.</p>}
      </div>
    </div>
  );
}
