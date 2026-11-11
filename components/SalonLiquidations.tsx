
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
export { PAYMENT_METHODS as METHODS } from '../lib/paymentMethods';

export function SalonLiquidations() {
  const [data, setData] = useState<any>(null);
  const [pros, setPros] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pro, setPro] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const load = () => {
    const q = new URLSearchParams();
    if (from) q.set('from', from); if (to) q.set('to', to); if (pro) q.set('professionalId', pro);
    apiFetch(`/api/salon/liquidations?${q.toString()}`).then(j).then(setData).catch((e: any) => setErr(e.message));
  };
  useEffect(() => { apiFetch('/api/salon/professionals').then(j).then(setPros).catch(() => {}); load(); }, []);
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Liquidación de comisiones</h1>
      <p className="text-sm text-slate-500">Cada cita guarda el % de comisión <b>congelado al agendar</b>. La liquidación solo suma lo guardado: si cambias el % del catálogo, las citas viejas no se reescriben. Propinas 100 % para la profesional.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className={`${card} flex flex-wrap gap-2`}>
        <input type="date" className={input + ' w-auto'} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className={input + ' w-auto'} value={to} onChange={(e) => setTo(e.target.value)} />
        <select className={input + ' w-auto'} value={pro} onChange={(e) => setPro(e.target.value)}><option value="">Todas las profesionales</option>{pros.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className={btn} onClick={load}>Liquidar</button>
      </div>
      {data && (
        <div className={card}>
          <p className="text-sm mb-3">Periodo {data.from || '…'} a {data.to || '…'} · Bruto total {COP(data.totals.gross)} · Comisiones {COP(data.totals.commission)} · Propinas {COP(data.totals.tips)} · <b>A pagar en total {COP(data.totals.totalToPay)}</b></p>
          {data.professionals.map((p: any) => (
            <div key={p.professionalId} className="py-3 border-b border-slate-100">
              <div className="flex justify-between text-sm"><span><b>{p.professionalName}</b> · {p.appointments} citas · Bruto {COP(p.gross)} · Descuentos {COP(p.discounts)} · Insumos {COP(p.supplies)} · Comisión {COP(p.commission)} · Propinas {COP(p.tips)}</span><span><b>A pagar: {COP(p.totalToPay)}</b> <button className="text-brand-600 font-bold ml-2" onClick={() => setOpen(open === p.professionalId ? null : p.professionalId)}>{open === p.professionalId ? 'Ocultar' : 'Detalle'}</button></span></div>
              {open === p.professionalId && p.detail.map((a: any) => (
                <p key={a.id} className="text-xs text-slate-500 py-1 pl-4">{a.date} · {a.service} · {a.client} · {COP(a.price)} − desc. {COP(a.discount)} − insumos {COP(a.supplies)} · comisión {a.commissionPctFrozen}% = {COP(a.commission)} · propina {COP(a.tip)}</p>
              ))}
            </div>
          ))}
          {data.professionals.length === 0 && <p className="text-sm text-slate-500">Sin citas completadas en ese periodo.</p>}
        </div>
      )}
    </div>
  );
}
