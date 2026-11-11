
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

export function SalonClients({ currentUser }: any) {
  const canEdit = !currentUser || ['admin', 'recepcionista'].includes(currentUser.role);
  const [q, setQ] = useState('');
  const [list, setList] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [err, setErr] = useState('');
  const load = () => apiFetch(`/api/salon/clients?search=${encodeURIComponent(q)}`).then(j).then(setList).catch((e: any) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const open = async (phone: string) => { try { setSel(await j(await apiFetch(`/api/salon/clients/${encodeURIComponent(phone)}`))); } catch (e: any) { setErr(e.message); } };
  const saveFicha = async () => {
    try { await j(await apiFetch(`/api/salon/clients/${encodeURIComponent(sel.client.phone)}`, { method: 'PUT', body: JSON.stringify({ notes: sel.client.notes, allergies: sel.client.allergies, formula: sel.client.formula }) })); setSel(null); load(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Clientas del salón</h1>
      <p className="text-sm text-slate-500">La ficha guarda alergias, fórmula/color usado y la autorización de datos (Ley 1581). La profesional solo ve a sus propias clientas.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2"><input className={input} placeholder="Buscar por nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} /><button className={btn} onClick={load}>Buscar</button></div>
      <div className={card}>
        {list.map((c: any) => (
          <div key={c.id} className="flex justify-between py-2 border-b border-slate-100 text-sm"><span><b>{c.name || 'Sin nombre'}</b> · {c.phone}{c.allergies ? ` · ⚠️ ${c.allergies}` : ''}</span><button className="text-brand-600 font-bold" onClick={() => open(c.phone)}>Ver ficha</button></div>
        ))}
        {list.length === 0 && <p className="text-sm text-slate-500">Sin clientas todavía.</p>}
      </div>
      {sel && (
        <div className={card}>
          <h2 className="font-bold">{sel.client.name} · {sel.client.phone}</h2>
          <p className="text-sm text-slate-500">Total gastado: {COP(sel.totalSpent)} · {sel.totalSales} ventas · Próxima cita: {sel.nextAppointment ? `${sel.nextAppointment.date} ${sel.nextAppointment.startTime} ${sel.nextAppointment.serviceName}` : 'ninguna'}</p>
          <div className="grid md:grid-cols-3 gap-3 mt-3">
            <label className="text-sm">Alergias<textarea className={input} value={sel.client.allergies || ''} onChange={(e) => setSel({ ...sel, client: { ...sel.client, allergies: e.target.value } })} /></label>
            <label className="text-sm">Fórmula / color usado<textarea className={input} value={sel.client.formula || ''} onChange={(e) => setSel({ ...sel, client: { ...sel.client, formula: e.target.value } })} /></label>
            <label className="text-sm">Notas<textarea className={input} value={sel.client.notes || ''} onChange={(e) => setSel({ ...sel, client: { ...sel.client, notes: e.target.value } })} /></label>
          </div>
          <p className="text-xs text-slate-400 mt-2">Autorización Ley 1581: {sel.client.dataConsent ? `sí, ${sel.client.dataConsentAt || ''}` : 'sin registrar'}</p>
          <div className="flex gap-2 mt-3">{canEdit ? <button className={btn} onClick={saveFicha}>Guardar ficha</button> : <p className="text-xs text-slate-400">Solo lectura: la profesional no edita fichas.</p>}<button className="px-4 py-2 rounded-xl border text-sm font-bold" onClick={() => setSel(null)}>Cerrar</button></div>
          <h3 className="font-bold mt-4">Historial</h3>
          {sel.history.map((a: any) => <p key={a.id} className="text-sm py-1 border-b border-slate-100">{a.date} {a.startTime} · {a.serviceName} · {a.professionalName} · {a.status} · {COP(a.price)}</p>)}
        </div>
      )}
    </div>
  );
}
