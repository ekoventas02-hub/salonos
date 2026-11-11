
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

export function SalonProducts() {
  const [list, setList] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', category: 'esmaltes', stock: 5, minStock: 2, cost: 10000, price: 25000 });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const EMPTY = { name: '', category: 'esmaltes', stock: 5, minStock: 2, cost: 10000, price: 25000 };
  const load = () => { apiFetch('/api/salon/products').then(j).then(setList).catch((e: any) => setErr(e.message)); apiFetch('/api/salon/products/alerts').then(j).then(setAlerts).catch(() => {}); };
  useEffect(() => { load(); }, []);
  // AUDITORÍA v1.1: antes el formulario no se limpiaba tras crear y no
  // había forma de editar ni borrar, ni se veían las alertas de stock.
  const save = async (e: any) => {
    e.preventDefault();
    try {
      if (editingId) await j(await apiFetch(`/api/salon/products/${editingId}`, { method: 'PUT', body: JSON.stringify(form) }));
      else await j(await apiFetch('/api/salon/products', { method: 'POST', body: JSON.stringify(form) }));
      setForm(EMPTY); setEditingId(null); load();
    } catch (ex: any) { setErr(ex.message); }
  };
  const edit = (p: any) => { setEditingId(p.id); setForm({ name: p.name, category: p.category, stock: p.stock, minStock: p.minStock, cost: p.cost, price: p.price }); };
  const del = async (id: number) => { if (!confirm('¿Eliminar este producto?')) return; try { await j(await apiFetch(`/api/salon/products/${id}`, { method: 'DELETE' })); load(); } catch (ex: any) { setErr(ex.message); } };
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Inventario de belleza</h1>
      <p className="text-sm text-slate-500">Retail (lo que se vende en caja) y control de stock. Al completar una cita puedes descontar los insumos usados y ver el costo real del servicio.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <form onSubmit={save} className={`${card} grid grid-cols-2 md:grid-cols-3 gap-3`}>
        <input className={input} placeholder="Producto *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <select className={input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option>esmaltes</option><option>tintes</option><option>acrílico</option><option>cremas</option><option>general</option></select>
        <input className={input} type="number" placeholder="Stock" value={form.stock} onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })} />
        <input className={input} type="number" placeholder="Stock mínimo" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: Number(e.target.value) })} />
        <input className={input} type="number" placeholder="Costo" value={form.cost} onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })} />
        <input className={input} type="number" placeholder="Precio de venta" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
        <button className={btn}>{editingId ? 'Guardar cambios' : 'Agregar producto'}</button>
        {editingId && <button type="button" className="px-4 py-2 rounded-xl border text-sm font-bold" onClick={() => { setEditingId(null); setForm(EMPTY); }}>Cancelar edición</button>}
      </form>
      {alerts.length > 0 && <div className={`${card} border-red-200 bg-red-50`}><h2 className="font-bold text-red-700">⚠️ Stock bajo</h2>{alerts.map((p: any) => <p key={p.id} className="text-sm text-red-600 py-1">{p.name}: quedan {p.stock} (mínimo {p.minStock})</p>)}</div>}
      <div className={card}>
        {list.map((p: any) => (
          <div key={p.id} className="flex justify-between py-2 border-b border-slate-100 text-sm"><span><b>{p.name}</b> · {p.category} {p.lowStock && <span className="text-red-600 font-bold">· ¡STOCK BAJO!</span>}</span><span>Stock {p.stock} (mín. {p.minStock}) · costo {COP(p.cost)} · venta {COP(p.price)}</span><span className="flex gap-2"><button className="text-brand-600 font-bold" onClick={() => edit(p)}>Editar</button><button className="text-red-600 font-bold" onClick={() => del(p.id)}>Eliminar</button></span></div>
        ))}
        {list.length === 0 && <p className="text-sm text-slate-500">Sin productos.</p>}
      </div>
    </div>
  );
}
