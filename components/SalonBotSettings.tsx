// Bot de reservas por WhatsApp v1.1 — interruptor por salón + conversaciones activas.
// Solo lo ve el admin del salón (la vista Canales WhatsApp ya es solo admin).
// El cambio tiene efecto inmediato, sin reiniciar el servidor.
import React, { useEffect, useState } from 'react';
import { Bot, Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../lib/api';

async function j(res: Response) {
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || ('Error ' + res.status));
  return d;
}

export function SalonBotSettings() {
  const [status, setStatus] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => {
    apiFetch('/api/salon/bot/status').then(j).then(setStatus).catch((e: any) => setErr(e.message));
    apiFetch('/api/salon/bot/sessions').then(j).then(setSessions).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const toggle = async () => {
    setBusy(true); setErr('');
    try {
      const r = await j(await apiFetch('/api/salon/bot/toggle', { method: 'POST', body: JSON.stringify({ enabled: !status?.enabled }) }));
      setStatus(r); load();
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const resume = async (phone: string) => {
    try { await j(await apiFetch('/api/salon/bot/resume', { method: 'POST', body: JSON.stringify({ phone }) })); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const fmtWhen = (v: string) => {
    if (!v) return '';
    try { return new Date(v).toLocaleString('es-CO', { timeZone: 'America/Bogota' }); } catch { return v; }
  };
  return (
    <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm">
      <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2 flex items-center gap-2">
        <Bot className="w-4 h-4 text-brand-600" /> Bot de reservas por WhatsApp
      </h3>
      <p className="text-[11px] text-slate-500 font-medium leading-relaxed mb-4">
        Atiende por WhatsApp y agenda solo: saluda con el nombre del salón, muestra servicios,
        profesional (o primera disponible), huecos reales sin cruces, pide nombre y teléfono,
        crea la cita y manda el link de anticipo (Wompi/PayU) si el servicio lo exige.
        También cancela, reprograma y responde S/N a los recordatorios. Funciona en QR y en Meta
        con el mismo motor. No es IA: son reglas y menú, en español.
      </p>
      {err && <p className="text-[11px] text-red-600 font-bold mb-2">{err}</p>}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-bold text-slate-700">
          {status?.enabled
            ? <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-4 h-4" /> Encendido</span>
            : <span className="text-slate-400">Apagado — el bot no responde nada</span>}
          {status?.changedBy && (
            <p className="text-[10px] text-slate-400 font-medium mt-1">Último cambio: {status.changedBy}{status.changedAt ? ` · ${fmtWhen(status.changedAt)}` : ''}</p>
          )}
        </div>
        <button onClick={toggle} disabled={busy}
          className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors ${status?.enabled ? 'bg-emerald-500' : 'bg-slate-200'}`}
          title={status?.enabled ? 'Apagar el bot' : 'Encender el bot'}>
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${status?.enabled ? 'translate-x-8' : 'translate-x-1'}`} />
        </button>
      </div>
      <p className="text-[10px] text-slate-400 font-medium leading-relaxed mt-3">
        Apagado: cero respuestas automáticas, los mensajes quedan en el inbox sin contestar.
        Encendido: responde solo a clientas con cita o que piden reservar, nunca campañas ni spam.
        Si la clienta pide una persona, el bot se pausa para ella (estado "human").
      </p>
      {sessions.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Conversaciones activas con el bot</p>
          {sessions.map((s: any) => (
            <div key={s.client_phone} className="flex items-center justify-between py-1 text-xs">
              <span>{s.client_phone} · {s.state === 'human' ? '👩‍💼 con persona (bot pausado)' : s.state}</span>
              {s.state === 'human' && (
                <button className="text-brand-600 font-bold flex items-center gap-1" onClick={() => resume(s.client_phone)}>
                  <RefreshCw className="w-3 h-3" /> Volver al bot
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400 mt-2" />}
    </div>
  );
}
