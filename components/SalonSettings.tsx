import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
export async function j(res: Response) {
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || ('Error ' + res.status));
  return d;
}
export const btn = 'bg-brand-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-brand-700 disabled:opacity-50';
export const input = 'w-full border border-slate-300 rounded-xl px-3 py-2 text-sm';
export const card = 'bg-white border border-slate-200 rounded-2xl p-4';

// v1.3 (anticipo opcional): Ajustes del salón — anticipo por defecto.
// Regla efectiva, en orden: % del servicio si está fijado, si no el del
// salón (este campo), si no 20 %. Con 0 % la cita se confirma sin pago y
// el bot no pide link; con >0 % sigue el flujo actual (pendiente + link).
export function SalonSettings() {
  const [salon, setSalon] = useState<any>(null);
  const [pct, setPct] = useState<number>(20);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => {
    apiFetch('/api/salons/me').then(j).then((s: any) => { setSalon(s); setPct(Number(s.default_deposit_pct ?? 20)); }).catch((e: any) => setErr(e.message));
  };
  useEffect(load, []);
  const save = async (e: any) => {
    e.preventDefault(); setErr(''); setMsg('');
    try {
      const s = await j(await apiFetch('/api/salons/me/settings', { method: 'PUT', body: JSON.stringify({ default_deposit_pct: Number(pct) }) }));
      setSalon(s); setMsg(Number(pct) === 0 ? 'Guardado: sin anticipo por defecto. Las citas de servicios sin % propio se confirman sin pago.' : `Guardado: anticipo por defecto ${Number(pct)} %.`);
    } catch (ex: any) { setErr(ex.message); }
  };
  if (!salon && !err) return <div className="p-6 text-sm text-slate-500">Cargando ajustes…</div>;
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Ajustes del salón</h1>
      <p className="text-sm text-slate-500">El anticipo es <b>opcional</b>: cada servicio puede fijar su propio % en el Catálogo; este valor solo se usa cuando el servicio no tiene % propio.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">{msg}</p>}
      <form onSubmit={save} className={`${card} space-y-3 max-w-lg`}>
        <p className="text-sm"><b>{salon?.name}</b> <span className="text-slate-500">· {salon?.city || ''}</span></p>
        <label className="block text-sm font-bold text-slate-700">Anticipo por defecto del salón (%)
          <input className={input + ' mt-1'} type="number" min={0} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
        </label>
        <p className="text-xs text-slate-500">
          {Number(pct) === 0
            ? '0 % = sin anticipo por defecto: las citas de servicios sin % propio se confirman sin pedir pago ni mandar link (en la web, en la agenda y en el bot).'
            : `Con ${Number(pct)} %: una cita de $100.000 pide $${(100000 * Number(pct) / 100).toLocaleString('es-CO')} de anticipo y queda pendiente hasta pagarlo.`}
          {' '}El % de cada servicio (Catálogo) manda sobre este valor.
        </p>
        <button className={btn}>Guardar ajustes</button>
      </form>
    </div>
  );
}
