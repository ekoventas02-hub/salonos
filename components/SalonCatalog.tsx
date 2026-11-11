
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

export function SalonCatalog() {
  const [list, setList] = useState<any[]>([]);
  const [pros, setPros] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<any>({ name: '', category: 'uñas', durationMinutes: 60, cleanupMinutes: 15, price: 50000, commissionPct: 45, depositPct: 20, teamSize: 1, requiresConsent: false, retouchDays: '', professionalIds: [] as number[] });
  const load = () => { apiFetch('/api/salon/catalog-services').then(j).then(setList).catch((e: any) => setErr(e.message)); apiFetch('/api/salon/professionals').then(j).then(setPros).catch(() => {}); };
  useEffect(load, []);
  const save = async (e: any) => { e.preventDefault(); try { await j(await apiFetch('/api/salon/catalog-services', { method: 'POST', body: JSON.stringify(form) })); setForm({ name: '', category: 'uñas', durationMinutes: 60, cleanupMinutes: 15, price: 50000, commissionPct: 45, depositPct: 20, teamSize: 1, requiresConsent: false, retouchDays: '', professionalIds: [] }); load(); } catch (ex: any) { setErr(ex.message); } };
  const del = async (id: number) => { if (!confirm('¿Desactivar este servicio?')) return; await j(await apiFetch(`/api/salon/catalog-services/${id}`, { method: 'DELETE' })); load(); };
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Catálogo de servicios</h1>
      <p className="text-sm text-slate-500">La comisión y el anticipo que pongas aquí quedan <b>congelados en cada cita al agendar</b>: si los cambias mañana, las citas viejas no se reescriben.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <form onSubmit={save} className={`${card} grid grid-cols-2 md:grid-cols-4 gap-3`}>
        <input className={input} placeholder="Nombre del servicio *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <select className={input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option>uñas</option><option>cabello</option><option>cejas/pestañas</option><option>maquillaje</option><option>spa</option><option>general</option></select>
        <input className={input} type="number" placeholder="Duración (min)" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
        <input className={input} type="number" placeholder="Limpieza (min)" value={form.cleanupMinutes} onChange={(e) => setForm({ ...form, cleanupMinutes: Number(e.target.value) })} />
        <input className={input} type="number" placeholder="Precio COP" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
        <input className={input} type="number" placeholder="Comisión %" value={form.commissionPct} onChange={(e) => setForm({ ...form, commissionPct: Number(e.target.value) })} />
        <input className={input} type="number" min={0} max={100} placeholder="Anticipo % (0 = sin anticipo)" title="0 % = sin anticipo: la cita se confirma sin pago. Vacío o sin valor = anticipo por defecto del salón (Ajustes del salón)." value={form.depositPct} onChange={(e) => setForm({ ...form, depositPct: Number(e.target.value) })} />
        <select className={input} value={form.teamSize} onChange={(e) => setForm({ ...form, teamSize: Number(e.target.value) })}><option value={1}>1 profesional</option><option value={2}>A 4 manos (2 profesionales)</option></select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requiresConsent} onChange={(e) => setForm({ ...form, requiresConsent: e.target.checked })} /> Requiere consentimiento</label>
        <div className="col-span-2 md:col-span-4">
          <p className="text-xs font-bold text-slate-600 mb-1">¿Quiénes hacen este servicio? <span className="font-normal">(vacío = todas las profesionales)</span></p>
          <div className="flex flex-wrap gap-3">
            {pros.map((p: any) => (
              <label key={p.id} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={(form.professionalIds || []).includes(p.id)} onChange={(e) => setForm({ ...form, professionalIds: e.target.checked ? [...(form.professionalIds || []), p.id] : (form.professionalIds || []).filter((x: number) => x !== p.id) })} /> {p.name}
              </label>
            ))}
            {pros.length === 0 && <span className="text-xs text-slate-500">Aún no hay profesionales en el equipo.</span>}
          </div>
        </div>
        <input className={input} type="number" placeholder="Retoque cada (días, vacío = sin seguimiento)" value={form.retouchDays} onChange={(e) => setForm({ ...form, retouchDays: e.target.value === '' ? '' : Number(e.target.value) })} title="Cada cuántos días después de la cita completada se avisa para el retoque (ej. tinte 21, keratina 90). Vacío = sin seguimiento." />
        <button className={btn}>Agregar servicio</button>
      </form>
      <div className={card}>
        {list.map((s: any) => (
          <div key={s.id} className="flex flex-wrap justify-between gap-2 py-2 border-b border-slate-100 text-sm">
            <span><b>{s.name}</b> <span className="text-slate-500">· {s.category} · {s.durationMinutes} min (+{s.cleanupMinutes} limpieza) · {s.teamSize >= 2 ? 'a 4 manos · ' : ''}{s.requiresConsent ? 'consentimiento · ' : ''}{s.retouchDays ? `retoque cada ${s.retouchDays} días · ` : ''}{(s.professionalIds || []).length ? `lo hacen: ${(s.professionalIds || []).map((id: number) => (pros.find((p: any) => p.id === id) || {}).name || `#${id}`).join(', ')} · ` : ''}</span></span>
            <span>{COP(s.price)} · comisión {s.commissionPct}% · {Number(s.depositPct) > 0 ? `anticipo ${s.depositPct}%` : 'sin anticipo'} <button className="text-red-600 font-bold ml-3" onClick={() => del(s.id)}>Desactivar</button></span>
          </div>
        ))}
        {list.length === 0 && <p className="text-sm text-slate-500">Sin servicios activos.</p>}
      </div>
    </div>
  );
}
