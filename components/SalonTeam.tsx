
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

export function SalonTeam({ currentUser }: any) {
  const [staff, setStaff] = useState<any[]>([]);
  const [pros, setPros] = useState<any[]>([]);
  const [avail, setAvail] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', role: 'estilista', commissionPct: 45 });
  const load = () => {
    apiFetch('/api/staff').then(j).then(setStaff).catch((e: any) => setErr(e.message));
    apiFetch('/api/salon/professionals').then(j).then(setPros).catch(() => {});
    apiFetch('/api/salon/professionals/availability').then(j).then((d: any) => setAvail(d.professionals || [])).catch(() => {});
    apiFetch('/api/salon/catalog-services').then(j).then(setServices).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  // v1.3 (disponibilidad): insignia por profesional, calculada en el
  // servidor con su horario del día, sus citas de hoy y la hora de Bogotá.
  const availOf = (id: number) => avail.find((a: any) => a.id === id);
  const availBadge = (a: any) => {
    if (!a) return null;
    const color = a.status === 'disponible' ? 'bg-emerald-100 text-emerald-800' : a.status === 'ocupada' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600';
    return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${color}`}>{a.label}{!a.isOnline ? ' · sin conexión' : ''}</span>;
  };
  const servicesOf = (id: number) => {
    const p = pros.find((x: any) => x.id === id);
    const ids: number[] = p?.serviceIds || [];
    if (!ids.length) return 'todos los servicios';
    return services.filter((s: any) => ids.includes(s.id)).map((s: any) => s.name).join(', ') || 'todos los servicios';
  };
  // Editor de horario por día (employees.schedule: {"1":["09:00","19:00"],…}, 0=Dom).
  const DAYS: [string, string][] = [['1', 'Lunes'], ['2', 'Martes'], ['3', 'Miércoles'], ['4', 'Jueves'], ['5', 'Viernes'], ['6', 'Sábado'], ['0', 'Domingo']];
  const [showSched, setShowSched] = useState<number | null>(null);
  const [schedDraft, setSchedDraft] = useState<any>({});
  const openSched = (m: any) => {
    const p = pros.find((x: any) => x.id === m.id);
    const s: any = {};
    DAYS.forEach(([k]) => {
      const v = (p?.schedule || {})[k];
      // Sin entrada guardada, el horario efectivo es Lun–Sáb 09:00–19:00, Dom cerrado;
      // el editor muestra ese efectivo para que vaciar un día sea explícito.
      if (Array.isArray(v)) s[k] = { start: v[0] || '', end: v[1] || '' };
      else s[k] = k === '0' ? { start: '', end: '' } : { start: '09:00', end: '19:00' };
    });
    setSchedDraft(s); setShowSched(m.id);
  };
  const saveSched = async (id: number) => {
    try {
      const schedule: any = {};
      DAYS.forEach(([k]) => { const d = schedDraft[k]; schedule[k] = (d?.start && d?.end) ? [d.start, d.end] : ['', '']; }); // día vacío = no trabaja (sin fallback)
      await j(await apiFetch(`/api/salon/professionals/${id}/schedule`, { method: 'PUT', body: JSON.stringify({ schedule }) }));
      setShowSched(null); load();
    } catch (ex: any) { setErr(ex.message); }
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const EMPTY = { name: '', email: '', password: '', phone: '', role: 'estilista', commissionPct: 45 };
  // AUDITORÍA v1.1: antes no se podía editar un empleado (PUT /api/staff/:id
  // no lo llamaba nadie) y la contraseña era obligatoria siempre. Al editar,
  // la contraseña vacía deja la clave actual intacta.
  const save = async (e: any) => {
    e.preventDefault();
    try {
      const body: any = { ...form };
      if (editingId && !body.password) delete body.password;
      if (editingId) await j(await apiFetch(`/api/staff/${editingId}`, { method: 'PUT', body: JSON.stringify(body) }));
      else await j(await apiFetch('/api/staff', { method: 'POST', body: JSON.stringify(body) }));
      setForm(EMPTY); setEditingId(null); load();
    } catch (ex: any) { setErr(ex.message); }
  };
  const edit = (m: any) => { setEditingId(String(m.id)); setForm({ name: m.name, email: m.email, password: '', phone: m.phone || '', role: m.role, commissionPct: m.commissionPct || 0 }); };
  const del = async (id: string) => { if (!confirm('¿Desactivar a esta persona?')) return; await j(await apiFetch(`/api/staff/${id}`, { method: 'DELETE' })); load(); };
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Equipo del salón</h1>
      <p className="text-sm text-slate-500">Roles: <b>admin</b> (todo), <b>recepcionista</b> (agenda, clientas y caja; sin ajustes ni DIAN), <b>estilista / manicurista</b> (solo sus citas, sus clientas y sus comisiones).</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {currentUser.role === 'admin' && (
        <form onSubmit={save} className={`${card} grid grid-cols-2 md:grid-cols-3 gap-3`}>
          <input className={input} placeholder="Nombre *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input className={input} placeholder="Correo *" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <input className={input} type="password" placeholder={editingId ? 'Contraseña (vacía = no cambiar)' : 'Contraseña *'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!editingId} />
          <input className={input} placeholder="Teléfono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="estilista">Estilista</option><option value="manicurista">Manicurista</option><option value="recepcionista">Recepcionista</option><option value="admin">Admin del salón</option></select>
          <input className={input} type="number" placeholder="Comisión % (si el servicio no la fija)" value={form.commissionPct} onChange={(e) => setForm({ ...form, commissionPct: Number(e.target.value) })} />
          <button className={btn}>{editingId ? 'Guardar cambios' : 'Agregar persona'}</button>
          {editingId && <button type="button" className="px-4 py-2 rounded-xl border text-sm font-bold" onClick={() => { setEditingId(null); setForm(EMPTY); }}>Cancelar edición</button>}
        </form>
      )}
      <div className={card}>
        {staff.map((m: any) => (
          <div key={m.id} className="py-2 border-b border-slate-100 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span><b>{m.name}</b> · {m.role} · {m.email} · comisión base {m.commissionPct || 0}% {['estilista', 'manicurista'].includes(m.role) && <span className="text-slate-500">· hace: {servicesOf(m.id)}</span>} {availBadge(availOf(m.id))}</span>
              {currentUser.role === 'admin' && <span className="flex gap-2"><button className="text-brand-600 font-bold" onClick={() => edit(m)}>Editar</button>{['estilista', 'manicurista'].includes(m.role) && <button className="text-brand-600 font-bold" onClick={() => (showSched === m.id ? setShowSched(null) : openSched(m))}>Horario</button>}<button className="text-red-600 font-bold" onClick={() => del(m.id)}>Desactivar</button></span>}
            </div>
            {showSched === m.id && (
              <div className="mt-2 p-3 bg-slate-50 rounded-xl space-y-1">
                <p className="text-xs font-bold text-slate-600">Horario de {m.name} (vacío = no trabaja ese día; sin guardar, Lun–Sáb 09:00–19:00 y Dom cerrado)</p>
                {DAYS.map(([k, label]) => (
                  <div key={k} className="flex items-center gap-2 text-xs">
                    <span className="w-20 font-bold">{label}</span>
                    <input type="time" className={input + ' w-auto py-1'} value={schedDraft[k]?.start || ''} onChange={(e) => setSchedDraft({ ...schedDraft, [k]: { ...(schedDraft[k] || {}), start: e.target.value } })} />
                    <span>a</span>
                    <input type="time" className={input + ' w-auto py-1'} value={schedDraft[k]?.end || ''} onChange={(e) => setSchedDraft({ ...schedDraft, [k]: { ...(schedDraft[k] || {}), end: e.target.value } })} />
                  </div>
                ))}
                <button className={btn + ' mt-2'} onClick={() => saveSched(m.id)}>Guardar horario</button>
              </div>
            )}
          </div>
        ))}
        {staff.length === 0 && <p className="text-sm text-slate-500">Sin equipo en este salón.</p>}
      </div>
    </div>
  );
}
