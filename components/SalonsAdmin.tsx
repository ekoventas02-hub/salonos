
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

import { setToken } from '../lib/api';
export function SalonsAdmin({ currentUser, onEnterSalon }: any) {
  const [salons, setSalons] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', slug: '', phone: '', city: '', address: '', type: 'mixto', plan: 'basico' });
  const load = () => apiFetch('/api/salons').then(j).then(setSalons).catch((e: any) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const create = async (e: any) => {
    e.preventDefault(); setErr('');
    try { await j(await apiFetch('/api/salons', { method: 'POST', body: JSON.stringify(form) })); setForm({ name: '', slug: '', phone: '', city: '', address: '', type: 'mixto', plan: 'basico' }); load(); }
    catch (ex: any) { setErr(ex.message); }
  };
  const toggle = async (s: any) => { await j(await apiFetch(`/api/salons/${s.id}/estado`, { method: 'PATCH', body: JSON.stringify({ active: !s.active }) })); load(); };
  const toggleBot = async (s: any) => { await j(await apiFetch(`/api/salons/${s.id}/bot`, { method: 'POST', body: JSON.stringify({ enabled: !s.bot_enabled }) })); load(); };
  const enter = async (s: any) => {
    const d = await j(await apiFetch(`/api/salons/${s.id}/token`, { method: 'POST' }));
    // AUDITORÍA v1.1: antes entrar al salón era un viaje sin regreso (el
    // token de superadmin se perdía). Se guarda para poder volver.
    try {
      const cur = localStorage.getItem('salonos_session');
      const tok = localStorage.getItem('salonos_token') || '';
      if (cur && tok) localStorage.setItem('salonos_superadmin_session', JSON.stringify({ user: JSON.parse(cur), token: tok }));
    } catch {}
    setToken(d.token);
    try { localStorage.setItem('salonos_session', JSON.stringify(d.user)); } catch {}
    onEnterSalon(d.user);
  };
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Salones de la plataforma</h1>
      <p className="text-sm text-slate-500">Como superadmin creas salones y ves su salud. Para ver sus clientas o su caja, entra al salón con un token de 1 hora (queda auditado).</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <form onSubmit={create} className={`${card} grid grid-cols-2 md:grid-cols-3 gap-3`}>
        <input className={input} placeholder="Nombre del salón *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-') })} required />
        <input className={input} placeholder="slug (link de reserva) *" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
        <input className={input} placeholder="Teléfono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input className={input} placeholder="Ciudad" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        <input className={input} placeholder="Dirección" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        <select className={input} value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
          <option value="basico">Plan básico</option><option value="premium">Plan premium</option><option value="pro">Plan pro</option>
        </select>
        <select className={input} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          <option value="mixto">Mixto (uñas + peluquería)</option><option value="unas">Solo uñas</option><option value="peluqueria">Peluquería</option><option value="barberia">Barbería</option><option value="spa">Spa</option>
        </select>
        <button className={btn}>Crear salón (con catálogo inicial)</button>
      </form>
      <div className="space-y-3">
        {salons.map((s: any) => (
          <div key={s.id} className={`${card} flex flex-wrap items-center gap-4 justify-between`}>
            <div>
              <p className="font-bold">{s.name} <span className={`text-xs px-2 py-0.5 rounded-full ${s.active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{s.active ? 'Activo' : 'Inactivo'}</span></p>
              <p className="text-sm text-slate-500">/{s.slug} · {s.city || ''} · Plan {s.plan} · {s.staff_count} personas · {s.appointments_today} citas hoy · Ventas hoy {COP(s.sales_today)}</p>
              <p className="text-xs text-slate-400">Bot de reservas: {s.bot_enabled ? '🟢 encendido' : '⚪ apagado'}</p>
              <p className="text-xs text-slate-400">Link de reserva pública: /reserva/{s.slug}</p>
            </div>
            <div className="flex gap-2">
              <button className="text-xs font-bold border px-3 py-1.5 rounded-lg" onClick={() => toggleBot(s)}>Bot: {s.bot_enabled ? 'apagar' : 'encender'}</button>
              <button className={btn} onClick={() => enter(s)}>Entrar al salón</button>
              <button className="px-4 py-2 rounded-xl text-sm font-bold border" onClick={() => toggle(s)}>{s.active ? 'Desactivar' : 'Activar'}</button>
            </div>
          </div>
        ))}
        {salons.length === 0 && <p className="text-sm text-slate-500">Aún no hay salones. Crea el primero arriba.</p>}
      </div>
    </div>
  );
}
