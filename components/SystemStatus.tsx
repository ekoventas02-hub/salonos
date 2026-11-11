// Estado del Sistema (solo administradores).
// Semáforos por componente, autoprueba, últimos eventos, reconexión de
// WhatsApp y respaldo. Si algo se rompe, aquí se ve sin entrar a los logs.
import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Play,
  Database, Smartphone, Server, MessagesSquare, HardDrive, Bell,
  Loader2, RotateCcw, Download, Send,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { SystemComponentStatus, SystemEvent, SelfTestResult } from '../types';

type Status = 'green' | 'yellow' | 'red';

const DOT: Record<Status, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
};
const LABEL: Record<Status, string> = {
  green: 'Bien',
  yellow: 'Atención',
  red: 'Roto',
};
const BADGE: Record<Status, string> = {
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  yellow: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-red-50 text-red-700 border-red-200',
};
const ICONS: Record<string, any> = {
  db: Database,
  whatsapp: Smartphone,
  server: Server,
  queue: MessagesSquare,
  backup: HardDrive,
};

interface StatusData {
  version: string;
  uptime_seconds: number;
  alerts: { telegramConfigured: boolean; emailConfigured: boolean };
  components: SystemComponentStatus[];
  criticalEvents: SystemEvent[];
}

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
}

