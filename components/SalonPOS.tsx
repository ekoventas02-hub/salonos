
import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, paymentMethodLabel } from '../lib/paymentMethods';
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
export const METHODS = PAYMENT_METHODS;

export function SalonPOS() {
  const [pros, setPros] = useState<any[]>([]);
  const [tipPro, setTipPro] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientName, setClientName] = useState('');
  const [products, setProducts] = useState<any[]>([]);
  const [sales, setSales] = useState<any[]>([]);
  const [close, setClose] = useState<any>(null);
  const [date, setDate] = useState(todayStr());
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [items, setItems] = useState<any[]>([{ productId: '', qty: 1 }]);
  const [payments, setPayments] = useState<any[]>([{ method: 'efectivo', amount: '', reference: '' }]);
  const [discount, setDiscount] = useState(0);
  const [tip, setTip] = useState(0);
  const load = () => {
    apiFetch('/api/salon/professionals').then(j).then(setPros).catch(() => {});
    apiFetch('/api/salon/products').then(j).then(setProducts).catch(() => {});
    apiFetch(`/api/salon/pos/sales?date=${date}`).then(j).then(setSales).catch((e: any) => setErr(e.message));
    apiFetch(`/api/salon/pos/cash-close?date=${date}`).then(j).then(setClose).catch(() => {});
  };
  useEffect(load, [date]);
  const subtotal = items.reduce((a, it) => { const p = products.find((x: any) => String(x.id) === String(it.productId)); return a + (p ? Number(p.price) * (Number(it.qty) || 1) : 0); }, 0);
  const total = Math.max(0, subtotal - Number(discount)) + Number(tip);
  const sell = async () => {
    setErr(''); setMsg('');
    try {
      const pays = payments.map((p: any) => ({ method: p.method, amount: p.amount === '' ? null : Number(p.amount), reference: p.reference || null }));
      const r = await j(await apiFetch('/api/salon/pos/sale', { method: 'POST', body: JSON.stringify({ items: items.filter((i: any) => i.productId).map((i: any) => ({ productId: Number(i.productId), qty: Number(i.qty) || 1 })), payments: pays, discount: Number(discount), tip: Number(tip), tipProfessionalId: tipPro ? Number(tipPro) : null, clientPhone: clientPhone || null, clientName: clientName || null }) }));
      setMsg(`Venta registrada: ${COP(r.sale.total)}. Documento: ${r.document.type === 'dee_pos' ? 'DEE POS (tiquete)' : 'factura electrónica plena'}. ${r.note}`);
      setItems([{ productId: '', qty: 1 }]); setPayments([{ method: 'efectivo', amount: '', reference: '' }]); setDiscount(0); setTip(0); setTipPro(''); setClientPhone(''); setClientName(''); load();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-black text-slate-800">Caja / POS</h1>
      <p className="text-sm text-slate-500">Pago mixto colombiano: una venta se puede partir en Nequi + Bre-B / Llave Nu + efectivo. La referencia o comprobante es opcional. La propina va 100 % para la profesional. El cierre cuadra por método, con totales del servidor.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {msg && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">{msg}</p>}
      <div className={card}>
        <h2 className="font-bold mb-2">Venta de mostrador</h2>
        {items.map((it: any, i: number) => (
          <div key={i} className="flex gap-2 mb-2">
            <select className={input} value={it.productId} onChange={(e) => setItems(items.map((x: any, xi: number) => xi === i ? { ...x, productId: e.target.value } : x))}>
              <option value="">Producto</option>
              {products.map((p: any) => <option key={p.id} value={p.id}>{p.name} · {COP(p.price)} (stock {p.stock})</option>)}
            </select>
            <input className={input + ' w-24'} type="number" value={it.qty} onChange={(e) => setItems(items.map((x: any, xi: number) => xi === i ? { ...x, qty: Number(e.target.value) } : x))} />
          </div>
        ))}
        <button className="text-sm font-bold text-brand-600" onClick={() => setItems([...items, { productId: '', qty: 1 }])}>+ Agregar producto</button>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <label className="text-sm">Descuento<input className={input} type="number" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></label>
          <label className="text-sm">Propina<input className={input} type="number" value={tip} onChange={(e) => setTip(Number(e.target.value))} /></label>
          <label className="text-sm">Propina para (profesional)<select className={input} value={tipPro} onChange={(e) => setTipPro(e.target.value)}><option value="">Sin asignar</option>{pros.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="text-sm">Clienta (teléfono)<input className={input} placeholder="300 123 4567" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} /></label>
          <label className="text-sm">Clienta (nombre)<input className={input} placeholder="Nombre" value={clientName} onChange={(e) => setClientName(e.target.value)} /></label>
        </div>
        <p className="text-xs text-slate-400 mt-1">Sin profesional, la propina queda sin atribuir y la venta como "Mostrador".</p>
        <h3 className="font-bold mt-3 mb-1">Pago mixto</h3>
        {payments.map((p: any, i: number) => (
          <div key={i} className="flex gap-2 mb-2">
            <select className={input} value={p.method} onChange={(e) => setPayments(payments.map((x: any, xi: number) => xi === i ? { ...x, method: e.target.value } : x))}>
              {METHODS.map((m: string) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m] || m}</option>)}
            </select>
            <input className={input} type="number" placeholder="Monto (vacío = resto)" value={p.amount} onChange={(e) => setPayments(payments.map((x: any, xi: number) => xi === i ? { ...x, amount: e.target.value } : x))} />
            <input className={input} placeholder="Ref. / comprobante (opcional)" value={p.reference || ''} onChange={(e) => setPayments(payments.map((x: any, xi: number) => xi === i ? { ...x, reference: e.target.value } : x))} />
          </div>
        ))}
        <button className="text-sm font-bold text-brand-600" onClick={() => setPayments([...payments, { method: 'nequi', amount: '', reference: '' }])}>+ Otro método de pago</button>
        <p className="font-bold mt-3">Subtotal {COP(subtotal)} · Total con propina {COP(total)}</p>
        <button className={btn + ' mt-2'} onClick={sell}>Cobrar</button>
      </div>
      <div className={card}>
        <div className="flex items-center gap-3 justify-between"><h2 className="font-bold">Cierre de caja</h2><input type="date" className={input + ' w-auto'} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        {close && (
          <div className="text-sm mt-2">
            <p>Ventas: {close.salesCount} · Total: <b>{COP(close.total)}</b> · Propinas: {COP(close.tips)} · Descuentos: {COP(close.discounts)} · Anticipos: {COP(close.depositTotal)}</p>
            {Object.entries(close.byMethod || {}).map(([m, v]: any) => <p key={m} className="flex justify-between py-1 border-b border-slate-100"><span>{paymentMethodLabel(m)}</span><b>{COP(v)}</b></p>)}
            <p className="mt-2">Cobrado (total + propinas): <b>{COP(close.collected)}</b> · Suma por método: <b>{COP(close.byMethodSum)}</b> {close.collected === close.byMethodSum ? '· ✅ cuadra' : '· ⚠️ NO cuadra'}</p>
            <p className="text-xs text-slate-400 mt-2">{close.note}</p>
          </div>
        )}
        <h3 className="font-bold mt-4">Ventas del día</h3>
        {sales.map((s: any) => <p key={s.id} className="text-sm py-1 border-b border-slate-100">{new Date(s.created_at).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })} · {s.client_name || 'Mostrador'} · {COP(s.total)} · {(s.payment_methods || []).map((p: any) => `${paymentMethodLabel(p.method)} ${COP(p.amount)}${p.reference ? ` (ref. ${p.reference})` : ''}`).join(' + ')} · {s.document_type}</p>)}
        {sales.length === 0 && <p className="text-sm text-slate-500">Sin ventas este día.</p>}
      </div>
    </div>
  );
}
