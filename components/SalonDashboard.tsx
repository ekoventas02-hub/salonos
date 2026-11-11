
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

export function SalonDashboard({ currentUser }: any) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { apiFetch('/api/salon/dashboard').then(j).then(setD).catch((e: any) => setErr(e.message)); }, []);
  if (err) return <div className="p-6 text-red-600 text-sm">{err}</div>;
  if (!d) return <div className="p-6 text-sm text-slate-500">Cargando panel del salón…</div>;
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Panel del salón — hoy {d.date}</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={card}><p className="text-xs uppercase text-slate-500 font-bold">Citas hoy</p><p className="text-2xl font-black">{d.appointmentsTodayTotal}</p><p className="text-xs text-slate-500">Confirmadas: {d.appointmentsToday.confirmada || 0} · Pendientes: {d.appointmentsToday.pendiente || 0} · Completadas: {d.appointmentsToday.completada || 0}</p></div>
        <div className={card}><p className="text-xs uppercase text-slate-500 font-bold">Ventas hoy</p><p className="text-2xl font-black">{COP(d.salesToday.total)}</p><p className="text-xs text-slate-500">{d.salesToday.count} ventas</p></div>
        <div className={card}><p className="text-xs uppercase text-slate-500 font-bold">Ventas del mes</p><p className="text-2xl font-black">{COP(d.salesMonth.total)}</p><p className="text-xs text-slate-500">{d.salesMonth.count} ventas</p></div>
        <div className={card}><p className="text-xs uppercase text-slate-500 font-bold">Clientas nuevas (mes)</p><p className="text-2xl font-black">{d.newClientsMonth}</p><p className="text-xs text-slate-500">Productos con stock bajo: {d.lowStockCount}</p></div>
      </div>
      <div className={card}>
        <h2 className="font-bold mb-2">Servicios más vendidos (30 días)</h2>
        {d.topServices.length === 0 ? <p className="text-sm text-slate-500">Aún no hay citas completadas.</p> : d.topServices.map((t: any) => (
          <div key={t.service} className="flex justify-between text-sm py-1 border-b border-slate-100"><span>{t.service} × {t.count}</span><b>{COP(t.total)}</b></div>
        ))}
      </div>
      <p className="text-xs text-slate-400">Totales calculados en el servidor para tu salón y tu rol ({d.scope.role}).</p>
    </div>
  );
}
