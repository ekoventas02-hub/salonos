// Seguimiento de retoque e inactivas (v1.3, adaptado de FollowUps/Campañas del CRM).
// El CRM recuerda a los 3/6 meses; en salón el ciclo lo marca el SERVICIO
// (retouch_days: tinte 21 días, keratina 90, manicura 15...), editable en
// Catálogo de servicios. Los recordatorios se mandan 1 a 1 por WhatsApp
// desde aquí; NO hay envío masivo (el bot prohíbe el spam y una campaña
// masiva por WhatsApp te puede bloquear el número).
import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Send, UserX, Loader2, MessageCircle } from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { CurrentUser } from '../types';

interface RetouchDue {
  id: number;
  service_name: string;
  client_name: string;
  client_phone: string;
  completed_date: string;
  professional_name: string | null;
  retouch_days: number;
  days_since: number;
  days_overdue: number;
}

interface InactiveClient {
  phone: string;
  name: string | null;
  last_visit: string | null;
  visits: number;
  days_since: number | null;
}

export const SalonRetouches: React.FC<{ currentUser: CurrentUser; onOpenChat?: (phone: string) => void }> = ({ currentUser, onOpenChat }) => {
  const [due, setDue] = useState<RetouchDue[]>([]);
  const [inactive, setInactive] = useState<InactiveClient[]>([]);
  const [inactiveDays, setInactiveDays] = useState(45);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [sendingId, setSendingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [r1, r2] = await Promise.all([
        apiFetch('/api/salon/retouches/due'),
        apiFetch(`/api/salon/clients/inactive?days=${inactiveDays}`),
      ]);
      const j1 = await r1.json().catch(() => []);
      const j2 = await r2.json().catch(() => []);
      if (!r1.ok) throw new Error(j1.error || 'No se pudo cargar los retoques');
      if (!r2.ok) throw new Error(j2.error || 'No se pudo cargar las inactivas');
      setDue(Array.isArray(j1) ? j1 : []);
      setInactive(Array.isArray(j2) ? j2 : []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [inactiveDays]);

  useEffect(() => { load(); }, [load]);

  const sendRetouch = async (id: number) => {
    setSendingId(id);
    setMessage('');
    try {
      const res = await apiFetch(`/api/salon/retouches/${id}/send`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo enviar el recordatorio');
      setMessage('Recordatorio de retoque enviado por WhatsApp.');
      await load();
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setSendingId(null);
    }
  };

  const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Cargando seguimiento…
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-brand-600" /> Retoques y seguimiento
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Cuando se cumple el ciclo de un servicio (tinte, keratina, manicura…), la clienta aparece aquí para
          recordarle el retoque por WhatsApp, 1 a 1. El ciclo se configura por servicio en Catálogo de servicios
          (“Retoque cada…”). No hay envío masivo: cada mensaje se manda desde el chat de la clienta.
        </p>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
        {message && (
          <p className={`text-sm mt-2 p-3 rounded-lg ${message.startsWith('Error') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>{message}</p>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
        <h2 className="font-bold text-slate-800 mb-3">Retoques pendientes ({due.length})</h2>
        {due.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nadie pendiente de retoque. Si un servicio no tiene ciclo configurado, no aparece aquí: ponle
            “Retoque cada (días)” en Catálogo de servicios.
          </p>
        ) : (
          <div className="space-y-2">
            {due.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 rounded-xl px-4 py-3">
                <div className="text-sm">
                  <p className="font-bold text-slate-800">{d.client_name || 'Clienta'} <span className="text-slate-400 font-normal">· {d.client_phone}</span></p>
                  <p className="text-slate-500">
                    {d.service_name} · hecha el {fmtDate(d.completed_date)} · hace {d.days_since} días (ciclo {d.retouch_days} días)
                    {d.days_overdue > 0 && <span className="text-amber-700 font-bold"> · {d.days_overdue} días de atraso</span>}
                    {d.professional_name && <span> · con {d.professional_name}</span>}
                  </p>
                </div>
                <button
                  onClick={() => sendRetouch(d.id)}
                  disabled={sendingId === d.id}
                  className="bg-brand-600 text-white px-3 py-2 rounded-lg text-xs font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-1.5"
                >
                  {sendingId === d.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  Enviar recordatorio
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="font-bold text-slate-800 flex items-center gap-2">
            <UserX className="w-4 h-4 text-slate-500" /> Clientas inactivas ({inactive.length})
          </h2>
          <label className="text-xs font-bold text-slate-500 flex items-center gap-2">
            Sin venir en
            <select value={inactiveDays} onChange={(e) => setInactiveDays(Number(e.target.value))} className="border border-slate-300 rounded-lg px-2 py-1 outline-none">
              <option value={30}>30 días</option>
              <option value={45}>45 días</option>
              <option value={60}>60 días</option>
              <option value={90}>90 días</option>
            </select>
          </label>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Base para recuperar clientas: escríbeles 1 a 1 desde Mensajes (el botón abre el chat). No hay envío
          masivo en esta versión.
        </p>
        {inactive.length === 0 ? (
          <p className="text-sm text-slate-500">Nadie inactiva en ese plazo.</p>
        ) : (
          <div className="space-y-2">
            {inactive.map((c) => (
              <div key={c.phone} className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 rounded-xl px-4 py-3">
                <div className="text-sm">
                  <p className="font-bold text-slate-800">{c.name || 'Clienta'} <span className="text-slate-400 font-normal">· {c.phone}</span></p>
                  <p className="text-slate-500">
                    {c.last_visit ? `Última visita: ${fmtDate(c.last_visit)} (hace ${c.days_since} días)` : 'Sin citas completadas registradas'} · {c.visits} visita(s)
                  </p>
                </div>
                <button
                  onClick={() => onOpenChat?.(c.phone)}
                  className="text-xs font-bold text-brand-600 hover:underline flex items-center gap-1"
                >
                  <MessageCircle className="w-3 h-3" /> Abrir chat
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