export const SystemStatus: React.FC = () => {
  const [data, setData] = useState<StatusData | null>(null);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [levelFilter, setLevelFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [tests, setTests] = useState<SelfTestResult[] | null>(null);
  const [testSummary, setTestSummary] = useState('');
  // v1.3 (CRM v5.3.34 H-M8): opt-in de respaldo sin cifrar (solo admin).
  const [allowUnencrypted, setAllowUnencrypted] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/system/status');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo cargar el estado');
      setData(json);
      const evRes = await apiFetch(`/api/system/events?limit=50${levelFilter ? `&level=${levelFilter}` : ''}`);
      const evJson = await evRes.json().catch(() => ({}));
      if (evRes.ok) setEvents(evJson.events || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [levelFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/settings').then((r) => r.json()).then((st) => {
      if (st && typeof st === 'object') setAllowUnencrypted(String(st.backup_allow_unencrypted || '').toLowerCase() === 'true');
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [load]);

  const runAction = async (key: string, fn: () => Promise<{ message: string }>) => {
    setBusy(key);
    setMessage('');
    try {
      const r = await fn();
      setMessage(r.message);
      await load(true);
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const selfTest = async () => {
    setBusy('test');
    setMessage('');
    setTests(null);
    try {
      const res = await apiFetch('/api/system/self-test', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'La autoprueba falló');
      setTests(json.tests || []);
      setTestSummary(`${json.summary.passed}/${json.summary.total} pruebas correctas`);
      await load(true);
    } catch (e: any) {
      setMessage(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const reconnectWhatsApp = async (id?: string) =>
    runAction(`wa-${id || 'all'}`, async () => {
      const res = await apiFetch('/api/system/whatsapp/reconnect', {
        method: 'POST',
        body: JSON.stringify(id ? { id } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo reconectar');
      return { message: 'Reconexión iniciada. Si aparece un QR nuevo, escanealo en Canales WhatsApp.' };
    });

  const cleanupUploads = async () =>
    runAction('cleanup', async () => {
      const res = await apiFetch('/api/system/cleanup-uploads', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo limpiar');
      return { message: `Limpieza OK: ${json.deleted || 0} archivo(s) borrados, ${Math.round(((json.freedBytes || 0) / 1024 / 1024) * 10) / 10} MB liberados (solo huérfanos de más de 30 días, nunca el logo).` };
    });

  const toggleUnencrypted = async (v: boolean) => {
    setAllowUnencrypted(v);
    try {
      const res = await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify({ key: 'backup_allow_unencrypted', value: String(v) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo guardar');
      setMessage(v ? 'Respaldo sin cifrar PERMITIDO: cada respaldo en plano avisará por Telegram y quedará en Últimos eventos.' : 'Respaldo sin cifrar NO permitido: sin clave válida el respaldo fallará (fail-closed).');
    } catch (e: any) {
      setAllowUnencrypted(!v);
      setMessage(`Error: ${e.message}`);
    }
  };

  const doBackup = async () =>
    runAction('backup', async () => {
      const res = await apiFetch('/api/system/backup', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'El respaldo falló');
      return { message: `Respaldo OK: ${json.file} (${Math.round((json.sizeBytes || 0) / 1024)} KB)` };
    });

  const testAlert = async () =>
    runAction('alert', async () => {
      const res = await apiFetch('/api/system/alerts/test', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'No se pudo probar la alerta');
      if (!json.sent) throw new Error(json.reason || 'Telegram no configurado');
      return { message: 'Alerta de prueba enviada a Telegram. Revisa tu teléfono.' };
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Cargando estado del sistema…
      </div>
    );
  }

  const wa = data?.components.find((c) => c.key === 'whatsapp');

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Activity className="w-6 h-6 text-brand-600" /> Estado del Sistema
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Si algo se rompe, se ve aquí sin entrar a los logs. Versión {data?.version || '—'} ·
          servidor activo desde hace {data ? fmtUptime(data.uptime_seconds) : '—'}.
        </p>
        {error && (
          <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg flex items-center gap-2">
            <XCircle className="w-4 h-4" /> {error}
          </div>
        )}
      </div>

      {data && !data.alerts.telegramConfigured && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-sm text-amber-800 flex items-start gap-3">
          <Bell className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Las alertas de Telegram no están configuradas.</p>
            <p>
              Sin Telegram, si WhatsApp o la base de datos se caen nadie se entera hasta que un
              cliente se queje. Configura <code className="font-mono">TELEGRAM_BOT_TOKEN</code> y{' '}
              <code className="font-mono">TELEGRAM_CHAT_ID</code> en el <code className="font-mono">.env</code>{' '}
              (2 minutos con BotFather, ver README → “¿Cómo sé si algo se rompió?”) y luego pulsa
              “Probar alerta”.
            </p>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {data?.components.map((c) => {
          const Icon = ICONS[c.key] || Server;
          return (
            <div key={c.key} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon className="w-5 h-5 text-slate-500" />
                  <h3 className="font-bold text-slate-800">{c.label}</h3>
                </div>
                <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border ${BADGE[c.status]}`}>
                  <span className={`w-2 h-2 rounded-full ${DOT[c.status]}`} />
                  {LABEL[c.status]}
                </span>
              </div>
              <p className="text-sm text-slate-600 mt-2">{c.detail}</p>
              {c.key === 'db' && c.latencyMs !== undefined && (
                <p className="text-xs text-slate-400 mt-1">Latencia: {c.latencyMs} ms</p>
              )}
              {c.key === 'server' && (
                <p className="text-xs text-slate-400 mt-1">
                  Memoria: {c.memoryMB} MB
                  {c.disk ? ` · Disco libre: ${c.disk.freeMB} MB de ${c.disk.totalMB} MB${c.disk.usedPercent != null ? ` (${c.disk.usedPercent}% usado)` : ''}` : ''}
                </p>
              )}
              {c.key === 'whatsapp' && c.instances && c.instances.length > 0 && (
                <div className="mt-3 space-y-2">
                  {c.instances.map((inst) => (
                    <div key={inst.id} className="flex items-center justify-between gap-2 text-sm bg-slate-50 rounded-lg px-3 py-2">
                      <div>
                        <p className="font-bold text-slate-700">{inst.name} <span className="text-slate-400 font-normal">({inst.status})</span></p>
                        {inst.status === 'authenticated' && (
                          <p className="text-xs font-bold text-amber-700">⚠️ Autenticado pero sin llegar a listo: los mensajes no entran ni salen. Vuelve a escanear el QR o reconecta.</p>
                        )}
                        <p className="text-xs text-slate-400">
                          {inst.phone ? `Número: ${inst.phone} · ` : ''}
                          Último mensaje: {fmtTime(inst.lastMessageAt)}
                        </p>
                      </div>
                      <button
                        onClick={() => reconnectWhatsApp(inst.id)}
                        disabled={busy === `wa-${inst.id}`}
                        className="text-xs font-bold text-brand-600 hover:underline disabled:opacity-50 flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" /> Reconectar
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {c.key === 'backup' && c.backup?.file && (
                <p className="text-xs text-slate-400 mt-1">
                  Archivo: {c.backup.file} · {Math.round((c.backup.sizeBytes || 0) / 1024)} KB
                </p>
              )}
              {c.key === 'backup' && c.backup && (
                <div className="mt-2 space-y-1">
                  {c.backup.encrypted === false && (
                    <p className="text-xs font-bold text-amber-700">⚠️ Respaldo SIN cifrar: contiene toda la base de datos en plano. Define BACKUP_ENCRYPTION_KEY o desactiva el opt-in de abajo.</p>
                  )}
                  {c.backup.encrypted === true && (
                    <p className="text-xs text-emerald-700">🔒 Respaldo cifrado (AES-256-GCM).</p>
                  )}
                  {c.backup.file && (
                    <a href={`/api/system/backup/download?file=${encodeURIComponent(c.backup.file)}`} className="inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:underline">
                      <Download className="w-3 h-3" /> Descargar respaldo
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-3">Acciones</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={selfTest} disabled={busy === 'test'}
            className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2">
            {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Probar ahora
          </button>
          <button onClick={() => reconnectWhatsApp()} disabled={busy === 'wa-all'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            <RotateCcw className="w-4 h-4" /> Reconectar WhatsApp
          </button>
          <button onClick={doBackup} disabled={busy === 'backup'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            <Download className="w-4 h-4" /> Hacer respaldo ahora
          </button>
          <button onClick={cleanupUploads} disabled={busy === 'cleanup'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            <HardDrive className="w-4 h-4" /> Limpiar subidas huérfanas
          </button>
          <button onClick={testAlert} disabled={busy === 'alert'}
            className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60 flex items-center gap-2">
            <Send className="w-4 h-4" /> Probar alerta de Telegram
          </button>
          <button onClick={() => load()} disabled={loading}
            className="border border-slate-300 px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-50 disabled:opacity-60 flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Actualizar
          </button>
        </div>
        <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={allowUnencrypted} onChange={(e) => toggleUnencrypted(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="font-bold text-slate-700">Permitir respaldos sin cifrar</span>
              <span className="block text-xs text-slate-500 mt-0.5">
                Sin BACKUP_ENCRYPTION_KEY el respaldo FALLA (fail-closed). Con esto activado se guarda en plano,
                pero cada respaldo así avisa por Telegram y queda en Últimos eventos. El archivo en plano contiene
                TODA la base de datos: no lo compartas.
              </span>
            </span>
          </label>
        </div>
        {message && (
          <div className={`mt-4 p-3 rounded-lg text-sm ${message.startsWith('Error') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
            {message}
          </div>
        )}
        {tests && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-bold text-slate-700">Autoprueba: {testSummary}</p>
            {tests.map((t) => (
              <div key={t.name} className="flex items-center justify-between gap-2 text-sm bg-slate-50 rounded-lg px-3 py-2">
                <span className="flex items-center gap-2">
                  {t.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                  {t.name}
                </span>
                <span className="text-xs text-slate-500">{t.detail} · {t.ms} ms</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <GoogleCalendarCard />

      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-slate-800">Últimos eventos</h2>
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}
            className="border border-slate-300 rounded-lg text-sm p-2 outline-none">
            <option value="">Todos los niveles</option>
            <option value="info">Info</option>
            <option value="warn">Advertencias</option>
            <option value="error">Errores</option>
            <option value="critical">Críticos</option>
          </select>
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">No hay eventos registrados todavía. Los errores y avisos importantes aparecerán aquí.</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {events.map((ev, i) => (
              <div key={ev.id || i} className="flex items-start gap-3 text-sm bg-slate-50 rounded-lg px-3 py-2">
                {ev.level === 'critical' || ev.level === 'error'
                  ? <XCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                  : ev.level === 'warn'
                    ? <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    : <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />}
                <div className="min-w-0">
                  <p className="font-bold text-slate-700">
                    <span className="text-xs uppercase text-slate-400 mr-2">{ev.level} · {ev.component}</span>
                    {ev.message}
                  </p>
                  <p className="text-xs text-slate-400">{fmtTime(ev.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {data && data.criticalEvents.length > 0 && (
          <p className="text-xs text-slate-400 mt-3">
            Últimos críticos: {data.criticalEvents.length} (también están en la lista de arriba).
          </p>
        )}
        {wa && (wa.instances?.length ?? 0) === 0 && (
          <p className="text-xs text-slate-400 mt-3">Sin instancias de WhatsApp: crea una en Canales WhatsApp.</p>
        )}
      </div>
    </div>
  );
};

// ---------- Google Calendar por salón (v1.3, CRM v5.3) ----------
// Estado, prueba y sincronización del calendario del salón, y la
// configuración de credenciales (por salón; tienen prioridad sobre el .env).
// Sin credenciales el salón funciona igual: las citas solo no se sincronizan.
const GoogleCalendarCard: React.FC = () => {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ client_id: '', client_secret: '', refresh_token: '', calendar_id: '', duration_minutes: '', enabled: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/salon/calendar/status');
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setStatus(j);
        setForm((prev) => ({
          ...prev,
          calendar_id: prev.calendar_id || j.calendarId || 'primary',
          duration_minutes: prev.duration_minutes || String(j.durationMinutes || 60),
          enabled: prev.enabled || String(j.enabled),
        }));
      }
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveAll = async () => {
    setBusy('save');
    setMsg('');
    try {
      const fields: [string, string][] = [
        ['client_id', form.client_id.trim()],
        ['client_secret', form.client_secret.trim()],
        ['refresh_token', form.refresh_token.trim()],
        ['calendar_id', form.calendar_id.trim()],
        ['duration_minutes', form.duration_minutes.trim()],
        ['enabled', form.enabled.trim()],
      ];
      for (const [key, value] of fields) {
        if (!value) continue;
        const r = await apiFetch('/api/salon/calendar/config', { method: 'POST', body: JSON.stringify({ key, value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `No se pudo guardar ${key}`);
      }
      setMsg('Configuración de Google Calendar guardada. Las credenciales en blanco no se tocaron.');
      setForm((prev) => ({ ...prev, client_id: '', client_secret: '', refresh_token: '' }));
      await load();
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally { setBusy(''); }
  };

  const test = async () => {
    setBusy('test');
    setMsg('');
    try {
      const r = await apiFetch('/api/salon/calendar/test', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok && j.ok
        ? `Google Calendar OK: calendario ${j.calendarId}${j.nextEvent ? ` · próximo evento: ${j.nextEvent.summary || '(sin título)'}` : ' · sin eventos próximos'}`
        : `Google Calendar NO conectado: ${j.reason || j.error || 'revisa las credenciales'}`);
    } catch (e: any) { setMsg(`Error: ${e.message}`); } finally { setBusy(''); }
  };

  const sync = async () => {
    setBusy('sync');
    setMsg('');
    try {
      const r = await apiFetch('/api/salon/calendar/sync', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'La sincronización falló');
      setMsg(j.ok === false && j.total === 0
        ? `Sin sincronizar: ${j.reason || 'Google Calendar no configurado'}`
        : `Sincronización: ${j.synced} de ${j.total} citas en Google Calendar${j.failed ? ` · ${j.failed} fallaron: ${(j.errors || []).join('; ')}` : ''}`);
      await load();
    } catch (e: any) { setMsg(`Error: ${e.message}`); } finally { setBusy(''); }
  };

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
      <h2 className="font-bold text-slate-800 mb-1">Google Calendar del salón</h2>
      <p className="text-sm text-slate-500">
        Al agendar, reprogramar o cancelar una cita se crea, actualiza o borra el evento con la duración del
        servicio (zona America/Bogota). Sin credenciales el salón funciona igual: las citas solo no se sincronizan.
        El refresh token se consigue con <code className="font-mono">node scripts/get-google-refresh-token.js</code> (ver README).
      </p>
      {loading ? (
        <p className="text-sm text-slate-500 mt-3 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Cargando…</p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm">
            Estado:{' '}
            <span className={`font-bold ${status?.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
              {status?.ok ? 'Conectado' : (status?.reason || 'Sin configurar')}
            </span>
            {status?.calendarId && <span className="text-slate-500"> · Calendario: {status.calendarId} · Duración por defecto: {status.durationMinutes} min</span>}
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <input className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none" type="password" placeholder="Google Client ID (vacío = no cambiar)" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
            <input className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none" type="password" placeholder="Google Client Secret (vacío = no cambiar)" value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} />
            <input className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none" type="password" placeholder="Google Refresh Token (vacío = no cambiar)" value={form.refresh_token} onChange={(e) => setForm({ ...form, refresh_token: e.target.value })} />
            <input className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none" placeholder="Calendar ID (primary o correo)" value={form.calendar_id} onChange={(e) => setForm({ ...form, calendar_id: e.target.value })} />
            <input className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none" type="number" placeholder="Duración por defecto (min, 15–1440)" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} />
            <select className="border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none" value={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.value })}>
              <option value="true">Sincronización activada</option>
              <option value="false">Sincronización apagada</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={saveAll} disabled={busy === 'save'} className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-60">Guardar configuración</button>
            <button onClick={test} disabled={busy === 'test'} className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60">Probar conexión</button>
            <button onClick={sync} disabled={busy === 'sync'} className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 disabled:opacity-60">Sincronizar próximas citas</button>
          </div>
          {msg && (
            <div className={`p-3 rounded-lg text-sm ${msg.startsWith('Error') || msg.includes('NO conectado') || msg.includes('Sin sincronizar') ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
              {msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
