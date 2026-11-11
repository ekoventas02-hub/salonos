
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import pg from 'pg';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import crypto from 'crypto';
import { spawn } from 'child_process';
import zlib from 'zlib';
import { Server } from 'socket.io';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import 'dotenv/config';
import pkgWA from 'whatsapp-web.js';
import { registerSalonRoutes } from './salon-routes.js';
import { createBotEngine } from './bot-engine.js';
import { PgBotStore } from './bot-store.js';
import qrcode from 'qrcode';
import { createRequire } from 'module';

// El email es opcional y NO está instalado por defecto (nodemailer no está
// en package.json): si alguien lo instala, el estado lo refleja; si no,
// se informa como no configurado en vez de prometer alertas por email.
const _require = createRequire(import.meta.url);
let nodemailerAvailable = false;
try { _require.resolve('nodemailer'); nodemailerAvailable = true; } catch { /* opcional */ }

const { Client, LocalAuth } = pkgWA;

// FORZAR ZONA HORARIA COLOMBIA A NIVEL PROCESO
process.env.TZ = 'America/Bogota';

const { Pool } = pg;

// Logger simple para eventos importantes
const logger = {
  info: (msg, data = '') => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, data),
  error: (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err),
  warn: (msg, data = '') => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, data)
};

// ---------- MONITOREO Y ALERTAS v3.1 ----------
// Los errores ya no viven solo en console.log: quedan en la tabla
// system_events (o en un buffer en memoria si no hay DB) y los críticos
// salen por Telegram, que es el único canal que sigue funcionando cuando
// WhatsApp está caído (avisar por WhatsApp de que WhatsApp está caído
// no tiene sentido).
const APP_VERSION = '1.3.0'; // SalonOS v1.3 multisalón, correcciones del CRM v5.3 portadas y adaptadas a salón
const SERVER_STARTED_AT = Date.now();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const BACKUP_ENABLED = (process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
const BACKUP_KEEP_DAYS = Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || '7', 10) || 7);
// v1.3 (CRM v5.3.25/33): un solo volumen persistente en Railway (/app/data);
// en VPS/docker-compose se deja vacío y se usan los volúmenes de siempre.
const PERSIST_DIR = (process.env.PERSIST_DIR || '').trim();
// v1.3 (CRM v5.3.25): cifrado de respaldos AES-256-GCM. 64 caracteres hex
// (openssl rand -hex 32). SIN esta clave el respaldo sale SIN cifrar y el
// Estado del Sistema lo dice de frente (H-M8 del CRM sigue abierto: no hay
// fail-closed de respaldo en esta versión, ver README).
const BACKUP_ENCRYPTION_KEY_HEX = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
const BACKUP_ENCRYPTION_KEY = /^[0-9a-fA-F]{64}$/.test(BACKUP_ENCRYPTION_KEY_HEX)
  ? Buffer.from(BACKUP_ENCRYPTION_KEY_HEX, 'hex') : null;
if (BACKUP_ENCRYPTION_KEY_HEX && !BACKUP_ENCRYPTION_KEY) {
  logger.warn('BACKUP_ENCRYPTION_KEY inválida (debe ser 64 caracteres hex): los respaldos FALLARÁN hasta poner una clave válida o permitir respaldos sin cifrar en Estado del Sistema');
}
// v1.3 (CRM v5.3.25/33): un solo volumen persistente. En Railway
// PERSIST_DIR=/app/data -> /app/data/uploads y /app/data/backups; en VPS o
// docker-compose (PERSIST_DIR vacío) -> ./uploads y ./backups de siempre.
function uploadsDir() { return PERSIST_DIR ? path.join(PERSIST_DIR, 'uploads') : path.join(__dirname, 'uploads'); }
function backupsDir() { return PERSIST_DIR ? path.join(PERSIST_DIR, 'backups') : path.join(__dirname, 'backups'); }
function waMediaDir() { return path.join(uploadsDir(), 'wa-media'); }
const WA_EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', pdf: 'application/pdf' };
// v1.3 (CRM v5.3.34 H-M8): ¿está permitido guardar el respaldo SIN cifrar?
// Solo con opt-in explícito del admin: env o ajuste en settings. Por
// defecto (sin clave y sin opt-in) el respaldo falla cerrado.
async function isUnencryptedBackupAllowed() {
  if ((process.env.BACKUP_ALLOW_UNENCRYPTED || '').trim().toLowerCase() === 'true') return true;
  const v = await getSettingValue('backup_allow_unencrypted', '');
  return String(v || '').trim().toLowerCase() === 'true';
}
// v1.3 (CRM v5.3.34 H-M11): última alerta de disco lleno (throttle 1 h).
let lastDiskAlertAt = 0;
// v1.3 (CRM v5.3 Google Calendar): credenciales por defecto de la
// instalación; cada salón puede tener las suyas en settings
// (salon_<id>_google_*), que tienen prioridad sobre el .env.
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REFRESH_TOKEN_ENV = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
const GOOGLE_CALENDAR_ID_ENV = (process.env.GOOGLE_CALENDAR_ID || '').trim() || 'primary';

// Buffer en memoria con los últimos 200 eventos (se vuelca a la DB cuando
// vuelve, si es que la tabla system_events ya existe).
const eventBuffer = [];
let eventsTableReady = false;
let lastBackup = { at: null, ok: null, file: null, sizeBytes: null, error: null, encrypted: null };
// Anti-spam de alertas: última vez que se avisó de cada clave (clave -> ms).
const lastAlertAt = {};
// Último estado conocido por el vigilante (para avisar solo al cambiar).
const watchdogState = { db: null, whatsapp: null };
// Intentos fallidos de login por correo (timestamps, últimos 10 min).
const loginFailures = new Map();
// v1.3 (CRM v5.3.29): bloqueo por correo+IP, 15 min tras 5 fallos.
const loginBlocks = new Map();

function pushEventBuffer(ev) {
  eventBuffer.push(ev);
  if (eventBuffer.length > 200) eventBuffer.shift();
}

async function recordEvent(level, component, message, details = {}) {
  const ev = {
    level, component, message,
    details: details && typeof details === 'object' ? details : { value: String(details ?? '') },
    created_at: new Date().toISOString(),
  };
  pushEventBuffer(ev);
  if (!eventsTableReady || !dbOk) return;
  try {
    await pool.query(
      'INSERT INTO system_events (level, component, message, details) VALUES ($1, $2, $3, $4)',
      [level, component, message, JSON.stringify(ev.details)]
    );
  } catch (e) {
    // La tabla puede no existir aún (base vieja sin migrar): no romper nada.
    console.error('[EVENTS] No se pudo guardar el evento en DB:', e.message);
  }
}

async function flushEventBuffer() {
  if (!eventsTableReady || !dbOk || eventBuffer.length === 0) return;
  const pending = [...eventBuffer];
  eventBuffer.length = 0;
  for (let i = 0; i < pending.length; i++) {
    const ev = pending[i];
    try {
      await pool.query(
        'INSERT INTO system_events (level, component, message, details, created_at) VALUES ($1, $2, $3, $4, $5)',
        [ev.level, ev.component, ev.message, JSON.stringify(ev.details), ev.created_at]
      );
    } catch (e) {
      // Re-encolar el fallido Y los que quedaban: antes se perdían.
      for (let j = i; j < pending.length; j++) pushEventBuffer(pending[j]);
      break;
    }
  }
}

function telegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function sendTelegramAlert(text) {
  if (!telegramConfigured()) return { configured: false, sent: false, reason: 'Telegram no configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID vacíos)' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configured: true, sent: false, reason: data.description || `Telegram respondió ${res.status}` };
    return { configured: true, sent: true };
  } catch (e) {
    return { configured: true, sent: false, reason: e.message };
  }
}

// (sendEmailAlert eliminado en la auditoría v1.1: no tenía llamador;
// las alertas salen por Telegram con maybeAlert.)

// Alerta con anti-spam: la misma clave no se repite más de 1 vez cada 30 min,
// salvo que se fuerce (p. ej. el botón "Probar alerta").
async function maybeAlert(key, text, { force = false } = {}) {
  const now = Date.now();
  if (!force && lastAlertAt[key] && now - lastAlertAt[key] < 30 * 60 * 1000) return { sent: false, reason: 'anti-spam: ya se avisó de esto hace menos de 30 min' };
  lastAlertAt[key] = now;
  const r = await sendTelegramAlert(text);
  if (!r.sent) await recordEvent('warn', 'alerts', `No se pudo enviar la alerta (${key}): ${r.reason}`, { key });
  return r;
}

// v1.3 (lección CRM en vivo): 'autenticado' NO es 'listo'. Una instancia
// puede quedar en 'authenticated' sin llegar a 'ready' y los mensajes no
// entran ni salen; el estado lo dice de frente en vez de prometer WhatsApp.
function waStatusSummary() {
  const instances = Object.keys(waClients).map((id) => ({
    id,
    name: waClients[id].name,
    status: waClients[id].status,
    // Solo 'ready' significa WhatsApp vivo: 'authenticated' es solo la
    // sesión iniciada, sin cliente listo para enviar/recibir.
    ready: waClients[id].status === 'ready',
    channel: waClients[id].channel || 'qr',
    phone: waClients[id].phone || null,
    lastSeen: waClients[id].lastSeen || null,
    lastMessageAt: waClients[id].lastMessageAt || null,
    authenticatedAt: waClients[id].authenticatedAt || null,
  }));
  return {
    instances,
    total: instances.length,
    connected: instances.filter((i) => i.status === 'ready').length,
    authenticated: instances.filter((i) => i.status === 'authenticated').length,
  };
}

// ---------- NORMALIZACIÓN DE TELÉFONOS (Colombia) v5 Parte 2B ----------
// MISMA lógica que lib/phone.ts en el frontend: si cambias una regla aquí,
// cambia la otra igual.
// - Se quitan espacios, guiones, paréntesis y puntos.
// - 10 dígitos que empiezan por 3 -> +57 + dígitos.
// - 12 dígitos que empiezan por 57 (con o sin +) -> +57 + últimos 10.
// - Cualquier otro caso se deja tal cual (normalized: false): nunca se
//   inventa un +57 para un fijo (601...), un número corto o un extranjero.
// Ejemplos: '300 123 4567' -> '+573001234567'; '573001234567' -> '+573001234567';
// '+573001234567' -> '+573001234567'; '6012345678' -> '6012345678' (tal cual).
function normalizePhoneCO(raw) {
  const original = raw == null ? '' : String(raw).trim();
  if (!original) return { phone: '', normalized: false };
  const digits = original.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return { phone: `+57${digits}`, normalized: true };
  if (digits.length === 12 && digits.startsWith('57')) return { phone: `+57${digits.slice(2)}`, normalized: true };
  return { phone: original, normalized: false };
}
function normalizePhoneString(raw) {
  return normalizePhoneCO(raw).phone;
}
// Patrones LIKE para buscar un término en una columna de teléfono, cubriendo
// el valor tal cual se escribió y sus variantes normalizadas (con +57, sin +
// y solo los 10 dígitos). Así '3001234567' encuentra filas guardadas como
// '+573001234567' y viceversa.
function phoneSearchPatterns(term) {
  const pats = new Set([`%${term}%`]);
  const { phone, normalized } = normalizePhoneCO(term);
  if (normalized) {
    pats.add(`%${phone}%`);
    pats.add(`%${phone.replace('+', '')}%`);
    pats.add(`%${phone.slice(3)}%`);
  }
  return [...pats];
}
// Añade a `params` un patrón por variante y devuelve la condición
// `(col ILIKE $n OR col ILIKE $m ...)` para esa columna.
function likeAny(params, column, patterns) {
  const parts = patterns.map((p) => { params.push(p); return `${column} ILIKE $${params.length}`; });
  return `(${parts.join(' OR ')})`;
}

// ---------- WHATSAPP META CLOUD API v5 Parte 2B ----------
// Alternativa oficial a la conexión por QR (whatsapp-web.js): los mensajes
// salen por la API de Meta y entran por webhook, sin navegador ni QR.
// Configuración (el token NUNCA se devuelve al frontend):
// - META_WA_TOKEN y META_WA_PHONE_NUMBER_ID: en .env, o en Ajustes del CRM
//   (claves settings meta_wa_token / meta_wa_phone_number_id, solo admin).
//   Lo guardado en settings tiene prioridad sobre el .env.
// - META_WA_VERIFY_TOKEN y META_WA_APP_SECRET: solo en .env (el webhook los
//   necesita al arrancar y no hay UI para ellos).
// Sin token o sin phone number id, Meta se considera no configurado y todo
// sigue saliendo por QR como antes.
const META_WA_VERIFY_TOKEN = (process.env.META_WA_VERIFY_TOKEN || '').trim();
const META_WA_APP_SECRET = (process.env.META_WA_APP_SECRET || '').trim();

async function getMetaConfig(salonId = null) {
  let tokenFromSettings = '';
  let phoneFromSettings = '';
  if (dbOk) {
    try {
      if (salonId) {
        tokenFromSettings = (await getSettingValue(`salon_${salonId}_meta_wa_token`, '')) || '';
        phoneFromSettings = (await getSettingValue(`salon_${salonId}_meta_wa_phone_number_id`, '')) || '';
      }
      if (!tokenFromSettings) tokenFromSettings = (await getSettingValue('meta_wa_token', '')) || '';
      if (!phoneFromSettings) phoneFromSettings = (await getSettingValue('meta_wa_phone_number_id', '')) || '';
    } catch { /* sin tabla settings aún: cae al .env */ }
  }
  const token = (tokenFromSettings || '').trim() || (process.env.META_WA_TOKEN || '').trim();
  const phoneNumberId = (phoneFromSettings || '').trim() || (process.env.META_WA_PHONE_NUMBER_ID || '').trim();
  return {
    token,
    phoneNumberId,
    verifyToken: META_WA_VERIFY_TOKEN,
    appSecret: META_WA_APP_SECRET,
    configured: Boolean(token && phoneNumberId),
    tokenSource: tokenFromSettings.trim() ? 'settings' : ((process.env.META_WA_TOKEN || '').trim() ? 'env' : 'none'),
    verifyTokenConfigured: Boolean(META_WA_VERIFY_TOKEN),
    appSecretConfigured: Boolean(META_WA_APP_SECRET),
  };
}

// Envío unificado de WhatsApp. Canal 'meta' -> API oficial de Meta;
// canal 'qr' -> cliente whatsapp-web.js de la instancia indicada (o la
// primera lista, si no se indica). Devuelve { ok, channel, ... } y nunca
// lanza: el llamador registra el error en system_events.
async function sendWhatsAppMessage({ phone, content, channel = 'qr', instanceId = null, salonId = null }) {
  const { phone: normPhone } = normalizePhoneCO(phone);
  const digits = normPhone.replace(/\D/g, '');
  if (!content) return { ok: false, channel, error: 'Contenido vacío' };
  if (!digits) return { ok: false, channel, error: 'Teléfono vacío o inválido' };

  if (channel === 'meta') {
    const meta = await getMetaConfig(salonId);
    if (!meta.configured) {
      return { ok: false, channel: 'meta', error: 'Meta Cloud API no configurado: falta el token o el phone number id (Canales WhatsApp > Meta, o META_WA_TOKEN / META_WA_PHONE_NUMBER_ID en .env)' };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(`https://graph.facebook.com/v19.0/${meta.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${meta.token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: content } }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, channel: 'meta', error: data?.error?.message || `Meta respondió ${res.status}` };
      return { ok: true, channel: 'meta', messageId: data?.messages?.[0]?.id || null };
    } catch (e) {
      return { ok: false, channel: 'meta', error: e.message };
    }
  }

  let target = null;
  if (instanceId && waClients[instanceId]?.status === 'ready' && waClients[instanceId].client) target = instanceId;
  else if (salonId) target = Object.keys(waClients).find((k) => waClients[k].salonId === salonId && waClients[k].status === 'ready' && waClients[k].channel !== 'meta' && waClients[k].client);
  // AUDITORÍA v1.1: si el salón tiene instancia, se usa ESA; si no la
  // tiene, NO se manda por la de otro salón (antes caía en cualquier
  // instancia lista y el mensaje salía por otro número).
  if (!target && !salonId) target = Object.keys(waClients).find((k) => waClients[k].status === 'ready' && waClients[k].channel !== 'meta' && waClients[k].client);
  if (!target) return { ok: false, channel: 'qr', error: 'Ninguna instancia de WhatsApp por QR lista' };
  try {
    await waClients[target].client.sendMessage(`${digits}@c.us`, content);
    return { ok: true, channel: 'qr', instance: target };
  } catch (e) {
    return { ok: false, channel: 'qr', error: e.message };
  }
}

// Entrada de mensajes: la MISMA lógica para el QR (whatsapp-web.js) y para
// el webhook de Meta. Normaliza el teléfono, crea cliente/conversación si no
// existen y guarda el mensaje. El id de conversación es wa_<dígitos sin +>
// (sin el + para que no se rompa en la URL /api/chats/:id/messages); el
// teléfono guardado sí lleva el +57. externalId (wamid de Meta) evita
// duplicados: la columna messages.external_id es UNIQUE.
async function handleIncomingWhatsApp({ phone: rawPhone, content, sourceName, channel = 'qr', externalId = null, senderName = null, salonId = null, type = 'text', attachmentUrl = null }) {
  const { phone } = normalizePhoneCO(rawPhone);
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  let conversationId = `wa_${digits}`;
  const displayName = (senderName || '').trim() || phone;

  let clientRes = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
  if (clientRes.rows.length === 0) {
    if (salonId) {
      try { await pool.query('INSERT INTO clients (phone, name, source, salon_id) VALUES ($1, $2, $3, $4) ON CONFLICT (phone) DO NOTHING', [phone, displayName, sourceName, salonId]); }
      catch { await pool.query('INSERT INTO clients (phone, name, source) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING', [phone, displayName, sourceName]); }
    } else {
      await pool.query('INSERT INTO clients (phone, name, source) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING', [phone, displayName, sourceName]);
    }
  }

  let convRes = await pool.query('SELECT * FROM conversations WHERE client_phone = $1', [phone]);
  if (convRes.rows.length === 0) {
    if (salonId) {
      try { await pool.query(
        'INSERT INTO conversations (id, client_phone, client_name, source, status, last_message, last_message_time, unread_count, channel, salon_id) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 1, $7, $8) ON CONFLICT (id) DO UPDATE SET last_message = EXCLUDED.last_message, last_message_time = NOW(), unread_count = conversations.unread_count + 1, channel = EXCLUDED.channel',
        [conversationId, phone, displayName, sourceName, 'open', content, channel, salonId]
      ); } catch { await pool.query(
        'INSERT INTO conversations (id, client_phone, client_name, source, status, last_message, last_message_time, unread_count, channel) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 1, $7) ON CONFLICT (id) DO UPDATE SET last_message = EXCLUDED.last_message, last_message_time = NOW(), unread_count = conversations.unread_count + 1, channel = EXCLUDED.channel',
        [conversationId, phone, displayName, sourceName, 'open', content, channel]
      ); }
    } else {
    await pool.query(
      'INSERT INTO conversations (id, client_phone, client_name, source, status, last_message, last_message_time, unread_count, channel) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 1, $7) ON CONFLICT (id) DO UPDATE SET last_message = EXCLUDED.last_message, last_message_time = NOW(), unread_count = conversations.unread_count + 1, channel = EXCLUDED.channel',
      [conversationId, phone, displayName, sourceName, 'open', content, channel]
    ); }
  } else {
    conversationId = convRes.rows[0].id;
    await pool.query(
      'UPDATE conversations SET last_message = $1, last_message_time = NOW(), unread_count = unread_count + 1, channel = $3 WHERE id = $2',
      [content, conversationId, channel]
    );
  }

  try {
    await pool.query(
      'INSERT INTO messages (conversation_id, sender, type, content, attachment_url, timestamp, external_id, salon_id, status) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8) ON CONFLICT (external_id) DO NOTHING',
      [conversationId, 'client', type, content, attachmentUrl, externalId, salonId, 'recibido']
    );
  } catch {
    await pool.query(
      'INSERT INTO messages (conversation_id, sender, type, content, attachment_url, timestamp, external_id, status) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7) ON CONFLICT (external_id) DO NOTHING',
      [conversationId, 'client', type, content, attachmentUrl, externalId, 'recibido']
    );
  }

  // Confirmación S/N de citas por WhatsApp (mejora 2).
  // AUDITORÍA v1.1: antes tomaba la primera cita de las próximas 48 h
  // aunque ya hubiera pasado, y cancelaba una sola fila de un grupo de
  // 4 manos. Ahora: solo citas futuras (hoy con hora por venir o días
  // siguientes), actúa sobre TODO el grupo, y NO se dispara mientras el
  // bot de reservas lleva la conversación (el bot interpreta la S/N en
  // su propio contexto).
  try {
    const ans = String(content || '').trim().toLowerCase();
    if (salonId && (ans === 's' || ans === 'si' || ans === 'sí' || ans === 'n' || ans === 'no')) {
      // Si el bot del salón está encendido, ÉL interpreta la S/N (en el
      // menú como respuesta al recordatorio, o en su propio flujo); si no,
      // dos respuestas saldrían a la vez. Con el bot apagado, el S/N
      // heredado sigue funcionando igual que antes.
      const botOn = await pool.query('SELECT bot_enabled FROM salons WHERE id=$1', [salonId]).catch(() => ({ rows: [] }));
      if (!botOn.rows[0]?.bot_enabled) {
        const up = await pool.query(
          `SELECT id, group_id FROM appointments WHERE salon_id=$1 AND client_phone=$2 AND status IN ('pendiente','confirmada')
           AND (date > CURRENT_DATE OR (date = CURRENT_DATE AND start_time >= (NOW() - INTERVAL '30 minutes')::time))
           AND date <= CURRENT_DATE + INTERVAL '2 days' ORDER BY date ASC, start_time ASC LIMIT 1`,
          [salonId, phone]);
        if (up.rows[0]) {
          const where = up.rows[0].group_id ? 'group_id=$1' : 'id=$1';
          const key = up.rows[0].group_id || up.rows[0].id;
          if (ans === 's' || ans === 'si' || ans === 'sí') {
            await pool.query(`UPDATE appointments SET status='confirmada', confirmation_status='confirmada_por_whatsapp' WHERE ${where}`, [key]);
          } else {
            await pool.query(`UPDATE appointments SET status='cancelada', confirmation_status='rechazada_por_whatsapp' WHERE ${where}`, [key]);
          }
        }
      }
    }
  } catch { /* la confirmación es un extra: nunca rompe la recepción del mensaje */ }

  notifyUpdate('webhook_message');
  return conversationId;
}

// --- CONFIGURACIÓN DE MULTI-WHATSAPP ---
const waClients = {}; // Almacén de instancias activas

// Motor del bot de reservas (v1.1). Se crea tras registrar las rutas del
// salón (necesita su API: huecos, creación, cancelación). Mientras sea null
// no hay bot: los mensajes solo quedan en el inbox.
let botEngine = null;

const initWhatsApp = async (id, name = 'Sin Nombre', channel = 'qr', salonId = null) => {
  if (waClients[id]) return;
  channel = channel === 'meta' ? 'meta' : 'qr';

  // Instancia Meta (Cloud API): no hay navegador ni QR que escanear, solo
  // una entrada virtual. Su estado es 'ready' si Meta está configurado y
  // 'disconnected' si falta el token o el phone number id.
  if (channel === 'meta') {
    logger.info(`Instancia Meta registrada: ${name} (ID: ${id})`);
    const meta = await getMetaConfig(salonId);
    waClients[id] = {
      client: null,
      status: meta.configured ? 'ready' : 'disconnected',
      qr: null,
      name,
      phone: null,
      lastSeen: new Date().toISOString(),
      lastMessageAt: null,
      channel: 'meta',
      salonId,
    };
    recordEvent('info', 'whatsapp', `Instancia Meta registrada: ${name} (${meta.configured ? 'lista para enviar' : 'sin configurar: falta token o phone number id'})`, { instance: id });
    return;
  }

  logger.info(`Inicializando WhatsApp para: ${name} (ID: ${id})`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `wa-session-${id}` }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  waClients[id] = {
    client,
    status: 'initializing',
    qr: null,
    name,
    phone: null,
    lastSeen: new Date().toISOString(),
    lastMessageAt: null,
    channel: 'qr',
    salonId,
  };

  client.on('qr', async (qr) => {
    logger.info(`QR recibido para ${name}`);
    const qrDataUrl = await qrcode.toDataURL(qr);
    waClients[id].qr = qrDataUrl;
    waClients[id].status = 'qr_ready';
    waClients[id].lastSeen = new Date().toISOString();
    io.emit('wa_qr', { id, qr: qrDataUrl, status: 'qr_ready' });
    recordEvent('info', 'whatsapp', `QR generado para ${name}: escanea el código en Canales WhatsApp`, { instance: id });
  });

  client.on('ready', () => {
    logger.info(`WhatsApp ${name} está listo!`);
    waClients[id].status = 'ready';
    waClients[id].qr = null;
    waClients[id].lastSeen = new Date().toISOString();
    try { waClients[id].phone = client.info?.wid?.user || waClients[id].phone; } catch { /* sin número aún */ }
    io.emit('wa_status', { id, status: 'ready' });
    recordEvent('info', 'whatsapp', `WhatsApp conectado: ${name}`, { instance: id, phone: waClients[id].phone });
    if (watchdogState.whatsapp === 'error') {
      maybeAlert(`whatsapp-${id}`, `✅ WhatsApp recuperado: ${name} volvió a conectarse.`);
      watchdogState.whatsapp = 'ok';
    }
  });

  client.on('authenticated', () => {
    logger.info(`WhatsApp ${name} autenticado`);
    waClients[id].status = 'authenticated';
    waClients[id].authenticatedAt = new Date().toISOString();
    waClients[id].lastSeen = new Date().toISOString();
    recordEvent('info', 'whatsapp', `WhatsApp autenticado: ${name}`, { instance: id });
  });

  client.on('auth_failure', (msg) => {
    logger.error(`Error de autenticación en ${name}`, msg);
    waClients[id].status = 'auth_failure';
    waClients[id].lastSeen = new Date().toISOString();
    io.emit('wa_status', { id, status: 'auth_failure' });
    recordEvent('critical', 'whatsapp', `WhatsApp: fallo de autenticación en ${name}. Hay que volver a escanear el QR.`, { instance: id, detail: String(msg || '') });
    maybeAlert(`whatsapp-auth-${id}`, `🚨 WhatsApp (${name}): fallo de autenticación. Hay que escanear el QR de nuevo en el CRM.`);
  });

  client.on('disconnected', (reason) => {
    logger.warn(`WhatsApp ${name} desconectado: ${reason}`);
    waClients[id].status = 'disconnected';
    waClients[id].lastSeen = new Date().toISOString();
    io.emit('wa_status', { id, status: 'disconnected' });
    recordEvent('critical', 'whatsapp', `WhatsApp desconectado: ${name} (${reason || 'sin motivo'}). Los mensajes no salen hasta reconectar.`, { instance: id, reason: String(reason || '') });
    maybeAlert(`whatsapp-down-${id}`, `🚨 WhatsApp desconectado (${name}): ${reason || 'sin motivo'}. Revisa Estado del Sistema en el CRM.`);
  });

  client.on('message', async (msg) => {
    // AUDITORÍA v1.1: el bot/CRM nunca responde a sus propios mensajes,
    // ni a grupos, ni a estados (status@broadcast).
    if (msg.fromMe) return;
    if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;

    const phone = msg.from.replace('@c.us', '');
    const content = msg.body || '';
    waClients[id].lastSeen = new Date().toISOString();
    waClients[id].lastMessageAt = new Date().toISOString();

    // v1.3 (lección CRM en vivo): el evento CRUDO se registra ANTES de
    // filtrar (remitente, tipo, media, ids; nunca el contenido: H-A3).
    logger.info('WA QR evento crudo', { instance: id, from: msg.from, type: msg.type, hasMedia: Boolean(msg.hasMedia), id: msg.id?._serialized || msg.id?.id || null });

    try {
      // Misma lógica que el webhook de Meta (ver handleIncomingWhatsApp):
      // normaliza el teléfono y crea cliente/conversación/mensaje.
      // v1.3: la media entrante ya no se pierde (antes solo se leía
      // msg.body). Se descarga a /uploads/wa-media; si la descarga falla,
      // el mensaje se guarda con etiqueta en vez de descartarse.
      let attachmentUrl = null;
      let msgType = 'text';
      let text = content;
      if (msg.hasMedia) {
        msgType = msg.type === 'ptt' ? 'audio' : (['image', 'video', 'document'].includes(msg.type) ? msg.type : 'image');
        const label = { image: '📷 Imagen recibida', audio: '🎤 Nota de voz recibida', video: '🎬 Video recibido', document: '📎 Documento recibido' }[msgType] || '📎 Archivo recibido';
        try {
          const media = await msg.downloadMedia();
          if (media?.data) {
            const ext = (media.mimetype || 'image/jpeg').split('/')[1]?.split(';')[0] || 'bin';
            const fname = `${Date.now()}_${String(msg.id?._serialized || 'msg').replace(/[^a-zA-Z0-9]/g, '_')}.${ext}`;
            fs.mkdirSync(waMediaDir(), { recursive: true });
            fs.writeFileSync(path.join(waMediaDir(), fname), Buffer.from(media.data, 'base64'));
            attachmentUrl = `/uploads/wa-media/${fname}`;
          }
        } catch (e) { logger.warn(`No se pudo descargar la media de ${phone} en ${name}: ${e.message}`); }
        if (!text) text = attachmentUrl ? label : `${label} (no se pudo descargar el archivo)`;
      }
      await handleIncomingWhatsApp({ phone, content: text, type: msgType, attachmentUrl, sourceName: `WhatsApp Directo (${name})`, channel: 'qr', salonId: waClients[id]?.salonId || null });
      // Bot de reservas v1.1: mismo motor que Meta. Si el salón lo tiene
      // apagado, handleMessage no responde nada (silencio).
      if (botEngine && content) {
        await botEngine.handleMessage({ salonId: waClients[id]?.salonId || null, phone, content, channel: 'qr', instanceId: id }).catch((e) => logger.error('Error del bot de reservas (QR)', e));
      }
    } catch (err) {
      logger.error('Error procesando mensaje de WhatsApp', err);
    }
  });

  client.initialize().catch(err => {
    logger.error(`Error inicializando cliente ${name}`, err);
    waClients[id].status = 'error';
    recordEvent('error', 'whatsapp', `No se pudo iniciar WhatsApp (${name}): ${err?.message || err}`, { instance: id });
  });
};

// --- FIN CONFIGURACIÓN WHATSAPP ---

const app = express();
const server = http.createServer(app);
// v1.3 (CRM v5.3.29 H-A4): TRUST_PROXY configurable. En Railway el edge ES un
// proxy real (TRUST_PROXY=1 en el Dockerfile); en VPS directo debe ser 0,
// o cualquiera falsifica X-Forwarded-For y anula limitadores y bloqueo de login.
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : 0);
// CORS del socket: mismo origen salvo CORS_ORIGIN. La autenticación real del
// socket se hace con JWT en el handshake (io.use más abajo).
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN || false,
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));


let dbUrl = (process.env.DATABASE_URL || '').trim();
// En Docker Compose, DATABASE_URL viene vacío y la base se arma con
// POSTGRES_* (con la clave URL-escapada: antes se construía en el compose
// sin escapar y una clave con @, # o / rompía la conexión).
if (!dbUrl && process.env.POSTGRES_USER) {
  const u = encodeURIComponent(process.env.POSTGRES_USER);
  const p = encodeURIComponent(process.env.POSTGRES_PASSWORD || '');
  const h = process.env.POSTGRES_HOST || 'db';
  const d = encodeURIComponent(process.env.POSTGRES_DB || 'salonos');
  dbUrl = `postgres://${u}:${p}@${h}:5432/${d}`;
}
const pool = new Pool({
  connectionString: dbUrl || undefined,
  ssl: dbUrl?.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  // v1.3 (CRM v5.3.30): tope de conexiones del pool. Sin `max`, pg usa 10 por
  // defecto y con 30 usuarias a la vez el p95 se iba a 3,3 s.
  max: 25,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
// Sin este handler, un error del pool (p. ej. DB caída) tumba todo el proceso.
pool.on('error', (err) => {
  logger.error('Error del pool de Postgres (no fatal)', err);
  dbOk = false;
  recordEvent('critical', 'db', `La base de datos falló: ${err?.message || err}`, {});
  maybeAlert('db-down', `🚨 El CRM perdió la conexión con la base de datos: ${err?.message || err}`);
});
// Red de seguridad: una promesa rechazada sin catch (alguna ruta sin try/catch)
// no debe tumbar todo el CRM; se registra y el proceso sigue vivo.
process.on('unhandledRejection', (err) => {
  logger.error('Promesa rechazada sin catch (el servidor sigue vivo)', err);
  recordEvent('error', 'server', `Promesa rechazada sin catch: ${err?.message || err}`, {});
});
process.on('uncaughtException', (err) => {
  logger.error('Excepción no capturada (el servidor sigue vivo)', err);
  recordEvent('critical', 'server', `Excepción no capturada: ${err?.message || err}`, {});
});
let dbOk = false;

// JWT: si no hay JWT_SECRET, se genera uno efímero y se avisa (los tokens no
// sobreviven a un reinicio). En producción define JWT_SECRET en .env.
const jwtSecret = process.env.JWT_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) logger.warn('JWT_SECRET no definido: usando secreto efímero (define uno fijo en .env)');

// v1.3 (CRM v5.3.24/26): el JWT ya NO vive en localStorage (cualquier script
// en el origen lo leía). El servidor lo emite en cookie HttpOnly y el
// navegador la envía sola (mismo origen). Se sigue aceptando Bearer como
// respaldo (token de salón de 1 h y clientes API), pero el login usa cookie.
// El token de salón es un JWT del superadmin con id "superadmin:<id>": la
// revocación (token_version) se resuelve contra el id numérico base.
const AUTH_COOKIE = 'salon_token';
const SUPERADMIN_COOKIE = 'salon_superadmin_token';
function parseCookies(req) {
  const out = {};
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function authCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: 24 * 3600 * 1000,
    path: '/',
  };
}
function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  return parseCookies(req)[AUTH_COOKIE]
    || (header.startsWith('Bearer ') ? header.slice(7) : null);
}
// El id real de empleado detrás de un JWT (quita el prefijo superadmin:).
function employeeBaseId(decoded) {
  const id = String(decoded?.id || '');
  return id.startsWith('superadmin:') ? id.split(':')[1] : id;
}
// v1.3 (CRM v5.3.29 H-A5): claves demasiado débiles para crear/cambiar.
const COMMON_PASSWORDS = new Set(['password', '123456', '12345678', '123456789', '1234567890', 'qwerty', '1234567', '111111', '12345678910', '123123', 'abc123', '1234', 'admin', 'admin123', 'salon', 'salon123', '12345', '000000', 'cambia-esta-clave']);
function isWeakPassword(pw) {
  return !pw || pw.length < 8 || COMMON_PASSWORDS.has(String(pw).toLowerCase());
}

// Asegurar que cada cliente de la base de datos use la hora de Colombia
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'America/Bogota'");
});

// CORS: mismo origen por defecto; solo se abre otro origen si CORS_ORIGIN está definido.
app.use(cors({ origin: CORS_ORIGIN || false }));
app.use(helmet({ contentSecurityPolicy: false })); // CSP desactivada: el frontend usa Tailwind CDN e importmap con scripts inline.
// El webhook de Meta verifica la firma HMAC sobre el body CRUDO
// (X-Hub-Signature-256): express.json lo parsea, así que se guarda el
// buffer crudo en req.rawBody solo para esa ruta, sin tocar las demás.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { if (req.url.startsWith('/api/webhooks/meta')) req.rawBody = buf; } }));
// Logos subidos (marca blanca): públicos, solo imágenes estáticas.
fs.mkdirSync(uploadsDir(), { recursive: true });
fs.mkdirSync(waMediaDir(), { recursive: true });
// v1.3 (CRM v5.3.25 M9): /uploads/wa-media exige sesión válida (cookie
// HttpOnly o Bearer, igual que la API): antes cualquiera con la URL
// descargaba las fotos y vídeos de las clientas sin iniciar sesión. El
// logo sí queda público: la página de login lo muestra sin sesión.
// (El montaje protegido va primero: Express prueba los montajes en orden.)
app.use('/uploads/wa-media', (req, res, next) => {
  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { jwt.verify(token, jwtSecret); return next(); }
  catch { return res.status(401).json({ error: 'Token inválido o expirado' }); }
}, express.static(waMediaDir(), {
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    const ext = path.extname(filePath).slice(1).toLowerCase();
    res.setHeader('Content-Type', WA_EXT_MIME[ext] || 'application/octet-stream');
  },
}));
app.use('/uploads', express.static(uploadsDir()));

// Middleware de Logs de peticiones
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    logger.info(`${req.method} ${req.path}`);
  }
  next();
});

// ---------- SEGURIDAD v3: JWT ----------
const PUBLIC_API = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/logout' },
  // Volver de un salón al superadmin: público como el logout, porque el
  // token de salón (1 h) puede haber expirado y aun así hay que poder
  // restaurar la sesión guardada. El handler verifica la cookie guardada.
  { method: 'POST', path: '/api/salons/exit' },
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/settings/branding' },
  { method: 'GET', path: '/api/public/branding/:slug' },
  { method: 'GET', path: '/api/public/reserva/:slug' },
  { method: 'GET', path: '/api/public/reserva/:slug/slots' },
  { method: 'POST', path: '/api/public/reserva/:slug' },
  // Webhooks de pasarelas de pago: públicos por diseño (los verifica la
  // firma de cada proveedor, no el JWT del CRM). Ver sección v5 Facturación.
  { method: 'POST', path: '/api/webhooks/wompi' },
  { method: 'POST', path: '/api/webhooks/payu' },
  // Webhook de WhatsApp Meta Cloud API: público por diseño. El GET se
  // verifica con META_WA_VERIFY_TOKEN y el POST con la firma HMAC
  // X-Hub-Signature-256 (META_WA_APP_SECRET). Ver sección v5 Parte 2B.
  { method: 'GET', path: '/api/webhooks/meta' },
  { method: 'POST', path: '/api/webhooks/meta' },
];
const isPublicApi = (req) => PUBLIC_API.some(r => {
  if (r.method !== req.method) return false;
  if (r.path === req.path) return true;
  if (r.path.includes(':slug')) {
    const base = r.path.split('/:slug')[0];
    return req.path === base || req.path.startsWith(base + '/');
  }
  return false;
});
// Rutas que NO necesitan base de datos (estado en memoria de WhatsApp / health
// y los endpoints de estado del sistema, que deben poder decir "la DB está
// caída" aunque la DB esté caída).
const DB_FREE = [/^\/api\/health$/, /^\/api\/wa\//, /^\/api\/system\//];
const needsDb = (req) => !DB_FREE.some(rx => rx.test(req.path));

async function authMiddleware(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  if (isPublicApi(req)) return next();
  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  let decoded;
  try { decoded = jwt.verify(token, jwtSecret); }
  catch (e) { return res.status(401).json({ error: 'Token inválido o expirado' }); }
  req.user = decoded;
  if (needsDb(req)) {
    // v1.3 (CRM v5.3.26 B2/B3): fail-closed + revocación por token_version.
    // Sin DB, o si la consulta falla, NADIE entra (antes el token JWT era
    // válido aunque la DB estuviera caída). Un cambio de clave o un logout
    // sube token_version y mata todos los JWT viejos de ese empleado.
    if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
    try {
      const r = await pool.query('SELECT active, role, token_version FROM employees WHERE id = $1', [employeeBaseId(decoded)]);
      if (!r.rows[0] || !r.rows[0].active) return res.status(401).json({ error: 'Cuenta desactivada' });
      if ((r.rows[0].token_version ?? 0) !== (decoded.tv ?? 0)) {
        return res.status(401).json({ error: 'Sesión revocada, inicia sesión de nuevo' });
      }
    } catch (e) {
      return res.status(503).json({ error: 'Base de datos no disponible' });
    }
  }
  next();
}
app.use(authMiddleware);

// v1.3 (CRM v5.3.30): limitadores por USUARIO, no por IP. Con límite por IP,
// 30 personas detrás de la IP de una oficina se bloqueaban entre sí (429).
// La clave es user:<id> cuando hay JWT; sin sesión, la IP (con el generador
// seguro de express-rate-limit para IPv6).
const rateLimitKey = (req) => (req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip));
const rateLimitMsg = (msg) => ({ message: msg });
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 600, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (req, res) => res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' }),
});
const waSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (req, res) => res.status(429).json({ error: 'Demasiados mensajes en poco tiempo. Espera unos minutos.' }),
});
const settingsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (req, res) => res.status(429).json({ error: 'Demasiados cambios de ajustes en poco tiempo. Espera unos minutos.' }),
});
const uploadLimiter = rateLimit({
  // v1.3 (CRM v5.3.34 H-M11): 10/15 min por USUARIO (antes 20/15 min: un
  // usuario podía llenar el volumen con subidas de 2 MB — el tope total de
  // uploads/ lo pone además la cuota de disco, ver uploadQuotaGuard).
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (req, res) => res.status(429).json({ error: 'Demasiadas subidas en poco tiempo. Espera unos minutos.' }),
});
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => res.status(429).json({ error: 'Demasiadas peticiones' }),
});
app.use('/api', apiLimiter);

function requireAdmin(req, res, next) {
  const r = (req.user?.role || '').toLowerCase();
  if (r !== 'admin' && r !== 'superadmin') {
    return res.status(403).json({ error: 'Solo administradores' });
  }
  next();
}
// salonId del JWT verificado (entero) o null. NUNCA sale de la query.
function salonIdNum(req) {
  const v = req.user && req.user.salonId != null ? Number(req.user.salonId) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// v5 Parte 2C — Permisos finos de equipo. Admin: todo. Sales_Agent
// ("director"/líder): solo sus subordinados directos, es decir empleados
// con employees.parent_id = su propio id. El campo real de jerarquía es
// parent_id (no existe manager_id ni supervisor en employees; el JWT
// trae id como string, así que se compara con String()). Cualquier otro
// rol (advisor, operator) -> 403. Para POST /api/staff (upsert por
// email): si el correo ya existe, el objetivo es ese empleado; si no,
// el parentId del body. Un líder tampoco puede cambiar el director de
// un empleado ni ascenderlo a Admin.
async function requireAdminOrLeader(req, res, next) {
  const role = (req.user?.role || '').toLowerCase();
  if (role === 'admin') return next();
  if (role !== 'sales_agent') {
    return res.status(403).json({ error: 'Solo administradores o el director del empleado' });
  }
  const leaderId = req.user?.id;
  if (!leaderId) return res.status(403).json({ error: 'Solo administradores o el director del empleado' });
  try {
    let targetParentId = null;
    let found = false;
    if (req.params?.id) {
      const r = await pool.query('SELECT parent_id FROM employees WHERE id = $1', [req.params.id]);
      if (r.rows[0]) { found = true; targetParentId = r.rows[0].parent_id; }
    } else if (req.body?.email) {
      const r = await pool.query('SELECT parent_id FROM employees WHERE email = $1', [req.body.email]);
      if (r.rows[0]) { found = true; targetParentId = r.rows[0].parent_id; }
      else if (req.body.parentId !== undefined && req.body.parentId !== null && req.body.parentId !== '') {
        found = true; targetParentId = Number(req.body.parentId);
      }
    } else if (req.body?.parentId !== undefined && req.body.parentId !== null && req.body.parentId !== '') {
      found = true; targetParentId = Number(req.body.parentId);
    }
    if (!found || targetParentId === null || targetParentId === undefined || String(targetParentId) !== String(leaderId)) {
      return res.status(403).json({ error: 'Solo puedes gestionar a tus subordinados directos' });
    }
    if (req.body?.parentId !== undefined && req.body.parentId !== null && req.body.parentId !== '' && String(req.body.parentId) !== String(leaderId)) {
      return res.status(403).json({ error: 'No puedes cambiar el director de un empleado' });
    }
    if (typeof req.body?.role === 'string' && req.body.role.toLowerCase() === 'admin') {
      return res.status(403).json({ error: 'Solo un administrador puede crear administradores' });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ---------- ROLES UNIFICADOS v5.2 ----------
// Antes había dos verdades: en BD se guardaba 'Admin'/'Advisor'/
// 'Sales_Agent' con mayúscula (el formulario de Equipo mandaba el valor
// de la pestaña tal cual) y en el JWT/login en minúscula, y los endpoints
// confiaban en el rol que el CLIENTE mandaba por query (?role=admin...):
// cualquiera podía pedirse el rol que quisiera. Ahora hay UNA sola
// verdad, en minúscula, y el alcance sale SIEMPRE del JWT verificado
// (req.user), nunca de la query. Los params role/userName/userId de la
// query se ignoran para el alcance (se mantienen en la URL solo por
// compatibilidad con el frontend viejo; el servidor no los usa).
const VALID_ROLES = ['superadmin', 'admin', 'recepcionista', 'estilista', 'manicurista', 'advisor', 'operator', 'sales_agent'];
function normalizeRoleValue(v) {
  const r = String(v ?? '').toLowerCase().trim();
  return VALID_ROLES.includes(r) ? r : null;
}
// v1.3: el superadmin puede todo lo que puede un admin de salón.
// En el CRM solo existía 'admin'; aquí 'superadmin' es el dueño de la
// plataforma y no debe quedar bloqueado de los ajustes solo-admin.
function isAdminRole(v) {
  const r = normalizeRoleValue(v);
  return r === 'admin' || r === 'superadmin';
}
// Alcance por rol desde el JWT. Admin: todo (names null). advisor:
// solo lo suyo, por nombre exacto (los servicios/leads guardan el
// asesor por nombre). sales_agent (líder de ventas): lo suyo + su red
// (subordinados directos, employees.parent_id = su id). operator: solo
// sus servicios asignados (su nombre en services.operators).
async function getRoleScope(req) {
  const role = normalizeRoleValue(req.user?.role) || 'operator';
  const userId = req.user?.id != null ? String(req.user.id) : null;
  const userName = (req.user?.name || '').trim() || null;
  const salonId = salonIdNum(req);
  const isSuperadmin = role === 'superadmin';
  // recepcionista ve todo su salón (como admin, sin ajustes ni DIAN);
  // estilista/manicurista solo lo suyo (como operator).
  const salonWide = role === 'admin' || role === 'recepcionista' || isSuperadmin;
  if (role === 'admin' || isSuperadmin) return { role, userId, userName, names: null, teamNames: [], salonId, isSuperadmin, salonWide };
  if (role === 'recepcionista') return { role, userId, userName, names: null, teamNames: [], salonId, isSuperadmin, salonWide };
  if (role === 'sales_agent') {
    let teamNames = [];
    if (userId) {
      const t = await pool.query('SELECT name FROM employees WHERE parent_id = $1 AND active = true', [userId]);
      teamNames = t.rows.map((r) => r.name);
    }
    return { role, userId, userName, names: [userName, ...teamNames].filter(Boolean), teamNames };
  }
  return { role, userId, userName, names: userName ? [userName] : [], teamNames: [] };
}
// Añade el filtro de alcance a cláusulas WHERE con params. advisorCol:
// columna del asesor (p. ej. 'advisor'); operatorsCol: columna array de
// operadores (p. ej. 'operators') o null si el recurso no la tiene
// (entonces el operador no ve nada de ese recurso).
function applyRoleScopeClauses(scope, clauses, params, { advisorCol = 'advisor', operatorsCol = null } = {}) {
  if (!scope || scope.role === 'admin' || scope.role === 'superadmin' || scope.role === 'recepcionista') return;
  if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') {
    if (!operatorsCol) { clauses.push('1 = 0'); return; }
    params.push(scope.userName);
    clauses.push(`$${params.length} = ANY(${operatorsCol})`);
    return;
  }
  if (scope.names && scope.names.length) {
    params.push(scope.names);
    clauses.push(`${advisorCol} = ANY($${params.length})`);
  } else { clauses.push('1 = 0'); }
}
// Variantes de un teléfono para comparar en SQL (tal cual, normalizado
// +57 y solo los 10 dígitos): cubre filas viejas guardadas en otro formato.
function phoneVariantsFor(phone) {
  const out = new Set();
  const raw = String(phone || '').trim();
  if (!raw) return [];
  out.add(raw);
  const { phone: norm } = normalizePhoneCO(raw);
  out.add(norm);
  out.add(norm.replace('+', ''));
  if (norm.startsWith('+57')) out.add(norm.slice(3));
  return [...out];
}
// Teléfonos (normalizados) de los clientes de los servicios asignados a
// un operador, para acotar chats/leads/totales a lo suyo.
async function operatorServicePhones(userName) {
  if (!userName) return [];
  const r = await pool.query('SELECT DISTINCT client_phone FROM services WHERE $1 = ANY(operators)', [userName]);
  const phones = new Set();
  for (const row of r.rows) for (const v of phoneVariantsFor(row.client_phone)) phones.add(v);
  return [...phones];
}
// Facturación (B6): admin o asesor (vendedor). El asesor factura y cobra,
// pero NO anula (eso sigue siendo solo admin) ni toca la configuración
// DIAN ni el tipo por defecto.
function requireBilling(req, res, next) {
  const role = normalizeRoleValue(req.user?.role);
  if (role === 'admin' || role === 'superadmin' || role === 'advisor' || role === 'recepcionista') return next();
  return res.status(403).json({ error: 'Solo administradores o recepcionistas pueden facturar' });
}

// Salud del sistema: nunca rompe sin DB. Es la ruta que miran los monitores
// externos (UptimeRobot / Better Stack) cada 5 min.
app.get('/api/health', async (req, res) => {
  let db = false;
  if (dbUrl) {
    try { await pool.query('SELECT 1'); db = true; } catch (e) { db = false; }
  }
  const wa = waStatusSummary();
  // v1.3 (CRM v5.3.29): el detalle (DB, WhatsApp, disco) solo lo ve el
  // admin con JWT válido; sin sesión solo ok + versión (lo que necesita
  // Railway para el healthcheck y cualquiera para saber si está vivo).
  let isAdmin = false;
  const token = tokenFromRequest(req);
  if (token) {
    try {
      const d = jwt.verify(token, jwtSecret);
      isAdmin = ['admin', 'superadmin'].includes((d.role || '').toLowerCase());
    } catch { /* sin sesión válida: solo lo mínimo */ }
  }
  if (!isAdmin) return res.json({ ok: !dbUrl || db, version: APP_VERSION });
  res.json({
    ok: !dbUrl || db, version: APP_VERSION, db,
    uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    whatsapp: { instances: wa.total, connected: wa.connected, authenticated: wa.authenticated },
  });
});

// ---------- ESTADO DEL SISTEMA v3.1 (solo admin) ----------

async function checkDb() {
  const t0 = Date.now();
  if (!dbUrl) return { status: 'red', ok: false, ms: 0, detail: 'DATABASE_URL no configurada' };
  try {
    await pool.query('SELECT 1');
    return { status: 'green', ok: true, ms: Date.now() - t0, detail: 'SELECT 1 correcto' };
  } catch (e) {
    return { status: 'red', ok: false, ms: Date.now() - t0, detail: e.message };
  }
}

async function getLastBackupInfo() {
  // El último respaldo se guarda en settings (clave last_backup) al terminar
  // cada respaldo, así sobrevive a reinicios. En memoria queda lo de la sesión.
  if (lastBackup.at) return lastBackup;
  if (!dbUrl) return lastBackup;
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'last_backup'");
    if (r.rows[0]?.value) return JSON.parse(r.rows[0].value);
  } catch { /* sin tabla settings aún */ }
  return lastBackup;
}

async function getSystemStatus() {
  const db = await checkDb();
  const wa = waStatusSummary();
  const waStatus = wa.total === 0 ? 'yellow'
    : wa.connected === wa.total ? 'green'
    : wa.connected > 0 ? 'yellow' : 'red';
  const mem = process.memoryUsage();
  let disk = null;
  try {
    const s = await fs.promises.statfs(path.join(__dirname, 'uploads'));
    const totalMB = Math.round(s.blocks * s.bsize / 1024 / 1024);
    const freeMB = Math.round(s.bfree * s.bsize / 1024 / 1024);
    disk = { freeMB, totalMB, usedPercent: totalMB > 0 ? Math.round((totalMB - freeMB) / totalMB * 100) : null };
  } catch { disk = null; }
  // Cola de mensajes: la tabla messages de crm6 NO tiene columna status
  // (no hay "en cola" persistente), así que se informa lo que sí se sabe:
  // mensajes recientes y conversaciones sin leer. Si WhatsApp no está listo,
  // los mensajes salientes no pueden salir: eso es lo que marca el semáforo.
  let queue = { status: 'green', detail: 'Sin columna status en messages; se mide por actividad reciente', recentMessages1h: null, unreadConversations: null };
  if (db.ok) {
    try {
      const r1 = await pool.query("SELECT COUNT(*) FROM messages WHERE timestamp >= NOW() - INTERVAL '1 hour'");
      const r2 = await pool.query('SELECT COUNT(*) FROM conversations WHERE unread_count > 0');
      queue.recentMessages1h = parseInt(r1.rows[0].count);
      queue.unreadConversations = parseInt(r2.rows[0].count);
      queue.detail = `${queue.recentMessages1h} mensajes en la última hora, ${queue.unreadConversations} conversaciones sin leer`;
      queue.status = wa.total > 0 && wa.connected === 0 ? 'red' : 'green';
    } catch (e) { queue = { status: 'red', detail: `No se pudo leer la cola: ${e.message}`, recentMessages1h: null, unreadConversations: null }; }
  } else {
    queue.status = 'red';
    queue.detail = 'Sin base de datos no se puede medir la cola';
  }
  const backup = await getLastBackupInfo();
  const backupStatus = !backup.at ? 'yellow'
    : backup.ok ? (Date.now() - new Date(backup.at).getTime() < 48 * 3600 * 1000 ? 'green' : 'yellow')
    : 'red';
  let critical = [];
  if (db.ok) {
    try {
      const r = await pool.query("SELECT id, level, component, message, created_at FROM system_events WHERE level IN ('error','critical') ORDER BY created_at DESC LIMIT 10");
      critical = r.rows;
    } catch { critical = eventBuffer.filter((e) => e.level === 'error' || e.level === 'critical').slice(-10).reverse(); }
  } else {
    critical = eventBuffer.filter((e) => e.level === 'error' || e.level === 'critical').slice(-10).reverse();
  }
  return {
    version: APP_VERSION,
    uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    alerts: { telegramConfigured: telegramConfigured(), emailConfigured: nodemailerAvailable && Boolean((process.env.SMTP_HOST || '').trim() && (process.env.ALERT_EMAIL || '').trim()) },
    components: [
      { key: 'db', label: 'Base de datos', status: db.status, detail: db.detail, latencyMs: db.ms },
      { key: 'whatsapp', label: 'WhatsApp por QR', status: waStatus, detail: wa.total === 0 ? 'Sin instancias configuradas' : `${wa.connected} de ${wa.total} instancias conectadas`, instances: wa.instances },
      { key: 'server', label: 'Servidor', status: 'green', detail: `Activo desde hace ${Math.floor((Date.now() - SERVER_STARTED_AT) / 60000)} min`, memoryMB: Math.round(mem.rss / 1024 / 1024), disk },
      { key: 'queue', label: 'Cola de mensajes', status: queue.status, detail: queue.detail, recentMessages1h: queue.recentMessages1h, unreadConversations: queue.unreadConversations },
      { key: 'backup', label: 'Último respaldo', status: backupStatus, detail: backup.at ? `${backup.ok ? 'OK' : 'FALLÓ'} el ${new Date(backup.at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}${backup.file ? ` (${backup.file})` : ''}` : 'Nunca se ha hecho un respaldo', backup },
    ],
    criticalEvents: critical,
  };
}

app.get('/api/system/status', requireAdmin, async (req, res) => {
  try { res.json(await getSystemStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/system/events', requireAdmin, async (req, res) => {
  const level = (req.query.level || '').toString();
  const component = (req.query.component || '').toString();
  const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  if (!dbUrl || !eventsTableReady) {
    let rows = [...eventBuffer].reverse();
    if (level) rows = rows.filter((e) => e.level === level);
    if (component) rows = rows.filter((e) => e.component === component);
    return res.json({ source: 'memory', events: rows.slice(0, limit) });
  }
  try {
    const params = [];
    let where = '';
    if (level) { params.push(level); where += `level = $${params.length}`; }
    if (component) { params.push(component); where += (where ? ' AND ' : '') + `component = $${params.length}`; }
    const r = await pool.query(
      `SELECT id, level, component, message, details, created_at FROM system_events ${where ? 'WHERE ' + where : ''} ORDER BY created_at DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    res.json({ source: 'db', events: r.rows });
  } catch (err) {
    res.json({ source: 'memory', events: [...eventBuffer].reverse().slice(0, limit), warning: err.message });
  }
});

app.post('/api/system/self-test', requireAdmin, async (req, res) => {
  const tests = [];
  const run = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      tests.push({ name, ok: true, ms: Date.now() - t0, detail: detail || 'OK' });
    } catch (e) {
      tests.push({ name, ok: false, ms: Date.now() - t0, detail: e.message });
    }
  };
  await run('Base de datos (SELECT 1)', async () => {
    if (!dbUrl) throw new Error('DATABASE_URL no configurada');
    await pool.query('SELECT 1');
    return 'Conexión y SELECT 1 correctos';
  });
  await run('Leer servicios', async () => {
    const r = await pool.query('SELECT COUNT(*) FROM services');
    return `${r.rows[0].count} servicios en total`;
  });
  await run('Leer plantillas', async () => {
    const r = await pool.query('SELECT COUNT(*) FROM templates');
    return `${r.rows[0].count} plantillas`;
  });
  await run('Leer equipo', async () => {
    const r = await pool.query('SELECT COUNT(*) FROM employees WHERE active = true');
    return `${r.rows[0].count} empleados activos`;
  });
  await run('WhatsApp por QR', async () => {
    const wa = waStatusSummary();
    if (wa.total === 0) throw new Error('Sin instancias de WhatsApp configuradas');
    if (wa.connected === 0) throw new Error(`${wa.total} instancia(s), ninguna conectada (hay que escanear el QR)`);
    return `${wa.connected} de ${wa.total} instancias conectadas`;
  });
  await run('Escritura en uploads/', async () => {
    const tmp = path.join(__dirname, 'uploads', `.selftest-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, 'self-test');
    fs.unlinkSync(tmp);
    return 'Se pudo escribir y borrar un archivo temporal';
  });
  await run('Alertas de Telegram', async () => {
    if (!telegramConfigured()) throw new Error('Telegram no configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID vacíos)');
    return 'Token y chat configurados (no se envió ningún mensaje en esta prueba)';
  });
  const failed = tests.filter((t) => !t.ok).length;
  const summary = { ok: failed === 0, passed: tests.length - failed, failed, total: tests.length };
  recordEvent(summary.ok ? 'info' : 'warn', 'server', `Autoprueba del sistema: ${summary.passed}/${summary.total} correctas`, summary);
  res.json({ summary, tests });
});

app.post('/api/system/whatsapp/reconnect', requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  const targets = id ? [id] : Object.keys(waClients);
  if (targets.length === 0) return res.status(400).json({ error: 'No hay instancias de WhatsApp para reconectar. Crea una en Canales WhatsApp.' });
  const results = [];
  for (const tid of targets) {
    const inst = waClients[tid];
    const name = inst?.name || tid;
    try {
      if (inst?.client) {
        try { await inst.client.destroy(); } catch { /* ya estaba muerto */ }
        delete waClients[tid];
      }
      // AUDITORÍA v1.1: se reconecta con el mismo canal y salón de antes.
      let ch = inst?.channel || 'qr';
      let sid = inst?.salonId ?? null;
      if (!inst && dbOk) {
        try { const dbi = await pool.query('SELECT channel, salon_id FROM wa_instances WHERE id=$1', [tid]); if (dbi.rows[0]) { ch = dbi.rows[0].channel || ch; sid = dbi.rows[0].salon_id; } } catch { /* solo memoria */ }
      }
      await initWhatsApp(tid, name, ch, sid);
      results.push({ id: tid, ok: true, detail: 'Reconectando: escanea el QR nuevo en Canales WhatsApp si aparece' });
      recordEvent('info', 'whatsapp', `Reconexión manual de WhatsApp: ${name}`, { instance: tid });
    } catch (e) {
      results.push({ id: tid, ok: false, detail: e.message });
      recordEvent('error', 'whatsapp', `No se pudo reconectar WhatsApp (${name}): ${e.message}`, { instance: tid });
    }
  }
  res.json({ results });
});

app.post('/api/system/alerts/test', requireAdmin, async (req, res) => {
  const text = `🔔 Prueba de alertas de SalonOS (v${APP_VERSION}): si lees esto en Telegram, las alertas funcionan. ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`;
  const r = await sendTelegramAlert(text);
  recordEvent(r.sent ? 'info' : 'warn', 'alerts', r.sent ? 'Prueba de alerta Telegram enviada' : `Prueba de alerta Telegram falló: ${r.reason}`, {});
  res.json({ ...r, text });
});

app.post('/api/system/backup', requireAdmin, async (req, res) => {
  try {
    const r = await runBackup('manual');
    if (!r.ok) return res.status(r.code || 500).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// v1.3 (CRM v5.3.33): descarga del respaldo, solo admin, nombre validado
// (sin traversal: el nombre debe parecer <marca>-AAAAMMDD-HHMMSS.sql.gz[.enc]).
app.get('/api/system/backup/download', requireAdmin, async (req, res) => {
  const file = String(req.query.file || '');
  if (!BACKUP_FILE_RE.test(file)) return res.status(400).json({ error: 'Nombre de respaldo inválido' });
  const filePath = path.join(backupsDir(), file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Respaldo no encontrado' });
  res.download(filePath, file);
});

// v1.3 (CRM v5.3.34 H-M11): limpieza manual de huérfanos (la automática
// corre a diario tras el respaldo de las 02:00).
app.post('/api/system/cleanup-uploads', requireAdmin, async (req, res) => {
  try {
    const r = await cleanupOrphanUploads();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- NORMALIZACIÓN DE TELÉFONOS v5 Parte 2B ----------
// Normaliza los teléfonos ya guardados (leads, services, employees y
// conversations) a +57... con la misma regla de normalizePhoneCO. NO borra
// duplicados: si dos valores distintos normalizan al mismo número (o el
// número normalizado ya existe en la tabla), se reportan en `collisions`
// como { table, phone, count } y esas filas NO se tocan, para que el admin
// las revise y fusione a mano. El id de las conversaciones (wa_<dígitos>)
// no se toca: renombrarlo rompería la FK de messages. El resultado queda
// en system_events.
app.post('/api/system/normalize-phones', requireAdmin, async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  const targets = [
    { table: 'leads', column: 'client_phone' },
    { table: 'services', column: 'client_phone' },
    { table: 'employees', column: 'phone' },
    { table: 'conversations', column: 'client_phone' },
  ];
  let updated = 0;
  const collisions = [];
  const perTable = {};
  try {
    for (const { table, column } of targets) {
      const r = await pool.query(`SELECT DISTINCT ${column} AS phone FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`);
      const allValues = new Set(r.rows.map((row) => row.phone));
      const groups = new Map();
      for (const row of r.rows) {
        const { phone: norm, normalized } = normalizePhoneCO(row.phone);
        if (!normalized || norm === row.phone) continue;
        if (!groups.has(norm)) groups.set(norm, []);
        groups.get(norm).push(row.phone);
      }
      let tableUpdated = 0;
      for (const [norm, originals] of groups) {
        const alreadyThere = allValues.has(norm) ? 1 : 0;
        if (originals.length > 1 || alreadyThere) {
          collisions.push({ table, phone: norm, count: originals.length + alreadyThere });
          continue;
        }
        const u = await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [norm, originals[0]]);
        tableUpdated += u.rowCount;
        updated += u.rowCount;
      }
      perTable[table] = tableUpdated;
    }
    const summary = { updated, collisions, perTable };
    await recordEvent('info', 'system', `Normalización de teléfonos: ${updated} filas actualizadas, ${collisions.length} colisiones sin tocar`, summary);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- CUOTA DE DISCO PARA SUBIDAS (v1.3, CRM v5.3.34 H-M11) ----------
// El limitador frena la velocidad, pero no el total: sin cuota, subir
// archivos llena el volumen y caen WhatsApp, la base de datos y los
// respaldos. Dos topes: total de uploads/ y por usuario/día. Prioridad:
// ajuste en settings > variable de entorno > valor por defecto. Los
// contadores por usuario viven en memoria: un reinicio los pone a cero
// (el tope total, que se mide en disco, no se ve afectado).
const UPLOADS_MAX_MB_DEFAULT = 300;
const UPLOADS_USER_DAY_MAX_MB_DEFAULT = 100;
function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSizeBytes(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* noop */ } }
    }
  } catch { return 0; }
  return total;
}
async function getUploadsMaxBytes() {
  const fromSettings = parseInt((await getSettingValue('uploads_max_mb', '')) || '', 10);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings * 1024 * 1024;
  const fromEnv = parseInt(process.env.UPLOADS_MAX_MB || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv * 1024 * 1024;
  return UPLOADS_MAX_MB_DEFAULT * 1024 * 1024;
}
async function getUploadsUserDayMaxBytes() {
  const fromSettings = parseInt((await getSettingValue('uploads_user_day_max_mb', '')) || '', 10);
  if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings * 1024 * 1024;
  const fromEnv = parseInt(process.env.UPLOADS_USER_DAY_MAX_MB || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv * 1024 * 1024;
  return UPLOADS_USER_DAY_MAX_MB_DEFAULT * 1024 * 1024;
}
const uploadUsageByUser = new Map(); // userId -> { date: 'YYYY-MM-DD', bytes }
function todayCO() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); }
function getUserDayUsage(userId) {
  const e = uploadUsageByUser.get(userId);
  if (!e || e.date !== todayCO()) return 0;
  return e.bytes || 0;
}
function addUserDayUsage(userId, bytes) {
  const today = todayCO();
  const e = uploadUsageByUser.get(userId);
  if (!e || e.date !== today) uploadUsageByUser.set(userId, { date: today, bytes });
  else e.bytes += bytes;
}
const fmtMB = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
// Pre-chequeo ANTES de que multer escriba a disco: con Content-Length se
// sabe el tamaño antes de recibir el cuerpo. Sin Content-Length (chunked)
// no se puede saber: la ruta del logo comprueba además el buffer en memoria.
async function uploadQuotaGuard(req, res, next) {
  try {
    const maxTotal = await getUploadsMaxBytes();
    const current = dirSizeBytes(uploadsDir());
    const len = parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(len) && len > 0 && current + len > maxTotal) {
      return res.status(413).json({ error: `Cuota de almacenamiento llena (${fmtMB(current)} de ${fmtMB(maxTotal)} usados). Borra archivos o amplía UPLOADS_MAX_MB.` });
    }
    const uid = req.user?.id;
    if (uid != null && Number.isFinite(len) && len > 0) {
      const maxDay = await getUploadsUserDayMaxBytes();
      const used = getUserDayUsage(uid);
      if (used + len > maxDay) {
        return res.status(413).json({ error: `Cuota diaria de subidas superada (${fmtMB(used)} de ${fmtMB(maxDay)} hoy). Inténtalo mañana.` });
      }
    }
    return next();
  } catch (e) {
    logger.warn(`Cuota de subidas no verificada: ${e.message}`);
    return next();
  }
}

// ---------- LIMPIEZA DE HUÉRFANOS EN uploads/ (v1.3, CRM v5.3.34 H-M11) ----------
// Referencias en la BD: messages.attachment_url y el ajuste
// branding_logo_url. Regla conservadora: se borra SOLO lo que (a) no está
// referenciado en ninguna de esas fuentes Y (b) tiene más de 30 días. El
// logo nunca se borra. Si la BD no responde o alguna consulta falla, NO se
// borra nada: mejor un huérfano que un archivo en uso.
async function cleanupOrphanUploads() {
  if (!dbOk) return { deleted: 0, freedBytes: 0, skipped: 'sin base de datos' };
  const refs = new Set();
  const addUrl = (u) => {
    if (typeof u === 'string' && u.startsWith('/uploads/')) refs.add(u.slice('/uploads/'.length));
  };
  try {
    const [m, s] = await Promise.all([
      pool.query("SELECT attachment_url FROM messages WHERE attachment_url IS NOT NULL AND attachment_url <> ''"),
      pool.query("SELECT value FROM settings WHERE key IN ('branding_logo_url')"),
    ]);
    for (const r of m.rows) addUrl(r.attachment_url);
    for (const r of s.rows) addUrl(r.value);
  } catch (e) {
    recordEvent('warn', 'storage', `Limpieza de huérfanos cancelada (no se borró nada): ${e.message}`, {});
    return { deleted: 0, freedBytes: 0, skipped: e.message };
  }
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let deleted = 0;
  let freedBytes = 0;
  const stack = [uploadsDir()];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(uploadsDir(), full).split(path.sep).join('/');
      if (rel === 'logo.png' || rel === 'logo.jpg') continue; // nunca el logo
      if (refs.has(rel)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs >= cutoff) continue;
      try { fs.unlinkSync(full); deleted++; freedBytes += st.size; } catch { /* un archivo no bloquea los demás */ }
    }
  }
  if (deleted > 0) {
    recordEvent('info', 'storage', `Limpieza de huérfanos: ${deleted} archivo(s) borrados, ${Math.round(freedBytes / 1024 / 1024)} MB liberados`, { deleted, freedBytes });
  }
  return { deleted, freedBytes };
}

// Respaldo con pg_dump (sin shell: pg_dump recibe la URL como argumento y
// su salida se comprime con gzip en Node). Devuelve 501 si no hay pg_dump.
// Nombre de archivo de respaldo válido: <marca>-AAAAMMDD-HHMMSS.sql.gz
// (con segundos desde v1.3: antes solo HHMM, dos respaldos en el mismo
// minuto compartían nombre y un intento fallido borraba el bueno). El
// patrón acepta también el formato viejo HHMM para no dejar fuera los
// respaldos ya guardados.
const BACKUP_FILE_RE = /^[a-z0-9-]+\-\d{8}\-\d{4}(\d{2})?\.sql\.gz(\.enc)?$/i;
async function runBackup(trigger = 'manual') {
  if (!dbUrl) return { ok: false, code: 503, error: 'Base de datos no configurada' };
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let file = `salonos-${stamp}.sql.gz`;
  const filePath = path.join(dir, file);
  return new Promise((resolve) => {
    let settled = false;
    // v1.3 (CRM v5.3.34 H-M8): ningún fallo de respaldo es silencioso. Al
    // fallar se persiste el lastBackup ok:false (getLastBackupInfo lee
    // settings primero: sin esto, tras un reinicio se seguiría viendo el
    // último OK) y se avisa por Telegram (best-effort).
    const done = (r) => {
      if (!settled) {
        settled = true;
        if (!r.ok) {
          try {
            pool.query("INSERT INTO settings (key, value) VALUES ('last_backup', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(lastBackup)]).catch(() => { /* sin settings aún */ });
          } catch { /* sin settings aún */ }
          sendTelegramAlert(`🚨 SalonOS: respaldo fallido (${trigger}): ${r.error}`).catch(() => {});
        }
        resolve(r);
      }
    };
    let dump;
    try {
      dump = spawn('pg_dump', [dbUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const r = { ok: false, code: 501, error: `No se pudo lanzar pg_dump: ${e.message}` };
      lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
      recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
      return done(r);
    }
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(filePath);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    dump.on('error', (e) => {
      const r = { ok: false, code: 501, error: `pg_dump no disponible en este contenedor/servidor: ${e.message}. Instala postgresql-client o usa scripts/backup.sh en el host.` };
      try { fs.unlinkSync(filePath); } catch { /* no existe aún */ }
      lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
      recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
      done(r);
    });
    dump.stdout.pipe(gzip).pipe(out);
    out.on('finish', async () => {
      if (dump.exitCode !== 0 && dump.exitCode !== null) {
        const r = { ok: false, code: 500, error: `pg_dump terminó con error: ${stderr.slice(0, 500)}` };
        try { fs.unlinkSync(filePath); } catch { /* noop */ }
        lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error, encrypted: false };
        recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
        return done(r);
      }
      // v1.3 (CRM v5.3.34 H-M8, fail-closed): el respaldo NUNCA queda en
      // plano por accidente. Si el cifrado falla, se borra el .sql.gz (y
      // cualquier .enc parcial) y el respaldo falla. Sin clave, falla por
      // defecto: solo se guarda en plano con opt-in explícito del admin, y
      // aun así se avisa por evento y por Telegram en cada respaldo así.
      let finalFile = file;
      let finalPath = filePath;
      if (BACKUP_ENCRYPTION_KEY) {
        try {
          const plain = fs.readFileSync(filePath);
          const iv = crypto.randomBytes(16);
          const cipher = crypto.createCipheriv('aes-256-gcm', BACKUP_ENCRYPTION_KEY, iv);
          const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
          const tag = cipher.getAuthTag();
          fs.writeFileSync(`${filePath}.enc`, Buffer.concat([iv, enc, tag]));
          fs.unlinkSync(filePath);
          finalFile = `${file}.enc`;
          finalPath = `${filePath}.enc`;
        } catch (e) {
          const msg = `No se pudo cifrar el respaldo (${e.message}): se borró el archivo en plano y no se guardó respaldo`;
          try { fs.unlinkSync(filePath); } catch { /* noop */ }
          try { fs.unlinkSync(`${filePath}.enc`); } catch { /* noop */ }
          lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: msg, encrypted: false };
          recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${msg}`, {});
          return done({ ok: false, code: 500, error: msg });
        }
      } else if (!(await isUnencryptedBackupAllowed())) {
        const msg = BACKUP_ENCRYPTION_KEY_HEX
          ? 'BACKUP_ENCRYPTION_KEY inválida (debe ser 64 caracteres hex): pon una clave válida con `openssl rand -hex 32` o activa "Permitir respaldos sin cifrar" en Estado del Sistema'
          : 'Respaldo SIN cifrar no permitido: define BACKUP_ENCRYPTION_KEY en Railway/.env (genera una con `openssl rand -hex 32`) o activa "Permitir respaldos sin cifrar" en Estado del Sistema';
        try { fs.unlinkSync(filePath); } catch { /* noop */ }
        lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: msg, encrypted: false };
        recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${msg}`, {});
        return done({ ok: false, code: 500, error: msg });
      } else {
        // Opt-in explícito del admin: se guarda en plano, pero NUNCA en
        // silencio: evento + alerta de Telegram en cada respaldo así.
        const warn = `Respaldo SIN cifrar (permitido por el administrador): ${file} contiene toda la base de datos en plano`;
        logger.warn(warn);
        recordEvent('warn', 'backup', warn, { file });
        sendTelegramAlert(`⚠️ SalonOS: respaldo SIN cifrar (${trigger}): ${file} — contiene toda la base de datos en plano`).catch(() => {});
      }
      const sizeBytes = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;
      lastBackup = { at: new Date().toISOString(), ok: true, file: finalFile, sizeBytes, error: null, encrypted: Boolean(BACKUP_ENCRYPTION_KEY) };
      try {
        await pool.query("INSERT INTO settings (key, value) VALUES ('last_backup', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(lastBackup)]);
      } catch { /* sin settings aún, queda en memoria */ }
      // Retención: borrar respaldos de más de BACKUP_KEEP_DAYS días (solo
      // archivos con pinta de respaldo, para no tocar nada ajeno).
      try {
        const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 3600 * 1000;
        for (const f of fs.readdirSync(dir)) {
          if (!BACKUP_FILE_RE.test(f)) continue;
          const p = path.join(dir, f);
          if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        }
      } catch { /* limpieza opcional */ }
      recordEvent('info', 'backup', `Respaldo OK (${trigger}): ${finalFile} (${Math.round(sizeBytes / 1024)} KB)${BACKUP_ENCRYPTION_KEY ? ' [cifrado]' : ' [SIN cifrar]'}`, { file: finalFile, sizeBytes, encrypted: Boolean(BACKUP_ENCRYPTION_KEY) });
      done({ ok: true, file: finalFile, sizeBytes, encrypted: Boolean(BACKUP_ENCRYPTION_KEY), at: lastBackup.at });
    });
    out.on('error', (e) => {
      const r = { ok: false, code: 500, error: `No se pudo escribir el respaldo: ${e.message}` };
      lastBackup = { at: new Date().toISOString(), ok: false, file: null, sizeBytes: null, error: r.error };
      recordEvent('error', 'backup', `Respaldo falló (${trigger}): ${r.error}`, {});
      done(r);
    });
  });
}

// Vigilante: cada 5 min comprueba DB y WhatsApp. Solo avisa cuando algo
// CAMBIA de bien a mal (o de mal a bien), y nunca repite el mismo aviso
// antes de 30 min (anti-spam en maybeAlert).
async function watchdogCheck() {
  try {
    const db = await checkDb();
    if (watchdogState.db === 'ok' && !db.ok) {
      recordEvent('critical', 'db', `La base de datos dejó de responder: ${db.detail}`, {});
      maybeAlert('db-down', `🚨 El CRM perdió la base de datos: ${db.detail}`);
    } else if (watchdogState.db === 'error' && db.ok) {
      recordEvent('info', 'db', 'La base de datos volvió a responder', {});
      maybeAlert('db-down', '✅ La base de datos del CRM volvió a responder.', { force: true });
    }
    watchdogState.db = db.ok ? 'ok' : 'error';
    const wa = waStatusSummary();
    const waOk = wa.total === 0 || wa.connected > 0;
    if (watchdogState.whatsapp === 'ok' && !waOk && wa.total > 0) {
      recordEvent('critical', 'whatsapp', 'WhatsApp: ninguna instancia conectada', { total: wa.total });
      maybeAlert('whatsapp-down', '🚨 WhatsApp: ninguna instancia conectada. Hay que escanear el QR en el CRM.');
    } else if (watchdogState.whatsapp === 'error' && waOk && wa.total > 0) {
      recordEvent('info', 'whatsapp', 'WhatsApp volvió a conectarse', {});
      maybeAlert('whatsapp-down', '✅ WhatsApp volvió a conectarse.', { force: true });
    }
    if (wa.total > 0) watchdogState.whatsapp = waOk ? 'ok' : 'error';
    // v1.3 (lección CRM en vivo): instancia 'autenticada' más de 5 min sin
    // llegar a 'ready' = WhatsApp no vivo aunque la sesión exista. Se avisa
    // (maybeAlert tiene anti-spam de 30 min) y queda en Últimos eventos.
    for (const inst of wa.instances) {
      if (inst.status === 'authenticated' && inst.authenticatedAt && Date.now() - new Date(inst.authenticatedAt).getTime() > 5 * 60 * 1000) {
        recordEvent('warn', 'whatsapp', `WhatsApp ${inst.name}: autenticado hace más de 5 min sin llegar a listo; los mensajes no entran ni salen. Vuelve a escanear el QR o reinicia la instancia.`, { instance: inst.id });
        maybeAlert(`wa-not-ready-${inst.id}`, `⚠️ WhatsApp (${inst.name}): autenticado pero sin llegar a listo en más de 5 min. Los mensajes no entran ni salen.`);
      }
    }
    // v1.3 (CRM v5.3.34 H-M11): alerta de disco al 80% (máx. 1 vez por hora;
    // el evento queda siempre en Últimos eventos aunque no haya Telegram).
    try {
      const s = await fs.promises.statfs(uploadsDir());
      const totalMB = Math.round(s.blocks * s.bsize / 1024 / 1024);
      const freeMB = Math.round(s.bfree * s.bsize / 1024 / 1024);
      const pct = totalMB > 0 ? Math.round((totalMB - freeMB) / totalMB * 100) : null;
      if (pct != null && pct >= 80 && Date.now() - lastDiskAlertAt > 60 * 60 * 1000) {
        lastDiskAlertAt = Date.now();
        recordEvent('warn', 'storage', `Disco al ${pct}% (${freeMB} MB libres de ${totalMB} MB): libera espacio o WhatsApp, la base de datos y los respaldos dejarán de funcionar`, { usedPercent: pct });
        sendTelegramAlert(`⚠️ SalonOS: disco al ${pct}% — solo quedan ${freeMB} MB libres de ${totalMB} MB. Libera espacio (limpiar subidas huérfanas o borrar respaldos viejos) antes de que se llene.`).catch(() => {});
      }
    } catch { /* la alerta de disco nunca rompe el vigilante */ }
  } catch (e) {
    recordEvent('error', 'server', `El vigilante falló: ${e.message}`, {});
  }
}
setInterval(watchdogCheck, 5 * 60 * 1000);

// Respaldo diario a las 02:00 (America/Bogota). Si pg_dump no existe en la
// imagen, el intento queda registrado como evento de error y no tumba nada.
function scheduleDailyBackup() {
  if (!BACKUP_ENABLED) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    await runBackup('automático diario 02:00');
    // v1.3 (CRM v5.3.34 H-M11): la limpieza de huérfanos corre una vez al
    // día, justo después del respaldo, cuando el sistema está en calma.
    try { await cleanupOrphanUploads(); } catch (e) { logger.warn(`Limpieza de huérfanos falló: ${e.message}`); }
    scheduleDailyBackup();
  }, next.getTime() - now.getTime());
}
scheduleDailyBackup();

// MODIFICACIÓN: notifyUpdate ahora siempre incluye a la sala de administradores para omnisciencia
const notifyUpdate = (type = 'general', targetIds = []) => {
  const timestamp = new Date().toISOString();
  // Siempre notificamos a los administradores en tiempo real
  io.to('global_admin').emit('data_update', { type, timestamp });

  if (targetIds && targetIds.length > 0) {
    targetIds.forEach(id => {
      if (id) io.to(id.toString()).emit('data_update', { type, timestamp });
    });
  } else {
    // Si no hay objetivos específicos, emitimos a todos (incluyendo anónimos)
    io.emit('data_update', { type, timestamp });
  }
  logger.info(`Notificación enviada: ${type}`, { targetIds });
};


const initDB = async () => {
  if (!dbUrl) { logger.warn('DATABASE_URL no configurada: la API devolverá 503 y WhatsApp QR seguirá disponible en memoria'); return; }
  let client;
  try {
    client = await pool.connect();
    await client.query("SET TIME ZONE 'America/Bogota'");

    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        phone VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100),
        source VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS commission_tiers (
        id SERIAL PRIMARY KEY,
        role VARCHAR(20),
        min_value NUMERIC(15,2),
        max_value NUMERIC(15,2),
        percentage NUMERIC(5,2)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(50) PRIMARY KEY,
        account_id INTEGER,
        client_name VARCHAR(100) DEFAULT 'Cliente Nuevo',
        client_phone VARCHAR(50),
        source VARCHAR(50),
        inbox_name VARCHAR(100),
        last_message TEXT,
        last_message_time TIMESTAMP DEFAULT NOW(),
        unread_count INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'open',
        channel VARCHAR(10) DEFAULT 'qr',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS client_notes (
        client_phone VARCHAR(50) PRIMARY KEY,
        content TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS client_reminders (
        id SERIAL PRIMARY KEY,
        client_phone VARCHAR(50),
        client_name VARCHAR(100),
        title TEXT,
        alert_at TIMESTAMP,
        is_processed BOOLEAN DEFAULT FALSE,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(50) UNIQUE,
        client_name VARCHAR(100) DEFAULT 'Cliente Nuevo',
        client_phone VARCHAR(50),
        status VARCHAR(30) DEFAULT 'NUEVO',
        items_to_clean TEXT,
        location TEXT,
        address TEXT,
        estimated_value NUMERIC(12,2) DEFAULT 0,
        advisor VARCHAR(100),
        lost_reason TEXT,
        technical_images TEXT[] DEFAULT '{}',
        source VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        assigned_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(50) REFERENCES conversations(id) ON DELETE CASCADE,
        sender VARCHAR(20),
        type VARCHAR(20) DEFAULT 'text',
        content TEXT,
        attachment_url TEXT,
        external_id VARCHAR(100) UNIQUE,
        timestamp TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS services (
        id VARCHAR(50) PRIMARY KEY,
        date DATE,
        time VARCHAR(10),
        client_name VARCHAR(100) DEFAULT 'Sin Nombre',
        client_phone VARCHAR(50),
        city VARCHAR(50),
        neighborhood VARCHAR(100),
        address TEXT,
        advisor VARCHAR(100),
        operators TEXT[],
        items_to_clean TEXT,
        service_performed TEXT,
        observations TEXT,
        initial_value NUMERIC(12,2) DEFAULT 0,
        additional_items TEXT,
        additional_value NUMERIC(12,2) DEFAULT 0,
        total_value NUMERIC(12,2) DEFAULT 0,
        payment_method VARCHAR(50),
        expenses NUMERIC(12,2) DEFAULT 0,
        expenses_note TEXT,
        operator_payment NUMERIC(12,2) DEFAULT 0,
        advances NUMERIC(12,2) DEFAULT 0,
        net_profit NUMERIC(12,2) DEFAULT 0,
        is_warranty BOOLEAN DEFAULT FALSE,
        deal_status VARCHAR(20) DEFAULT 'AGENDADO',
        technical_images TEXT[] DEFAULT '{}',
        after_images TEXT[] DEFAULT '{}',
        client_signature TEXT,
        cancellation_reason TEXT,
        source VARCHAR(50),
        reschedule_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE,
        password TEXT,
        role VARCHAR(20),
        phone VARCHAR(50),
        active BOOLEAN DEFAULT TRUE,
        commission_pct NUMERIC(5,2) DEFAULT 0,
        parent_id INTEGER REFERENCES employees(id),
        is_online BOOLEAN DEFAULT TRUE,
        last_assigned_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        title VARCHAR(100),
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        conversation_id VARCHAR(50) REFERENCES conversations(id) ON DELETE CASCADE,
        title TEXT,
        due_date DATE,
        completed BOOLEAN DEFAULT FALSE,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );
      -- v3.1 Monitoreo: qué se rompió y cuándo, para no depender de los logs.
      CREATE TABLE IF NOT EXISTS system_events (
        id SERIAL PRIMARY KEY,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        message TEXT NOT NULL,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_system_events_created ON system_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_events_level ON system_events(level);
      -- v5 Parte 2A Facturación y cobros (Colombia). La numeración sale de
      -- settings.invoice_next_number (empieza en 1 -> FAC-0001). NO es
      -- facturación electrónica DIAN: ver README, sección v5 Facturación.
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        number TEXT UNIQUE NOT NULL,
        -- v5.1 Tipo de factura: 'normal' (factura de venta sin DIAN, por
        -- defecto) o 'electronica' (DIAN-ready). El consecutivo FAC-XXXX es
        -- compartido por ambos tipos.
        type TEXT DEFAULT 'normal' CHECK (type IN ('normal', 'electronica')),
        service_id VARCHAR(50) REFERENCES services(id) ON DELETE SET NULL,
        client_name TEXT,
        client_phone VARCHAR(50),
        client_nit TEXT,
        subtotal NUMERIC(12,2) DEFAULT 0,
        advances NUMERIC(12,2) DEFAULT 0,
        total NUMERIC(12,2) DEFAULT 0,
        balance NUMERIC(12,2) DEFAULT 0,
        status TEXT DEFAULT 'pendiente',
        payment_method VARCHAR(50),
        payment_link TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        method TEXT,
        reference TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_service ON invoices(service_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(type);
      CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
      -- ===== SalonOS v1: multisalón =====
      CREATE TABLE IF NOT EXISTS salons (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        phone VARCHAR(50), address TEXT, city VARCHAR(100), plan TEXT DEFAULT 'basico',
        active BOOLEAN DEFAULT TRUE, logo_url TEXT,
        primary_color TEXT DEFAULT '#db2777', secondary_color TEXT DEFAULT '#f472b6',
        default_deposit_pct NUMERIC(5,2) DEFAULT 20,
        free_cancel_hours INTEGER DEFAULT 48, partial_cancel_hours INTEGER DEFAULT 24,
        partial_refund_pct NUMERIC(5,2) DEFAULT 50,
        commission_after_supplies BOOLEAN DEFAULT TRUE,
        invoice_next_number INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS salon_services (
        id SERIAL PRIMARY KEY, salon_id INTEGER NOT NULL REFERENCES salons(id),
        name TEXT NOT NULL, category TEXT DEFAULT 'general', description TEXT,
        duration_minutes INTEGER NOT NULL, cleanup_minutes INTEGER DEFAULT 15,
        price NUMERIC(12,2) NOT NULL, commission_pct NUMERIC(5,2) DEFAULT 0,
        deposit_pct NUMERIC(5,2) DEFAULT 20, team_size INTEGER DEFAULT 1,
        requires_consent BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE,
        UNIQUE (salon_id, name)
      );
      CREATE TABLE IF NOT EXISTS service_professionals (
        service_id INTEGER NOT NULL REFERENCES salon_services(id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        PRIMARY KEY (service_id, employee_id)
      );
      CREATE TABLE IF NOT EXISTS salon_clients (
        id SERIAL PRIMARY KEY, salon_id INTEGER NOT NULL REFERENCES salons(id),
        phone VARCHAR(50) NOT NULL, name VARCHAR(100), notes TEXT, allergies TEXT,
        formula TEXT, data_consent BOOLEAN DEFAULT FALSE,
        data_consent_text TEXT, data_consent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(), UNIQUE (salon_id, phone)
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY, salon_id INTEGER NOT NULL REFERENCES salons(id),
        group_id TEXT, service_id INTEGER REFERENCES salon_services(id),
        service_name TEXT, professional_id INTEGER, professional_ids INTEGER[] DEFAULT '{}',
        professional_name TEXT, client_phone VARCHAR(50), client_name VARCHAR(100),
        date DATE NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL,
        duration_minutes INTEGER, cleanup_minutes INTEGER DEFAULT 15,
        status TEXT DEFAULT 'pendiente' CHECK (status IN ('pendiente','confirmada','completada','cancelada','no-show','en_curso')),
        confirmation_status TEXT DEFAULT 'pendiente', source TEXT DEFAULT 'interna',
        price NUMERIC(12,2) DEFAULT 0, discount NUMERIC(12,2) DEFAULT 0, tip NUMERIC(12,2) DEFAULT 0,
        supplies_cost NUMERIC(12,2) DEFAULT 0, commission_pct_frozen NUMERIC(5,2) DEFAULT 0,
        commission_amount NUMERIC(12,2) DEFAULT 0, deposit_pct_frozen NUMERIC(5,2) DEFAULT 0,
        deposit_amount NUMERIC(12,2) DEFAULT 0, deposit_status TEXT DEFAULT 'pendiente',
        deposit_refund_amount NUMERIC(12,2) DEFAULT 0, policy_text TEXT,
        policy_accepted_at TIMESTAMP, notes TEXT,
        reminded_24h_at TIMESTAMP, reminded_2h_at TIMESTAMP, completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_appt_salon_date ON appointments(salon_id, date);
      CREATE INDEX IF NOT EXISTS idx_appt_prof ON appointments(salon_id, date, professional_id);
      CREATE TABLE IF NOT EXISTS salon_products (
        id SERIAL PRIMARY KEY, salon_id INTEGER NOT NULL REFERENCES salons(id),
        name TEXT NOT NULL, category TEXT DEFAULT 'general', stock NUMERIC(12,2) DEFAULT 0,
        min_stock NUMERIC(12,2) DEFAULT 2, cost NUMERIC(12,2) DEFAULT 0,
        price NUMERIC(12,2) DEFAULT 0, barcode TEXT, active BOOLEAN DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS pos_sales (
        id SERIAL PRIMARY KEY, salon_id INTEGER NOT NULL REFERENCES salons(id),
        appointment_id INTEGER REFERENCES appointments(id), professional_id INTEGER,
        client_phone VARCHAR(50), client_name VARCHAR(100), items JSONB DEFAULT '[]',
        subtotal NUMERIC(12,2) DEFAULT 0, discount NUMERIC(12,2) DEFAULT 0,
        tip_amount NUMERIC(12,2) DEFAULT 0, tip_professional_id INTEGER,
        total NUMERIC(12,2) DEFAULT 0, payment_methods JSONB DEFAULT '[]',
        document_type TEXT DEFAULT 'dee_pos', dian_transmitted BOOLEAN DEFAULT FALSE,
        cashier_id TEXT, created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pos_salon_day ON pos_sales(salon_id, created_at);
      CREATE TABLE IF NOT EXISTS waitlist (
        id SERIAL PRIMARY KEY, salon_id INTEGER NOT NULL REFERENCES salons(id),
        service_id INTEGER REFERENCES salon_services(id), professional_id INTEGER,
        client_phone VARCHAR(50), client_name VARCHAR(100), date_wanted DATE,
        status TEXT DEFAULT 'esperando', notified_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wa_instances (
        id TEXT PRIMARY KEY, salon_id INTEGER REFERENCES salons(id),
        name TEXT, channel TEXT DEFAULT 'qr', created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wa_queue (
        id SERIAL PRIMARY KEY, salon_id INTEGER NOT NULL REFERENCES salons(id),
        phone VARCHAR(50), content TEXT, status TEXT DEFAULT 'pendiente',
        sent_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // v5.1 Migración segura: las bases creadas en v5.0 tienen la tabla
    // invoices sin la columna type. Se añade aquí; las facturas viejas
    // quedan como 'normal' (factura de venta sin DIAN).
    await client.query(`
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'normal' CHECK (type IN ('normal', 'electronica'));
    `);
    // ===== SalonOS v1: columnas salon_id en tablas heredadas + trigger =====
    await client.query(`
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salons(id);
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS schedule JSONB;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      ALTER TABLE invoices ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
      -- Bot de reservas v1.1: interruptor por salón (APAGADO por defecto:
      -- un salón nuevo no recibe respuestas automáticas hasta que su dueño
      -- lo encienda) + quién/cuándo lo cambió + sesiones de conversación.
      ALTER TABLE salons ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN DEFAULT FALSE;
      ALTER TABLE salons ADD COLUMN IF NOT EXISTS bot_enabled_changed_by TEXT;
      ALTER TABLE salons ADD COLUMN IF NOT EXISTS bot_enabled_changed_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS wa_bot_sessions (
        salon_id INTEGER NOT NULL REFERENCES salons(id),
        client_phone VARCHAR(50) NOT NULL,
        state TEXT NOT NULL DEFAULT 'menu',
        data JSONB NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (salon_id, client_phone)
      );
      ALTER TABLE client_reminders ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS salon_id INTEGER;
      -- v1.3 (CRM v5.3.26/29/30): revocación de sesiones, estado de envío,
      -- evento de Google Calendar por cita, seguimiento de retoque, reintentos
      -- de la cola de WhatsApp y paginación del chat.
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_calendar_event_id TEXT;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminded_retouch_at TIMESTAMP;
      ALTER TABLE salon_services ADD COLUMN IF NOT EXISTS retouch_days INTEGER;
      ALTER TABLE wa_queue ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;
      ALTER TABLE wa_queue ADD COLUMN IF NOT EXISTS last_error TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id);
      CREATE INDEX IF NOT EXISTS idx_appt_gcal ON appointments(salon_id, google_calendar_event_id);
      CREATE INDEX IF NOT EXISTS idx_employees_salon ON employees(salon_id);
      CREATE INDEX IF NOT EXISTS idx_services_salon ON services(salon_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_salon ON invoices(salon_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_salon ON conversations(salon_id);
      -- Salón por defecto para los datos heredados de la base de limpieza.
      INSERT INTO salons (name, slug) SELECT 'Salón Principal', 'principal'
        WHERE NOT EXISTS (SELECT 1 FROM salons);
      UPDATE employees SET salon_id = (SELECT MIN(id) FROM salons) WHERE salon_id IS NULL AND role <> 'superadmin';
      UPDATE services SET salon_id = (SELECT MIN(id) FROM salons) WHERE salon_id IS NULL;
      UPDATE leads SET salon_id = (SELECT MIN(id) FROM salons) WHERE salon_id IS NULL;
      UPDATE clients SET salon_id = (SELECT MIN(id) FROM salons) WHERE salon_id IS NULL;
      UPDATE conversations SET salon_id = (SELECT MIN(id) FROM salons) WHERE salon_id IS NULL;
      UPDATE invoices SET salon_id = (SELECT MIN(id) FROM salons) WHERE salon_id IS NULL;
      UPDATE client_reminders SET salon_id = (SELECT MIN(id) FROM salons) WHERE salon_id IS NULL;
      -- La BASE DE DATOS rechaza el cruce (mejora 3): mismo salón, mismo
      -- profesional (o grupo de 4 manos), mismo día, horarios que se
      -- solapan contando el tiempo de limpieza. El grupo de 4 manos
      -- (mismo group_id) no se cruza consigo mismo.
      CREATE OR REPLACE FUNCTION salon_appointment_no_overlap() RETURNS trigger AS $trig$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM appointments a
          WHERE a.salon_id = NEW.salon_id AND a.id IS DISTINCT FROM NEW.id
            AND a.group_id IS DISTINCT FROM NEW.group_id
            AND a.date = NEW.date AND a.status NOT IN ('cancelada', 'no-show')
            AND a.professional_ids && NEW.professional_ids
            AND (a.start_time, a.end_time + make_interval(mins => COALESCE(a.cleanup_minutes, 0)))
              OVERLAPS (NEW.start_time, NEW.end_time + make_interval(mins => COALESCE(NEW.cleanup_minutes, 0)))
        ) THEN
          RAISE EXCEPTION 'Cruce de agenda: ese profesional ya tiene una cita en ese horario';
        END IF;
        RETURN NEW;
      END;
      $trig$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_appt_no_overlap ON appointments;
      CREATE TRIGGER trg_appt_no_overlap BEFORE INSERT OR UPDATE ON appointments
        FOR EACH ROW EXECUTE FUNCTION salon_appointment_no_overlap();
    `);
    // v1.3 (CRM v5.3.29 H-A2): nombres de profesional únicos por salón.
    // Los duplicados viejos se renombran a 'Nombre (2)', 'Nombre (3)'...
    // y se crea el índice único parcial (solo profesionales activos: un
    // nombre dado de baja no bloquea a uno nuevo con el mismo nombre).
    try {
      const dups = await client.query(`
        SELECT salon_id, LOWER(TRIM(name)) AS n, array_agg(id ORDER BY id) AS ids, array_agg(name ORDER BY id) AS names
        FROM employees WHERE salon_id IS NOT NULL AND active = true AND role IN ('estilista','manicurista','operator')
        GROUP BY salon_id, LOWER(TRIM(name)) HAVING COUNT(*) > 1`);
      for (const g of dups.rows) {
        const ids = g.ids.slice(1);
        for (let i = 0; i < ids.length; i++) {
          await client.query('UPDATE employees SET name = $1 WHERE id = $2', [`${g.names[0]} (${i + 2})`, ids[i]]);
        }
      }
      if (dups.rows.length) {
        await recordEvent('warn', 'staff', `Deduplicación de profesionales (H-A2): ${dups.rows.length} nombre(s) duplicado(s) renombrados con (2), (3)...`, {});
      }
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_salon_name_unique ON employees (salon_id, LOWER(TRIM(name))) WHERE active = true AND role IN ('estilista','manicurista','operator')`);
    } catch (e) { logger.warn('No se pudo aplicar la deduplicación de profesionales (H-A2)', e); }
    eventsTableReady = true;
    await flushEventBuffer();

    // INICIALIZAR ESCALAFONES BASADOS EN CONTRATOS (Si están vacíos)
    const tierCheck = await client.query('SELECT COUNT(*) FROM commission_tiers');
    if (parseInt(tierCheck.rows[0].count) === 0) {
      // Tiers Asesores
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 0, 10000000, 3)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 10000001, 20000000, 3.5)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 20000001, 30000000, 4)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 30000001, 40000000, 4.5)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('advisor', 40000001, 999999999, 5)");
      
      // Tiers Directores
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 0, 20000000, 2)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 20000001, 50000000, 3)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 50000001, 80000000, 3.5)");
      await client.query("INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ('sales_agent', 80000001, 999999999, 4)");
    }

    // v5.2 Unificación de roles a minúscula: las instalaciones viejas
    // guardaban 'Admin'/'Advisor'/'Sales_Agent' en employees y
    // commission_tiers. Se normalizan las filas existentes (sin borrar
    // usuarios); los nuevos registros ya se guardan en minúscula.
    try {
      await client.query("UPDATE employees SET role = LOWER(role) WHERE role IS NOT NULL AND role <> LOWER(role)");
      await client.query("UPDATE commission_tiers SET role = LOWER(role) WHERE role IS NOT NULL AND role <> LOWER(role)");
    } catch (e) { logger.warn('No se pudo normalizar roles existentes a minúscula', e); }
    // Admin inicial SOLO si ADMIN_EMAIL y ADMIN_PASSWORD están definidos en el
    // entorno. Sin ellos NO se crea ningún usuario (antes se creaba un admin
    // con una clave débil por defecto; eso se eliminó).
    const employeeCount = await client.query('SELECT COUNT(*) FROM employees');
    if (parseInt(employeeCount.rows[0].count) === 0) {
      // SalonOS v1: el primer usuario es el SUPERADMIN de la plataforma
      // (sin salón). Con él se crean los salones y luego, con el token de
      // salón, el admin de cada salón. SUPERADMIN_EMAIL tiene prioridad;
      // ADMIN_EMAIL se acepta por compatibilidad con v5.2.
      const adminEmail = ((process.env.SUPERADMIN_EMAIL || process.env.ADMIN_EMAIL) || '').trim();
      const adminPassword = process.env.SUPERADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
      // v1.3 (CRM v5.3.29 H-A5): sin clave por defecto y sin clave débil: el
      // servidor NO arranca con una clave de admin conocida (antes se
      // creaba el admin con clave por defecto si no había .env).
      if (adminEmail && adminPassword && (adminPassword === 'cambia-esta-clave' || adminPassword.length < 12)) {
        throw new Error('SUPERADMIN_PASSWORD/ADMIN_PASSWORD debe tener al menos 12 caracteres y no puede ser "cambia-esta-clave"');
      }
      if (adminEmail && adminPassword) {
        const hashedPw = await bcrypt.hash(adminPassword, 10);
        await client.query(
          'INSERT INTO employees (name, email, password, role, phone, active, salon_id) VALUES ($1, $2, $3, $4, $5, $6, NULL)',
          ['Superadmin de plataforma', adminEmail, hashedPw, 'superadmin', '0000000000', true]
        );
        logger.info(`Superadmin inicial creado: ${adminEmail} (cambia la contraseña tras entrar)`);
      } else {
        logger.warn('Sin empleados y sin ADMIN_EMAIL/ADMIN_PASSWORD: no se creó admin inicial');
      }
    }
    
    await client.query("INSERT INTO settings (key, value) VALUES ('daily_capacity', '15') ON CONFLICT DO NOTHING");
    // v5 Facturación: consecutivo de facturas. Empieza en 1 -> FAC-0001.
    // v5.1 Tipo de factura por defecto: 'normal' (factura de venta sin DIAN).
    await client.query("INSERT INTO settings (key, value) VALUES ('invoice_default_type', 'normal') ON CONFLICT DO NOTHING");

    // --- OPTIMIZACIÓN: ÍNDICES PARA VELOCIDAD ---
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_services_client_phone ON services(client_phone);
      CREATE INDEX IF NOT EXISTS idx_services_date ON services(date);
      CREATE INDEX IF NOT EXISTS idx_services_advisor ON services(advisor);
      CREATE INDEX IF NOT EXISTS idx_leads_client_phone ON leads(client_phone);
      CREATE INDEX IF NOT EXISTS idx_leads_advisor ON leads(advisor);
      CREATE INDEX IF NOT EXISTS idx_conversations_client_phone ON conversations(client_phone);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
      -- v5 Parte 2B: canal por conversación ('qr' | 'meta'). Las bases
      -- creadas antes de la v5 Parte 2B no tienen la columna: se añade aquí.
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel VARCHAR(10) DEFAULT 'qr';
    `);
    dbOk = true;
  } catch (err) { console.error('DB Init Error:', err); } finally { if (client) client.release(); }
};
initDB();

// Endpoints Escalafones
// --- ENDPOINTS DE WHATSAPP ---

app.get('/api/wa/instances', async (req, res) => {
  const sid = salonIdNum(req);
  const isSuper = (req.user?.role || '').toLowerCase() === 'superadmin';
  if (!sid && !isSuper) return res.status(403).json({ error: 'Sin contexto de salón' });
  const instances = Object.keys(waClients)
    .filter((id) => isSuper || waClients[id].salonId === sid)
    .map(id => ({
      id,
      name: waClients[id].name,
      status: waClients[id].status,
      channel: waClients[id].channel || 'qr',
      salonId: waClients[id].salonId || null,
      hasQr: !!waClients[id].qr
    }));
  // Instancias guardadas en DB que aún no están en memoria (p. ej. tras
  // reiniciar, antes de que termine de arrancar el cliente QR).
  if (dbOk) {
    try {
      const dbRows = await pool.query('SELECT id, name, channel, salon_id FROM wa_instances ORDER BY id');
      for (const row of dbRows.rows) {
        if (isSuper || row.salon_id === sid) {
          if (!instances.some((x) => x.id === row.id)) instances.push({ id: row.id, name: row.name, status: 'disconnected', channel: row.channel || 'qr', salonId: row.salon_id, hasQr: false });
        }
      }
    } catch { /* solo memoria */ }
  }
  res.json(instances);
});

// Estado de Meta Cloud API (JWT; el token NUNCA sale del servidor, solo
// booleanos: configurado o no, y el phone number id, que no es secreto).
app.get('/api/wa/meta/status', async (req, res) => {
  try {
    const meta = await getMetaConfig(salonIdNum(req));
    // v1.3 (lección CRM en vivo): 'configurado' no es 'vivo'. Si hay token
    // y phone number id, se comprueba de verdad contra Graph API: solo
    // live:true significa que Meta responde con esas credenciales.
    let live = null, liveError = null, verifiedName = null;
    if (meta.configured) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch(`https://graph.facebook.com/v19.0/${meta.phoneNumberId}?fields=verified_name,display_phone_number`, { headers: { Authorization: `Bearer ${meta.token}` }, signal: ctrl.signal });
        clearTimeout(timer);
        const d = await r.json().catch(() => ({}));
        if (r.ok) { live = true; verifiedName = d.verified_name || null; }
        else { live = false; liveError = d?.error?.message || `Meta respondió ${r.status}`; }
      } catch (e) { live = false; liveError = e.message; }
    }
    res.json({
      configured: meta.configured,
      hasToken: Boolean(meta.token),
      tokenSource: meta.tokenSource,
      phoneNumberId: meta.phoneNumberId || null,
      verifyTokenConfigured: meta.verifyTokenConfigured,
      appSecretConfigured: meta.appSecretConfigured,
      live, liveError, verifiedName,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wa/instances', async (req, res) => {
  const { id, name, channel } = req.body;
  if (!id) return res.status(400).json({ error: 'ID requerido' });
  const sid = salonIdNum(req);
  if (!sid) return res.status(403).json({ error: 'La instancia de WhatsApp pertenece a un salón: entra con un token de salón' });
  if (waClients[id] && waClients[id].salonId !== sid) return res.status(403).json({ error: 'Esa instancia pertenece a otro salón' });

  // Canal: el del body, o el guardado antes en settings (wa_channel_<id>),
  // o 'qr' por defecto. Se guarda para que sobreviva a reinicios.
  let wanted = channel === 'meta' || channel === 'qr' ? channel : null;
  if (!wanted && dbOk) {
    try { wanted = (await getSettingValue(`wa_channel_${id}`, '')) || null; } catch { /* sin settings aún */ }
  }
  wanted = wanted === 'meta' ? 'meta' : 'qr';
  if (dbOk) {
    try { await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`wa_channel_${id}`, wanted]); } catch { /* solo memoria */ }
  }

  if (dbOk) { try { await pool.query('INSERT INTO wa_instances (id, salon_id, name, channel) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET salon_id=EXCLUDED.salon_id, name=EXCLUDED.name, channel=EXCLUDED.channel', [id, sid, name || id, wanted]); } catch { /* solo memoria */ } }
  await initWhatsApp(id, name || id, wanted, sid);
  res.json({ success: true, message: wanted === 'meta' ? 'Instancia Meta registrada (sin QR)' : 'Instancia inicializándose', channel: wanted });
});

// Cambiar el canal de una instancia (QR <-> Meta). Re-inicializa la
// instancia: al pasar a Meta se destruye el cliente de WhatsApp Web; al
// volver a QR se genera un QR nuevo para escanear.
app.patch('/api/wa/instances/:id/channel', async (req, res) => {
  const { id } = req.params;
  const { channel } = req.body || {};
  if (channel !== 'qr' && channel !== 'meta') return res.status(400).json({ error: "channel debe ser 'qr' o 'meta'" });
  const inst = waClients[id];
  if (!inst) return res.status(404).json({ error: 'Instancia no encontrada' });
  if (inst.salonId != null && inst.salonId !== salonIdNum(req)) return res.status(403).json({ error: 'Esa instancia pertenece a otro salón' });
  if ((inst.channel || 'qr') === channel) return res.json({ success: true, channel, message: 'La instancia ya usaba ese canal' });
  const name = inst.name || id;
  try {
    if (inst.client) { try { await inst.client.destroy(); } catch { /* ya estaba muerto */ } }
    delete waClients[id];
    if (dbOk) {
      try { await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`wa_channel_${id}`, channel]); } catch { /* solo memoria */ }
    }
    await initWhatsApp(id, name, channel, inst.salonId || null);
    if (dbOk) { try { await pool.query('UPDATE wa_instances SET channel=$1 WHERE id=$2', [channel, id]); } catch { /* noop */ } }
    recordEvent('info', 'whatsapp', `Canal de ${name} cambiado a ${channel === 'meta' ? 'Meta Cloud API' : 'QR'}`, { instance: id, channel });
    res.json({ success: true, channel });
  } catch (e) {
    recordEvent('error', 'whatsapp', `No se pudo cambiar el canal de ${name}: ${e.message}`, { instance: id });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/wa/qr/:id', (req, res) => {
  const instance = waClients[req.params.id];
  if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });
  const sid = salonIdNum(req);
  if (instance.salonId != null && instance.salonId !== sid) return res.status(403).json({ error: 'Esa instancia pertenece a otro salón' });
  if ((instance.channel || 'qr') === 'meta') return res.status(400).json({ error: 'Esta instancia usa Meta Cloud API y no tiene QR' });
  res.json({ qr: instance.qr, status: instance.status });
});

app.delete('/api/wa/instances/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (waClients[id] && waClients[id].salonId != null && waClients[id].salonId !== salonIdNum(req)) return res.status(403).json({ error: 'Esa instancia pertenece a otro salón' });
  if (waClients[id]) {
    try {
      if (waClients[id].client) {
        try { await waClients[id].client.logout(); } catch { /* sin sesión que cerrar */ }
        await waClients[id].client.destroy();
      }
      delete waClients[id];
      if (dbOk) {
        try { await pool.query('DELETE FROM settings WHERE key = $1', [`wa_channel_${id}`]); } catch { /* noop */ }
        try { await pool.query('DELETE FROM wa_instances WHERE id = $1', [id]); } catch { /* noop */ }
      }
      res.json({ success: true });
    } catch (e) {
      delete waClients[id];
      res.json({ success: true, warning: 'Error al cerrar sesión, pero instancia removida' });
    }
  } else {
    res.status(404).json({ error: 'No encontrada' });
  }
});

// POST /api/wa/send eliminado en v4: ningún componente lo llamaba; el envío
// desde el inbox va por POST /api/chats/:id/messages (que además guarda el
// mensaje y lo manda por la instancia de WhatsApp por QR o por Meta, según
// el canal de la conversación).

// --- FIN ENDPOINTS WHATSAPP ---

// ---------- WEBHOOK WHATSAPP META CLOUD API v5 Parte 2B ----------
// GET: verificación del webhook (lo llama Meta al guardar la URL).
// Sin META_WA_VERIFY_TOKEN configurado, o si el token no coincide, 403.
// POST: mensajes entrantes. Si META_WA_APP_SECRET está configurado, se
// verifica X-Hub-Signature-256 (HMAC SHA256 del body crudo, guardado en
// req.rawBody antes de que express.json lo parseara); si no coincide, 401.
// Sin secreto, se acepta y se registra un aviso en system_events (una vez
// por arranque, para no llenar la tabla con un evento por mensaje).
let metaNoSecretWarned = false;

// v1.3: descarga best-effort de la media de Meta (Graph API). Si falla,
// devuelve null y el llamador guarda el mensaje con etiqueta (nunca se
// descarta). El archivo queda en /uploads/wa-media (protegido con sesión).
async function downloadMetaMedia(mediaId, salonId) {
  try {
    const meta = await getMetaConfig(salonId);
    if (!meta.configured) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const infoRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, { headers: { Authorization: `Bearer ${meta.token}` }, signal: ctrl.signal });
    const info = await infoRes.json().catch(() => ({}));
    if (!infoRes.ok || !info.url) { clearTimeout(timer); return null; }
    const fileRes = await fetch(info.url, { headers: { Authorization: `Bearer ${meta.token}` }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!fileRes.ok) return null;
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const mime = (info.mime_type || fileRes.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'application/pdf': 'pdf' };
    const ext = extMap[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
    fs.mkdirSync(waMediaDir(), { recursive: true });
    const fname = `${mediaId}.${ext}`;
    fs.writeFileSync(path.join(waMediaDir(), fname), buf);
    return `/uploads/wa-media/${fname}`;
  } catch { return null; }
}

app.get('/api/webhooks/meta', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const meta = await getMetaConfig();
  if (mode === 'subscribe' && token && meta.verifyToken && token === meta.verifyToken) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.status(403).json({ error: 'Verificación de webhook Meta fallida: verify token no coincide o META_WA_VERIFY_TOKEN no está configurado' });
});

app.post('/api/webhooks/meta', async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const meta = await getMetaConfig();
    if (meta.appSecret) {
      const sig = req.headers['x-hub-signature-256'] || '';
      const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const expected = `sha256=${crypto.createHmac('sha256', meta.appSecret).update(raw).digest('hex')}`;
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) {
        await recordEvent('warn', 'whatsapp', 'Webhook Meta rechazado: firma X-Hub-Signature-256 inválida', {});
        return res.status(401).json({ error: 'Firma de webhook inválida' });
      }
    } else if (!metaNoSecretWarned) {
      metaNoSecretWarned = true;
      await recordEvent('warn', 'whatsapp', 'Webhook Meta sin META_WA_APP_SECRET: la firma no se verificó (evento aceptado). Configura el secreto en .env para verificar que los eventos vienen de Meta.', {});
    }

    // v1.3 (lección CRM en vivo): la media ya no se ignora. El texto se
    // guarda como antes; la imagen/audio/video/documento se descarga a
    // /uploads/wa-media y, si la descarga falla, se guarda con etiqueta
    // en vez de descartarse (antes el mensaje se perdía en silencio).
    let received = 0;
    let stored = 0;
    // Resolver el salón por el phone_number_id del webhook (cada salón
    // guarda el suyo en settings salon_<id>_meta_wa_phone_number_id).
    let webhookSalonId = null;
    try {
      const firstChange = req.body?.entry?.[0]?.changes?.[0]?.value || {};
      const pnid = firstChange?.metadata?.phone_number_id;
      if (pnid) {
        const hit = await pool.query("SELECT key FROM settings WHERE key LIKE 'salon\_%\_meta_wa_phone_number_id' AND value = $1", [String(pnid)]);
        if (hit.rows[0]) webhookSalonId = Number(hit.rows[0].key.split('_')[1]) || null;
      }
    } catch { /* sin salón: se guarda como antes */ }
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const msg of value.messages || []) {
          received++;
          // v1.3: el evento crudo se registra ANTES de filtrar (remitente,
          // tipo, media, ids; nunca el contenido: H-A3).
          logger.info('Webhook Meta: mensaje crudo', { from: msg.from, type: msg.type, id: msg.id, hasMedia: ['image', 'audio', 'video', 'document', 'sticker'].includes(msg.type) });
          const dup = await pool.query('SELECT 1 FROM messages WHERE external_id = $1', [msg.id]);
          if (dup.rows.length > 0) continue;
          const senderName = (value.contacts || []).find((c) => c.wa_id === msg.from)?.profile?.name || null;
          if (msg.type === 'text' && msg.text?.body) {
            const convId = await handleIncomingWhatsApp({
              phone: msg.from,
              content: msg.text.body,
              sourceName: 'WhatsApp Meta',
              channel: 'meta',
              externalId: msg.id || null,
              senderName,
              salonId: webhookSalonId,
            });
            if (convId) stored++;
            // Bot de reservas v1.1: mismo motor que el QR.
            if (botEngine) {
              await botEngine.handleMessage({ salonId: webhookSalonId, phone: msg.from, content: msg.text.body, channel: 'meta', instanceId: null }).catch((e) => logger.error('Error del bot de reservas (Meta)', e));
            }
            continue;
          }
          if (['image', 'audio', 'video', 'document', 'sticker'].includes(msg.type)) {
            const mediaId = msg[msg.type]?.id || null;
            let attachmentUrl = null;
            if (mediaId) attachmentUrl = await downloadMetaMedia(mediaId, webhookSalonId);
            const label = { image: '📷 Imagen', audio: '🎤 Nota de voz', video: '🎬 Video', document: '📎 Documento', sticker: '😀 Sticker' }[msg.type];
            const convId = await handleIncomingWhatsApp({
              phone: msg.from,
              content: attachmentUrl ? `${label} recibida` : `${label} recibida (no se pudo descargar el archivo)`,
              type: msg.type === 'sticker' ? 'image' : msg.type,
              attachmentUrl,
              sourceName: 'WhatsApp Meta',
              channel: 'meta',
              externalId: msg.id || null,
              senderName,
              salonId: webhookSalonId,
            });
            if (convId) stored++;
          }
        }
      }
    }
    res.json({ ok: true, received, stored });
  } catch (err) {
    logger.error('Error procesando webhook Meta', err);
    res.status(500).json({ error: err.message });
  }
});

// v5 Parte 2C: los escalafones solo los ve y los toca el admin. El
// Dashboard ya no los lee (usa /api/stats/commissions) y la pestaña
// "CommissionTiers" de Equipo solo existe para admin.
app.get('/api/commission-tiers', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM commission_tiers ORDER BY role, min_value ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/commission-tiers', requireAdmin, async (req, res) => {
  const { min_value, max_value, percentage } = req.body;
  const role = normalizeRoleValue(req.body?.role);
  if (!role || !['advisor', 'sales_agent'].includes(role)) return res.status(400).json({ error: "role debe ser 'advisor' o 'sales_agent'" });
  try {
    await pool.query('INSERT INTO commission_tiers (role, min_value, max_value, percentage) VALUES ($1, $2, $3, $4)', [role, min_value, max_value, percentage]);
    await recordEvent('info', 'staff', `Escalafón creado: ${role} ${min_value}-${max_value} al ${percentage}%`, { role, min_value, max_value, percentage });
    notifyUpdate('settings');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/commission-tiers/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM commission_tiers WHERE id = $1', [req.params.id]);
    await recordEvent('warn', 'staff', `Escalafón ${req.params.id} eliminado por ${req.user?.email || 'admin'}`, { tier_id: req.params.id });
    notifyUpdate('settings');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Socket autenticado: el cliente envía el JWT en handshake.auth.token o en
// la cookie HttpOnly (el navegador la manda sola al conectar). Sin token
// válido no hay conexión en tiempo real. v1.3: también se respeta la
// revocación (token_version) cuando hay DB.
io.use(async (socket, next) => {
  const cookieToken = parseCookies({ headers: { cookie: socket.handshake.headers?.cookie || '' } })[AUTH_COOKIE] || null;
  const token = cookieToken || socket.handshake.auth?.token;
  if (!token) return next(new Error('No autorizado: falta token'));
  let decoded;
  try { decoded = jwt.verify(token, jwtSecret); }
  catch (e) { return next(new Error('No autorizado: token inválido')); }
  socket.user = decoded;
  if (dbUrl) {
    try {
      const r = await pool.query('SELECT active, token_version FROM employees WHERE id = $1', [employeeBaseId(decoded)]);
      if (!r.rows[0] || !r.rows[0].active) return next(new Error('No autorizado: cuenta desactivada'));
      if ((r.rows[0].token_version ?? 0) !== (decoded.tv ?? 0)) return next(new Error('No autorizado: sesión revocada'));
    } catch (e) {
      return next(new Error('No autorizado: base de datos no disponible'));
    }
  }
  next();
});

io.on('connection', (socket) => {
  // MODIFICACIÓN: Identificación avanzada con Rol
  // La identidad viene del JWT verificado en el handshake (socket.user),
  // no de lo que el cliente diga.
  socket.on('identify', () => {
    const id = socket.user?.id;
    const role = socket.user?.role;
    if (id) {
      const room = id.toString();
      socket.join(room);
      
      // Si el usuario es administrador o superadmin, se une a la sala global
      // de admins (AUDITORÍA v1.1: el superadmin no entraba y no recibía
      // las actualizaciones en vivo del panel de salones).
      if ((role || '').toLowerCase() === 'admin' || (role || '').toLowerCase() === 'superadmin') {
        socket.join('global_admin');
        logger.info(`Admin [${socket.id}] unido a Sala Global: global_admin`);
      }
      
      logger.info(`Socket [${socket.id}] unido a Sala Usuario: ${room}`);
    }
  });
});

app.get('/api/notes/:phone', async (req, res) => {
  try {
    const phone = normalizePhoneString(req.params.phone);
    const r = await pool.query('SELECT * FROM client_notes WHERE client_phone = $1', [phone]);
    res.json(r.rows[0] || { client_phone: phone, content: '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notes', async (req, res) => {
  const { phone: rawPhone, content } = req.body;
  const phone = normalizePhoneString(rawPhone);
  try {
    await pool.query('INSERT INTO client_notes (client_phone, content, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (client_phone) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()', [phone, content]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reminders/:phone', async (req, res) => {
  try {
    const phone = normalizePhoneString(req.params.phone);
    const r = await pool.query('SELECT * FROM client_reminders WHERE client_phone = $1 ORDER BY alert_at ASC', [phone]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/active-reminders', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM client_reminders WHERE is_processed = false AND alert_at <= NOW() + INTERVAL \'1 minute\'');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reminders', async (req, res) => {
  const { phone: rawPhone, name, title, alertAt, createdBy } = req.body;
  const phone = normalizePhoneString(rawPhone);
  try {
    const r = await pool.query('INSERT INTO client_reminders (client_phone, client_name, title, alert_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [phone, name, title, alertAt, createdBy]);
    const creator = await pool.query("SELECT id FROM employees WHERE name = $1", [createdBy]);
    notifyUpdate('reminder', creator.rows.map(u => u.id));
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reminders/:id/complete', async (req, res) => {
  try {
    await pool.query('UPDATE client_reminders SET is_processed = true WHERE id = $1', [req.params.id]);
    notifyUpdate('reminder');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reminders/:id', requireAdmin, async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const chk = await pool.query('DELETE FROM client_reminders WHERE id = $1 AND salon_id = $2 RETURNING id', [req.params.id, _sid]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'Recordatorio no encontrado en este salón' });
    notifyUpdate('reminder');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/availability', async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const r = await pool.query(`
      SELECT
        date::text,
        COUNT(*) FILTER (WHERE time < '13:00' AND deal_status NOT IN ('CANCELADO')) as am_count,
        COUNT(*) FILTER (WHERE time >= '13:00' AND deal_status NOT IN ('CANCELADO')) as pm_count
      FROM services
      WHERE salon_id = $1 AND date >= CURRENT_DATE
      AND date <= CURRENT_DATE + INTERVAL '14 days'
      GROUP BY date
      ORDER BY date ASC
    `, [_sid]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats/:id/messages', waSendLimiter, async (req, res) => {
  const { id } = req.params;
  // v5.2 Solo lectura para el operador (B5): puede leer los mensajes de
  // sus servicios, pero no enviar.
  if (['operator', 'estilista', 'manicurista'].includes(normalizeRoleValue(req.user?.role))) {
    return res.status(403).json({ error: 'Solo lectura: las profesionales no pueden enviar mensajes' });
  }
  const _convSalon = await pool.query('SELECT salon_id FROM conversations WHERE id = $1', [id]);
  if (!_convSalon.rows[0] || Number(_convSalon.rows[0].salon_id) !== salonIdNum(req)) return res.status(403).json({ error: 'Esa conversación pertenece a otro salón' });
  const { content, type, attachmentUrl } = req.body;
  try {
    // v1.3 (lección CRM en vivo): antes de reintentar un envío, verifica
    // si ese mismo mensaje ya salió en los últimos 5 min (mismo remitente
    // 'agent', mismo contenido, estado 'enviado'): si ya salió, no se
    // manda dos veces. Los mensajes propios se identifican por sender.
    if (content) {
      const dup = await pool.query("SELECT id FROM messages WHERE conversation_id = $1 AND sender = 'agent' AND content = $2 AND status = 'enviado' AND timestamp >= NOW() - INTERVAL '5 minutes' ORDER BY id DESC LIMIT 1", [id, content]);
      if (dup.rows[0]) return res.json({ success: true, sent: true, duplicate: true, messageId: dup.rows[0].id.toString(), lastMessageId: dup.rows[0].id.toString() });
    }
    // 1. Guardar mensaje localmente (estado 'enviando': un envío sin
    // confirmación es 'sin confirmar', no 'enviado').
    const ins = await pool.query(
      "INSERT INTO messages (conversation_id, sender, type, content, attachment_url, timestamp, status) VALUES ($1, $2, $3, $4, $5, NOW(), 'enviando') RETURNING id",
      [id, 'agent', type || 'text', content || '', attachmentUrl || null]
    );
    const msgId = ins.rows[0].id;
    let sentOk = null; // null = nada que enviar (solo adjunto guardado)

    let lastMsgPreview = content;
    if (!lastMsgPreview) {
      if (type === 'image') lastMsgPreview = '📷 Imagen';
      else if (type === 'audio') lastMsgPreview = '🎤 Nota de voz';
      else lastMsgPreview = '📎 Archivo';
    }

    // 2. Actualizar conversación
    await pool.query(`UPDATE conversations SET last_message = $1, last_message_time = NOW(), unread_count = 0 WHERE id = $2`, [lastMsgPreview, id]);

    // 3. Enviar a WhatsApp: por Meta Cloud API si la conversación es Meta,
    // por QR si es QR. El teléfono se normaliza dentro de
    // sendWhatsAppMessage; si el envío falla, el mensaje queda guardado y
    // el fallo queda en system_events (antes solo se registraba si no había
    // ninguna instancia lista; un error de envío se perdía en silencio).
    const convRes = await pool.query('SELECT client_phone, channel, source FROM conversations WHERE id = $1', [id]);
    if (convRes.rows.length > 0 && convRes.rows[0].client_phone) {
      const phone = convRes.rows[0].client_phone;
      let channel = convRes.rows[0].channel || 'qr';
      // Legado: conversaciones creadas antes de la v5 Parte 2B no tienen
      // channel; si su fuente nombra una instancia Meta, salen por Meta.
      if (!convRes.rows[0].channel) {
        const metaInst = Object.values(waClients).find((w) => w.channel === 'meta' && convRes.rows[0].source && convRes.rows[0].source.includes(w.name));
        if (metaInst) channel = 'meta';
      }
      if (content) {
        const result = await sendWhatsAppMessage({ phone, content, channel, salonId: salonIdNum(req) });
        sentOk = result.ok;
        if (!result.ok) {
          logger.error('Error enviando mensaje via WA', result.error);
          recordEvent('error', 'whatsapp', `No se pudo enviar el mensaje del chat a ${phone} (${channel}): ${result.error}`, { conversation: id, channel });
        }
      }
    }

    // v1.3: el estado del mensaje refleja la confirmación real de WhatsApp.
    const finalStatus = sentOk === false ? 'sin_confirmar' : 'enviado';
    await pool.query('UPDATE messages SET status = $1 WHERE id = $2', [finalStatus, msgId]);

    const advisorRes = await pool.query("SELECT e.id FROM employees e JOIN leads l ON e.name = l.advisor WHERE l.conversation_id = $1", [id]);
    notifyUpdate('chat', advisorRes.rows.map(r => r.id));
    res.json({ success: true, sent: sentOk !== false, status: finalStatus, messageId: msgId.toString(), lastMessageId: msgId.toString() });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/ranking', async (req, res) => {
  const { timeRange = 'month' } = req.query;
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    let whereClauses = ["deal_status IN ('REALIZADO', 'PAGADO')", `salon_id = ${_sid}`];
    if (timeRange === 'today') whereClauses.push("date = CURRENT_DATE");
    else if (timeRange === 'week') whereClauses.push("date >= CURRENT_DATE - INTERVAL '7 days'");
    else if (timeRange === 'month') whereClauses.push("EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)");

    const query = `
      SELECT 
        advisor as name, 
        SUM(total_value) as total, 
        COUNT(*) as count,
        SUM(CASE WHEN deal_status = 'PAGADO' THEN total_value ELSE 0 END) as paid_total
      FROM services 
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY advisor 
      ORDER BY total DESC
    `;
    const r = await pool.query(query);
    // v5.2 Alcance por rol (JWT): el asesor ve solo su fila, el líder la
    // suya y la de su red, el operador no ve el ranking de ventas.
    const scope = await getRoleScope(req);
    let rows = r.rows;
    if (scope.role === 'advisor') rows = rows.filter((x) => x.name === scope.userName);
    else if (scope.role === 'sales_agent') rows = rows.filter((x) => (scope.names || []).includes(x.name));
    // AUDITORÍA v1.1: estilista/manicurista veían el ranking completo.
    else if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') rows = [];
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard-stats', async (req, res) => {
  const { timeRange = 'month' } = req.query;
  try {
    let whereClauses = ["deal_status NOT IN ('CANCELADO')"];
    let params = [];
    
    // Filtro de tiempo
    if (timeRange === 'today') {
      whereClauses.push("date = CURRENT_DATE");
    } else if (timeRange === 'week') {
      whereClauses.push("date >= CURRENT_DATE - INTERVAL '7 days'");
    } else if (timeRange === 'month') {
      whereClauses.push("EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)");
    }

    // Filtro de rol v5.2: el alcance sale del JWT verificado (getRoleScope),
    // no de la query. Antes el frontend mandaba ?role=...&userName=... y el
    // servidor confiaba: cualquiera podía pedirse otro rol o usuario.
    const scope = await getRoleScope(req);
    // AUDITORÍA v1.1: con salon_id = null la consulta devolvía ceros en
    // silencio. El superadmin ve el total de todos los salones; los demás
    // sin contexto de salón reciben 403.
    const _sid2 = salonIdNum(req);
    if (!_sid2 && scope.role !== 'superadmin') return res.status(403).json({ error: 'Sin contexto de salón' });
    if (_sid2) whereClauses.push(`salon_id = ${_sid2}`);
    if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') {
      params.push(scope.userName);
      whereClauses.push(`$${params.length} = ANY(operators)`);
      whereClauses.push("deal_status NOT IN ('AGENDADO', 'REAGENDADO')");
    } else if (scope.role !== 'admin' && scope.role !== 'recepcionista' && scope.role !== 'superadmin') {
      params.push(scope.names);
      whereClauses.push(`advisor = ANY($${params.length})`);
    }

    const whereSql = whereClauses.length > 0 ? " WHERE " + whereClauses.join(" AND ") : "";

    const statsQuery = `
      SELECT 
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) as "grossIncome",
        COALESCE(SUM(expenses) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) as "totalExpenses",
        COALESCE(SUM(operator_payment) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) as "totalOperatorPayments",
        COUNT(*) as "totalServices",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'AGENDADO'), 0) as "scheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'CONFIRMADO'), 0) as "confirmedValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REAGENDADO'), 0) as "rescheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REALIZADO'), 0) as "doneValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) as "paidValue"
      FROM services
      ${whereSql}
    `;

    const stats = await pool.query(statsQuery, params);
    res.json(stats.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- TOTALES REALES DEL SERVIDOR v5 Parte 2C ----------
// Antes, Dashboard/BusinessDeals/LeadPipeline/AuditModule calculaban
// totales sobre la página de 50 registros que les llegaba (o, peor, el
// Dashboard estimaba las comisiones como una fracción fija de los
// ingresos). Ahora los totales globales salen de SQL con COUNT/SUM sobre
// TODOS los registros, sin LIMIT. Sin JWT -> 401 (authMiddleware).
// v5.2: cada rol ve SOLO sus totales (getRoleScope): el operador nunca
// ve los ingresos totales de la empresa. Ver /api/stats/overview y
// /api/stats/commissions.
//
// Filtro de periodo ?timeRange=today|week|month|all (por defecto all):
// se aplica a services.date y a leads.created_at con la misma
// semántica que /api/dashboard-stats. Los duplicados, el conteo de
// clientes y las facturas son siempre globales (no dependen del periodo).
app.get('/api/stats/overview', async (req, res) => {
  const { timeRange = 'all' } = req.query;
  try {
    // v5.2 Alcance por rol (JWT): antes cualquier usuario logueado veía
    // los totales de TODA la empresa (el hueco que se encontró en la
    // revisión de roles). Ahora: admin ve todo; asesor (vendedor) solo
    // lo suyo; líder de ventas lo suyo + lo de su red; operador solo sus
    // servicios asignados, NUNCA los ingresos totales de la empresa.
    const scope = await getRoleScope(req);
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const svcClauses = [`salon_id = ${_sid}`];
    const leadClauses = [`salon_id = ${_sid}`];
    const svcParams = [];
    const leadParams = [];
    if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') {
      // En servicios, $1 es su nombre (columna operators); en leads, $1
      // son los teléfonos de los clientes de sus servicios asignados.
      svcParams.push(scope.userName);
      svcClauses.push(`$${svcParams.length} = ANY(operators)`);
      const opPhones = await operatorServicePhones(scope.userName);
      if (opPhones.length) { leadParams.push(opPhones); leadClauses.push(`client_phone = ANY($${leadParams.length})`); }
      else leadClauses.push('1 = 0');
    } else if (scope.role !== 'admin' && scope.role !== 'recepcionista' && scope.role !== 'superadmin') {
      svcParams.push(scope.names);
      svcClauses.push(`advisor = ANY($${svcParams.length})`);
      leadParams.push(scope.names);
      leadClauses.push(`advisor = ANY($${leadParams.length})`);
    }
    if (timeRange === 'today') {
      svcClauses.push('date = CURRENT_DATE');
      leadClauses.push('created_at::date = CURRENT_DATE');
    } else if (timeRange === 'week') {
      svcClauses.push("date >= CURRENT_DATE - INTERVAL '7 days'");
      leadClauses.push("created_at >= CURRENT_DATE - INTERVAL '7 days'");
    } else if (timeRange === 'month') {
      svcClauses.push('EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)');
      leadClauses.push('EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)');
    }
    const svcWhere = svcClauses.length ? 'WHERE ' + svcClauses.join(' AND ') : '';
    const leadWhere = leadClauses.length ? 'WHERE ' + leadClauses.join(' AND ') : '';
    const leadWhereAnd = (extra) => (leadClauses.length ? 'WHERE ' + [...leadClauses, extra].join(' AND ') : 'WHERE ' + extra);
    const svcWhereAnd = (extra) => (svcClauses.length ? 'WHERE ' + [...svcClauses, extra].join(' AND ') : 'WHERE ' + extra);
    // Clientes dentro del alcance: para asesor/líder, conversaciones con
    // lead suyo o servicio suyo; para operador, conversaciones de
    // clientes con un servicio asignado a él.
    let clientsSql = `SELECT COUNT(*)::int AS count FROM clients WHERE salon_id = ${_sid}`;
    let clientsParams = [];
    if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') {
      clientsSql = 'SELECT COUNT(*)::int AS count FROM conversations c WHERE EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND $1 = ANY(s2.operators))';
      clientsParams = [scope.userName];
    } else if (scope.role !== 'admin' && scope.role !== 'recepcionista' && scope.role !== 'superadmin') {
      clientsSql = `SELECT COUNT(*)::int AS count FROM conversations c LEFT JOIN leads l ON c.id = l.conversation_id WHERE c.salon_id = ${_sid} AND (l.advisor = ANY($1) OR EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND s2.advisor = ANY($1)))`;
      clientsParams = [scope.names];
    }
    const dupesScope = (scope.role === 'admin' || scope.role === 'recepcionista' || scope.role === 'superadmin') ? '' : (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') ? 'AND $1 = ANY(operators)' : 'AND advisor = ANY($1)';
    // AUDITORÍA v1.1: el asesor/líder veía las facturas de todo el salón.
    const invoicesScope = (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista')
      ? `WHERE salon_id = ${_sid} AND service_id IN (SELECT id FROM services WHERE $1 = ANY(operators))`
      : (scope.role === 'advisor' || scope.role === 'sales_agent')
        ? `WHERE salon_id = ${_sid} AND service_id IN (SELECT id FROM services WHERE advisor = ANY($1))`
        : `WHERE salon_id = ${_sid}`;
    const invoicesParams = (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista')
      ? [scope.userName] : (scope.role === 'advisor' || scope.role === 'sales_agent') ? [scope.names] : [];

    const [rev, byStatus, byStage, leadLoss, svcCancel, clients, dupes, invoices] = await Promise.all([
      pool.query(`SELECT
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS "grossIncome",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'AGENDADO'), 0) AS "scheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'CONFIRMADO'), 0) AS "confirmedValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REAGENDADO'), 0) AS "rescheduledValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'REALIZADO'), 0) AS "doneValue",
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS "paidValue",
        COALESCE(SUM(expenses) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) AS "totalExpenses",
        COALESCE(SUM(operator_payment) FILTER (WHERE deal_status IN ('REALIZADO', 'PAGADO')), 0) AS "totalOperatorPayments",
        COUNT(*)::int AS "totalServices"
        FROM services ${svcWhere}`, svcParams),
      pool.query(`SELECT deal_status AS status, COUNT(*)::int AS count, COALESCE(SUM(total_value), 0) AS "totalValue" FROM services ${svcWhere} GROUP BY deal_status ORDER BY count DESC`, svcParams),
      pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(estimated_value), 0) AS "estimatedValue" FROM leads ${leadWhere} GROUP BY status ORDER BY count DESC`, leadParams),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(lost_reason), ''), 'Sin motivo') AS reason, COUNT(*)::int AS count FROM leads ${leadWhereAnd("status = 'PERDIDO'")} GROUP BY 1 ORDER BY count DESC`, leadParams),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(cancellation_reason), ''), 'Sin motivo') AS reason, COUNT(*)::int AS count FROM services ${svcWhereAnd("deal_status = 'CANCELADO'")} GROUP BY 1 ORDER BY count DESC`, svcParams),
      pool.query(clientsSql, clientsParams),
      // Duplicados en TODA la base (dentro del alcance): mismo teléfono y
      // misma fecha, sin CANCELADO. Antes la Auditoría solo miraba la
      // página de 50.
      pool.query(`SELECT client_phone AS phone, MAX(client_name) AS name, date::text AS date, COUNT(*)::int AS count
        FROM services WHERE client_phone IS NOT NULL AND date IS NOT NULL AND deal_status <> 'CANCELADO' ${dupesScope}
        GROUP BY client_phone, date HAVING COUNT(*) > 1 ORDER BY count DESC, date DESC`, svcParams),
      pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(balance), 0) AS balance FROM invoices ${invoicesScope} GROUP BY status ORDER BY count DESC`, invoicesParams),
    ]);

    const num = (v) => Number(v) || 0;
    const r = rev.rows[0] || {};
    // Motivos de pérdida combinados (leads PERDIDO + servicios CANCELADO).
    const combined = {};
    for (const row of [...leadLoss.rows, ...svcCancel.rows]) {
      combined[row.reason] = (combined[row.reason] || 0) + row.count;
    }
    res.json({
      timeRange,
      // Para que el frontend sepa de quién son estos totales y pueda
      // avisar cuando no son los de toda la empresa.
      scope: { role: scope.role, userName: scope.userName },
      revenue: {
        grossIncome: num(r.grossIncome), scheduledValue: num(r.scheduledValue),
        confirmedValue: num(r.confirmedValue), rescheduledValue: num(r.rescheduledValue),
        doneValue: num(r.doneValue), paidValue: num(r.paidValue),
        totalExpenses: num(r.totalExpenses), totalOperatorPayments: num(r.totalOperatorPayments),
        totalServices: Number(r.totalServices) || 0,
      },
      servicesByStatus: byStatus.rows.map((x) => ({ status: x.status, count: Number(x.count) || 0, totalValue: num(x.totalValue) })),
      leadsByStage: byStage.rows.map((x) => ({ status: x.status, count: Number(x.count) || 0, estimatedValue: num(x.estimatedValue) })),
      leadLossReasons: leadLoss.rows.map((x) => ({ reason: x.reason, count: Number(x.count) || 0 })),
      serviceCancellationReasons: svcCancel.rows.map((x) => ({ reason: x.reason, count: Number(x.count) || 0 })),
      lossReasons: Object.entries(combined).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      clientsCount: Number(clients.rows[0]?.count) || 0,
      duplicates: dupes.rows.map((x) => ({ phone: x.phone, name: x.name, date: x.date, count: Number(x.count) || 0 })),
      invoicesByStatus: invoices.rows.map((x) => ({ status: x.status, count: Number(x.count) || 0, total: num(x.total), balance: num(x.balance) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Comisiones reales por empleado y periodo, con la tabla
// commission_tiers (tramos por rol: advisor y sales_agent). Base del
// tramo: ingresos PAGADOS del periodo (services.total_value con
// deal_status='PAGADO'). Para un sales_agent la base es la de su equipo:
// servicios donde advisor es él o uno de sus subordinados directos
// (employees.parent_id = su id), igual que /api/dashboard-stats. El
// operador no tiene escalafón: su fila trae los números de sus servicios
// asignados (valor de los servicios, no su pago) y percentage/commission
// en null con nota. v5.2: el listado se acota por rol (JWT): el asesor
// solo se ve a sí mismo, el líder a sí mismo y a su red, el operador
// solo a sí mismo; el admin ve a todos.
// ?month=YYYY-MM tiene prioridad; si no, ?timeRange=today|week|month|all;
// por defecto el mes en curso. Si no hay tramo aplicable para el
// ingreso del periodo, percentage y commission salen null con la nota
// "sin tramo": NUNCA se inventa un porcentaje ni se usa el 4% fijo.
// Los tramos de la tabla son datos (3%-5% según el tramo), no una
// estimación: el porcentaje aplicado es siempre el de la tabla.
app.get('/api/stats/commissions', async (req, res) => {
  const { month, timeRange } = req.query;
  try {
    let periodLabel;
    let svcClauses = [];
    if (typeof month === 'string' && month !== '') {
      const m = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
      if (!m) return res.status(400).json({ error: 'month debe ser YYYY-MM' });
      periodLabel = month;
      svcClauses.push(`EXTRACT(YEAR FROM date) = ${Number(m[1])} AND EXTRACT(MONTH FROM date) = ${Number(m[2])}`);
    } else if (timeRange === 'today') {
      periodLabel = 'today';
      svcClauses.push('date = CURRENT_DATE');
    } else if (timeRange === 'week') {
      periodLabel = 'week';
      svcClauses.push("date >= CURRENT_DATE - INTERVAL '7 days'");
    } else if (timeRange === 'all') {
      periodLabel = 'all';
    } else {
      // 'month' o por defecto: mes en curso.
      periodLabel = 'month';
      svcClauses.push('EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM CURRENT_DATE)');
    }
    const svcWhere = svcClauses.length ? 'WHERE ' + svcClauses.join(' AND ') : '';

    // v5.2 Alcance por rol (JWT): qué empleados se ven.
    const scope = await getRoleScope(req);
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    let employeesSql = 'SELECT id, name, role FROM employees WHERE active = true AND salon_id = ' + _sid + ' ORDER BY role, name';
    let employeesParams = [];
    if (scope.role === 'sales_agent') {
      employeesSql = 'SELECT id, name, role FROM employees WHERE active = true AND salon_id = ' + _sid + ' AND (id = $1 OR parent_id = $1) ORDER BY role, name';
      employeesParams = [scope.userId];
    } else if (scope.role !== 'admin' && scope.role !== 'recepcionista' && scope.role !== 'superadmin') {
      employeesSql = 'SELECT id, name, role FROM employees WHERE active = true AND id = $1 ORDER BY role, name';
      employeesParams = [scope.userId];
    }

    const [employees, tiers, revenueByAdvisor] = await Promise.all([
      pool.query(employeesSql, employeesParams),
      pool.query('SELECT role, min_value, max_value, percentage FROM commission_tiers ORDER BY role, min_value ASC'),
      pool.query(`SELECT advisor AS name, COUNT(*)::int AS count,
        COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS paid,
        COALESCE(SUM(total_value) FILTER (WHERE deal_status <> 'CANCELADO'), 0) AS total
        FROM services ${svcWhere ? svcWhere + ' AND salon_id = ' + _sid : 'WHERE salon_id = ' + _sid} GROUP BY advisor`),
    ]);
    const revByName = new Map(revenueByAdvisor.rows.map((x) => [x.name, { count: Number(x.count) || 0, paid: Number(x.paid) || 0, total: Number(x.total) || 0 }]));
    const tiersByRole = new Map();
    for (const t of tiers.rows) {
      const k = (t.role || '').toLowerCase();
      if (!tiersByRole.has(k)) tiersByRole.set(k, []);
      tiersByRole.get(k).push({ min: Number(t.min_value), max: Number(t.max_value), percentage: Number(t.percentage) });
    }

    const commissions = [];
    for (const emp of employees.rows) {
      const roleKey = (emp.role || '').toLowerCase();
      let paid = 0;
      let total = 0;
      let count = 0;
      let note = null;
      if (roleKey === 'sales_agent') {
        const team = await pool.query('SELECT name FROM employees WHERE parent_id = $1', [emp.id]);
        const names = [emp.name, ...team.rows.map((x) => x.name)];
        for (const n of names) {
          const v = revByName.get(n);
          if (v) { paid += v.paid; total += v.total; count += v.count; }
        }
      } else if (roleKey === 'operator') {
        // El operador no vende ni tiene escalafón: sus números salen de
        // sus servicios asignados (valor de los servicios; su pago real
        // es operator_payment, que se ve en el Dashboard).
        const opWhere = svcWhere ? `${svcWhere} AND $1 = ANY(operators)` : 'WHERE $1 = ANY(operators)';
        const op = await pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total_value) FILTER (WHERE deal_status = 'PAGADO'), 0) AS paid, COALESCE(SUM(total_value) FILTER (WHERE deal_status <> 'CANCELADO'), 0) AS total FROM services ${opWhere}`, [emp.name]);
        const rr = op.rows[0] || {};
        count = Number(rr.count) || 0; paid = Number(rr.paid) || 0; total = Number(rr.total) || 0;
        note = 'Operador: sin comisión por escalafón';
      } else {
        const v = revByName.get(emp.name);
        if (v) { paid = v.paid; total = v.total; count = v.count; }
      }
      const roleTiers = tiersByRole.get(roleKey) || [];
      const tier = roleTiers.find((t) => paid >= t.min && paid <= t.max) || null;
      commissions.push({
        employeeId: emp.id.toString(),
        name: emp.name,
        role: roleKey,
        revenue: total,
        paidRevenue: paid,
        totalServices: count,
        percentage: tier ? tier.percentage : null,
        commission: tier ? (paid * tier.percentage) / 100 : null,
        note: note || (tier ? null : 'sin tramo'),
      });
    }
    commissions.sort((a, b) => b.paidRevenue - a.paidRevenue);
    res.json({
      period: periodLabel,
      basis: 'paid',
      scope: { role: scope.role, userName: scope.userName },
      commissions,
      totalCommissions: commissions.reduce((acc, c) => acc + (c.commission || 0), 0),
      totalPaidRevenue: commissions.reduce((acc, c) => acc + c.paidRevenue, 0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cities', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DISTINCT city FROM (
        SELECT city FROM services WHERE city IS NOT NULL
        UNION
        SELECT location as city FROM leads WHERE location IS NOT NULL
      ) as combined_cities ORDER BY city ASC
    `);
    res.json(r.rows.map(row => row.city));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients', async (req, res) => {
  const { page = 1, limit = 50, search = '', city = 'all', type = 'all', spentRange = 'all' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  try {
    let whereClauses = [];
    let params = [];

    if (search) {
      // Nombre/ubicación con el término tal cual; teléfono con todas sus
      // variantes (normalizado, sin + y 10 dígitos), así '3001234567'
      // encuentra filas guardadas como '+573001234567' y viceversa.
      params.push(`%${search}%`);
      const namePh = `$${params.length}`;
      const phoneCond = likeAny(params, 'c.client_phone', phoneSearchPatterns(search));
      whereClauses.push(`(c.client_name ILIKE ${namePh} OR l.location ILIKE ${namePh} OR ${phoneCond})`);
    }

    // v5.2 Alcance por rol (JWT): antes solo el asesor filtraba, y el
    // operador veía todos los clientes. Ahora cada rol ve solo los suyos
    // (el líder, además, los de su red).
    const scope = await getRoleScope(req);
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    whereClauses.push(`c.salon_id = ${_sid}`);
    if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') {
      params.push(scope.userName);
      whereClauses.push(`EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND $${params.length} = ANY(s2.operators))`);
    } else if (scope.role !== 'admin' && scope.role !== 'recepcionista' && scope.role !== 'superadmin') {
      params.push(scope.names);
      whereClauses.push(`(l.advisor = ANY($${params.length}) OR EXISTS (SELECT 1 FROM services s2 WHERE s2.client_phone = c.client_phone AND s2.advisor = ANY($${params.length})))`);
    }

    if (city !== 'all') {
      params.push(city);
      whereClauses.push(`(s_agg.city = $${params.length} OR l.location = $${params.length})`);
    }

    let query = `
      SELECT 
        c.client_phone as "clientPhone", 
        MAX(c.client_name) as "clientName", 
        MAX(COALESCE(l.location, s_agg.neighborhood, '')) as "neighborhood",
        MAX(COALESCE(l.address, s_agg.address, '')) as "address",
        MAX(COALESCE(s_agg.city, 'Bogotá')) as "city",
        COALESCE(s_agg.total_services, 0) as "totalServices",
        COALESCE(s_agg.total_spent, 0) as "totalSpent",
        MAX(COALESCE(s_agg.last_date, c.last_message_time)) as "lastServiceDate",
        MAX(c.source) as "source"
      FROM conversations c
      LEFT JOIN leads l ON c.id = l.conversation_id
      LEFT JOIN (
        SELECT client_phone, COUNT(*) as total_services, SUM(total_value) as total_spent, MAX(date) as last_date, MAX(neighborhood) as neighborhood, MAX(address) as address, MAX(city) as city FROM services GROUP BY client_phone
      ) s_agg ON c.client_phone = s_agg.client_phone
    `;

    if (whereClauses.length > 0) {
      query += ` WHERE ` + whereClauses.join(' AND ');
    }

    query += ` GROUP BY c.client_phone, s_agg.total_services, s_agg.total_spent `;

    // Filtros de agregación (HAVING)
    if (type === 'recurrent') {
      query += ` HAVING COALESCE(s_agg.total_services, 0) > 0 `;
    } else if (type === 'prospect') {
      query += ` HAVING COALESCE(s_agg.total_services, 0) = 0 `;
    }

    if (spentRange !== 'all') {
      if (!query.includes('HAVING')) query += ' HAVING ';
      else query += ' AND ';
      
      if (spentRange === 'low') query += ` COALESCE(s_agg.total_spent, 0) > 0 AND COALESCE(s_agg.total_spent, 0) <= 200000 `;
      if (spentRange === 'mid') query += ` COALESCE(s_agg.total_spent, 0) > 200000 AND COALESCE(s_agg.total_spent, 0) <= 800000 `;
      if (spentRange === 'high') query += ` COALESCE(s_agg.total_spent, 0) > 800000 `;
      if (spentRange === 'zero') query += ` COALESCE(s_agg.total_spent, 0) = 0 `;
    }

    // Paginación
    const countQuery = `SELECT COUNT(*) FROM (${query}) as sub`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    query += ` ORDER BY "lastServiceDate" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);
    
    const r = await pool.query(query, params);
    res.json({
      data: r.rows,
      total,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:phone', requireAdmin, async (req, res) => {
  const { phone: rawPhone } = req.params;
  const _sid = salonIdNum(req);
  if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
  // Borra en todas sus formas (normalizada, sin + y 10 dígitos) para que no
  // queden restos de antes de la normalización (v5 Parte 2B).
  const { phone: norm } = normalizePhoneCO(rawPhone);
  const variants = [...new Set([norm, norm.replace('+', ''), norm.slice(3), rawPhone])].filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM services WHERE client_phone = ANY($1) AND salon_id = $2', [variants, _sid]);
    await client.query('DELETE FROM leads WHERE client_phone = ANY($1) AND salon_id = $2', [variants, _sid]);
    await client.query('DELETE FROM conversations WHERE client_phone = ANY($1) AND salon_id = $2', [variants, _sid]);
    await client.query('DELETE FROM salon_clients WHERE phone = ANY($1) AND salon_id = $2', [variants, _sid]);
    await client.query('DELETE FROM appointments WHERE client_phone = ANY($1) AND salon_id = $2', [variants, _sid]);
    // AUDITORÍA v1.1: antes se borraban las notas y recordatorios de ese
    // teléfono en TODOS los salones. Ahora solo los de este salón (las
    // filas viejas sin salon_id se conservan: no se puede saber de qué
    // salón eran, y borrarlas sería borrar datos ajenos).
    await client.query('DELETE FROM client_notes WHERE client_phone = ANY($1) AND salon_id = $2', [variants, _sid]);
    await client.query('DELETE FROM client_reminders WHERE client_phone = ANY($1) AND salon_id = $2', [variants, _sid]);
    await client.query('DELETE FROM clients WHERE phone = ANY($1)', [variants]);
    await client.query('COMMIT');
    notifyUpdate('client_deleted'); 
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/chats', async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const r = await pool.query(`SELECT c.*, l.status as lead_status, l.items_to_clean, l.location, l.address, l.estimated_value, l.advisor as lead_advisor, l.technical_images FROM conversations c LEFT JOIN leads l ON c.id = l.conversation_id WHERE c.salon_id = $1 ORDER BY c.last_message_time DESC`, [_sid]);
    // v5.2 Alcance por rol (JWT): antes este endpoint devolvía TODAS las
    // conversaciones a cualquier usuario logueado. Ahora: operador solo
    // las de los clientes de sus servicios asignados (B5); asesor solo
    // las suyas o sin asignar; líder las suyas, las de su red o sin
    // asignar; admin todas.
    const scope = await getRoleScope(req);
    let rows = r.rows;
    // AUDITORÍA v1.1: la estilista/manicurista veía todos los chats.
    if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') {
      const phones = new Set(await operatorServicePhones(scope.userName));
      rows = rows.filter((row) => phoneVariantsFor(row.client_phone).some((v) => phones.has(v)));
    } else if (scope.role === 'advisor') {
      const myName = (scope.userName || '').trim().toLowerCase();
      rows = rows.filter((row) => { const a = (row.lead_advisor || '').trim().toLowerCase(); return !a || a === 'sin asignar' || a === myName; });
    } else if (scope.role === 'sales_agent') {
      const names = new Set((scope.names || []).map((n) => n.trim().toLowerCase()));
      rows = rows.filter((row) => { const a = (row.lead_advisor || '').trim().toLowerCase(); return !a || a === 'sin asignar' || names.has(a); });
    }
    const chats = await Promise.all(rows.map(async (row) => {
      // v1.3 (CRM v5.3.30): tope de 50 mensajes por conversación. Sin tope,
      // un chat largo devolvía miles de filas en cada refresco (N+1 sin
      // LIMIT). Los anteriores se cargan con GET /api/chats/:id/messages.
      const cnt = await pool.query('SELECT COUNT(*) FROM messages WHERE conversation_id = $1', [row.id]);
      const totalMsgs = parseInt(cnt.rows[0].count);
      const msgs = await pool.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp DESC, id DESC LIMIT 50', [row.id]);
      const ordered = msgs.rows.reverse();
      const tasks = await pool.query('SELECT COUNT(*) FROM tasks WHERE conversation_id = $1 AND completed = false', [row.id]);
      return {
        id: row.id,
        clientName: row.client_name,
        clientPhone: row.client_phone,
        source: row.source,
        unreadCount: row.unread_count,
        leadStatus: row.lead_status,
        inboxName: row.inbox_name,
        pendingTasksCount: parseInt(tasks.rows[0].count),
        // v1.3 (CRM v5.3.31): el refresco se dispara por el ID del último
        // mensaje, NO por el conteo (con el tope de 50 el conteo dejaba de
        // cambiar y las imágenes no aparecían hasta refrescar a mano).
        lastMessageId: ordered.length ? ordered[ordered.length - 1].id.toString() : null,
        hasMoreMessages: totalMsgs > 50,
        totalMessages: totalMsgs,
        leadData: { itemsToClean: row.items_to_clean, location: row.location, address: row.address, estimatedValue: Number(row.estimated_value), advisor: row.lead_advisor, technicalImages: row.technical_images || [] },
        messages: ordered.map(m => ({
          id: m.id.toString(),
          sender: m.sender,
          content: m.content,
          type: m.type,
          attachmentUrl: m.attachment_url,
          status: m.status || null,
          timestamp: new Date(m.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })
        }))
      };
    }));
    res.json(chats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// v1.3 (CRM v5.3.30): mensajes paginados por conversación. ?before=<id>
// trae los anteriores a ese id; la respuesta es { data, hasMore,
// lastMessageId }. El frontend usa el botón "Cargar mensajes anteriores".
app.get('/api/chats/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const conv = await pool.query('SELECT salon_id, client_phone FROM conversations WHERE id = $1', [id]);
    if (!conv.rows[0] || Number(conv.rows[0].salon_id) !== salonIdNum(req)) return res.status(404).json({ error: 'Conversación no encontrada en este salón' });
    const scope = await getRoleScope(req);
    if (['operator', 'estilista', 'manicurista'].includes(scope.role)) {
      const phones = new Set(await operatorServicePhones(scope.userName));
      if (!phoneVariantsFor(conv.rows[0].client_phone).some((v) => phones.has(v))) {
        return res.status(403).json({ error: 'Esa conversación no es de tus servicios' });
      }
    }
    const params = [id];
    let where = 'conversation_id = $1';
    if (before) { params.push(before); where += ` AND id < $${params.length}`; }
    params.push(limit + 1);
    const r = await pool.query(`SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
    const hasMore = r.rows.length > limit;
    const rows = (hasMore ? r.rows.slice(0, limit) : r.rows).reverse();
    res.json({
      data: rows.map((m) => ({
        id: m.id.toString(),
        sender: m.sender,
        content: m.content,
        type: m.type,
        attachmentUrl: m.attachment_url,
        status: m.status || null,
        timestamp: new Date(m.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }),
      })),
      hasMore,
      lastMessageId: rows.length ? rows[rows.length - 1].id.toString() : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// v1.3 (CRM v5.3.31): marcar como leída (antes el frontend lo hacía de
// mentira en memoria y el contador de sin leer nunca bajaba de verdad).
app.post('/api/chats/:id/read', async (req, res) => {
  try {
    const chk = await pool.query('UPDATE conversations SET unread_count = 0 WHERE id = $1 AND salon_id = $2 RETURNING id', [req.params.id, salonIdNum(req)]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'Conversación no encontrada en este salón' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads', async (req, res) => {
  const { page = 1, limit = 50, search = '', status = 'all', startDate, endDate, location, source, minPrice, maxPrice, advisor } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const _sid = salonIdNum(req);
  if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
  try {
    let params = [];
    params.push(`%${search}%`);
    const namePh = `$${params.length}`;
    const phoneCond = likeAny(params, 'client_phone', phoneSearchPatterns(search));
    let whereClauses = [`(client_name ILIKE ${namePh} OR ${phoneCond})`];
    
    if (status !== 'all') {
      params.push(status);
      whereClauses.push(`status = $${params.length}`);
    }
    if (startDate) {
      params.push(startDate);
      whereClauses.push(`created_at >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      whereClauses.push(`created_at <= $${params.length}::timestamp + interval '1 day'`);
    }
    if (location && location !== 'all') {
      params.push(location);
      whereClauses.push(`location = $${params.length}`);
    }
    if (source && source !== 'all') {
      params.push(source);
      whereClauses.push(`source = $${params.length}`);
    }
    if (minPrice) {
      params.push(minPrice);
      whereClauses.push(`estimated_value >= $${params.length}`);
    }
    if (maxPrice) {
      params.push(maxPrice);
      whereClauses.push(`estimated_value <= $${params.length}`);
    }

    // --- RESTRICCIÓN DE SEGURIDAD POR ROL v5.2: alcance del JWT ---
    const scope = await getRoleScope(req);
    whereClauses.push(`salon_id = ${_sid}`);
    if (scope.role === 'operator' || scope.role === 'estilista' || scope.role === 'manicurista') {
      // El operador no tiene pipeline: solo los leads de los clientes de
      // sus servicios asignados (por teléfono, con variantes +57).
      const phones = await operatorServicePhones(scope.userName);
      if (phones.length) { params.push(phones); whereClauses.push(`client_phone = ANY($${params.length})`); }
      else whereClauses.push('1 = 0');
    } else if (scope.role !== 'admin') {
      applyRoleScopeClauses(scope, whereClauses, params);
    }
    // Filtro de la UI (asesor elegido en el pipeline): se SUMA al alcance
    // del JWT, nunca lo amplía. Antes, si un líder pasaba ?advisor=otro,
    // el filtro de equipo se saltaba y veía leads ajenos.
    if (advisor && advisor !== 'all') {
      params.push(advisor);
      whereClauses.push(`advisor = $${params.length}`);
    }

    const whereSql = " WHERE " + whereClauses.join(" AND ");
    
    const countQuery = `SELECT COUNT(*) FROM leads ${whereSql}`;
    const totalCount = await pool.query(countQuery, params);

    const query = `
      SELECT * FROM leads 
      ${whereSql}
      ORDER BY updated_at DESC 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(parseInt(limit), offset);
    
    const r = await pool.query(query, params);
    res.json({
      data: r.rows.map(row => ({
        id: row.id.toString(),
        conversationId: row.conversation_id,
        clientName: row.client_name,
        clientPhone: row.client_phone,
        status: row.status,
        itemsToClean: row.items_to_clean, 
        location: row.location,
        address: row.address,
        estimatedValue: Number(row.estimated_value), 
        advisor: row.advisor,
        lostReason: row.lost_reason,
        assignedAt: row.assigned_at,
        technicalImages: row.technical_images || [],
        createdAt: row.created_at,
        source: row.source
      })),
      total: parseInt(totalCount.rows[0].count)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/update', async (req, res) => {
  // AUDITORÍA v1.1: este endpoint estaba roto al 100% — usaba leadId,
  // conversationId, clientName, itemsToClean, estimatedValue, lostReason
  // y source sin desestructurarlos (ReferenceError en cada llamada).
  // Reescrito: nombres correctos, alcance por salón del JWT, y el
  // operador sigue sin poder modificar prospectos.
  if (normalizeRoleValue(req.user?.role) === 'operator' || ['estilista', 'manicurista'].includes((req.user?.role || '').toLowerCase())) {
    return res.status(403).json({ error: 'Solo lectura: las profesionales no pueden modificar prospectos' });
  }
  const _sid = salonIdNum(req);
  if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
  const b = req.body || {};
  const leadId = b.id ?? b.leadId ?? null;
  const conversationId = b.conversationId ?? b.conversation_id ?? null;
  const clientName = b.clientName ?? b.client_name ?? null;
  const status = b.status ?? null;
  const statusReason = b.status_reason ?? b.statusReason ?? null;
  const estimatedValue = b.estimated_value ?? b.estimatedValue ?? null;
  const itemsToClean = b.items_to_clean ?? b.itemsToClean ?? null;
  const technicalImages = b.technical_images ?? b.technicalImages ?? null;
  const location = b.location ?? null;
  const address = b.address ?? null;
  const advisor = b.advisor ?? null;
  const lostReason = b.lost_reason ?? b.lostReason ?? statusReason ?? null;
  const source = b.source ?? null;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let finalLeadId = leadId;
      if (conversationId && !finalLeadId) {
        const check = await client.query('SELECT id FROM leads WHERE conversation_id = $1 AND salon_id = $2', [conversationId, _sid]);
        if (check.rows.length > 0) finalLeadId = check.rows[0].id;
      }
      let finalAdvisor = advisor;
      if (finalLeadId) {
        const cur = await client.query('SELECT advisor FROM leads WHERE id = $1 AND salon_id = $2', [finalLeadId, _sid]);
        if (!cur.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Prospecto no encontrado en este salón' }); }
        if (!finalAdvisor) finalAdvisor = cur.rows[0]?.advisor;
        await client.query(`UPDATE leads SET status = COALESCE($1, status), client_name = COALESCE($2, client_name), technical_images = COALESCE($3, technical_images), items_to_clean = COALESCE($4, items_to_clean), estimated_value = COALESCE($5, estimated_value), address = COALESCE($6, address), location = COALESCE($7, location), advisor = COALESCE($8, advisor), lost_reason = COALESCE($9, lost_reason), source = COALESCE($10, source), updated_at = NOW() WHERE id = $11 AND salon_id = $12`, [status, clientName, technicalImages, itemsToClean, estimatedValue, address, location, finalAdvisor, lostReason, source, finalLeadId, _sid]);
      } else if (conversationId) {
        const ins = await client.query(
          `INSERT INTO leads (conversation_id, client_name, status, technical_images, items_to_clean, estimated_value, address, location, advisor, source, salon_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [conversationId, clientName || 'Cliente Nuevo', status || 'NUEVO', technicalImages || [], itemsToClean, estimatedValue || 0, address, location, finalAdvisor, source, _sid]);
        finalLeadId = ins.rows[0].id;
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Falta el id del prospecto o la conversación' });
      }
      if (clientName && conversationId) {
        await client.query('UPDATE conversations SET client_name = $1 WHERE id = $2 AND salon_id = $3', [clientName, conversationId, _sid]);
      }
      await client.query('COMMIT');
      if (finalAdvisor) {
        const advId = await pool.query('SELECT id FROM employees WHERE name = $1 AND salon_id = $2', [finalAdvisor, _sid]);
        notifyUpdate('lead', advId.rows.map(r => r.id));
      } else {
        notifyUpdate('lead');
      }
      res.json({ success: true, id: finalLeadId });
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Borrar lead (lo usa Auditoría). Sin esto el borrado devolvía 404
// y fallaba en silencio.
app.delete('/api/leads/:id', requireAdmin, async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const chk = await pool.query('DELETE FROM leads WHERE id = $1 AND salon_id = $2 RETURNING id', [req.params.id, _sid]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'Prospecto no encontrado en este salón' });
    notifyUpdate('lead');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/staff', async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const r = await pool.query(`SELECT e.id, e.name, e.email, e.role, e.phone, e.commission_pct as "commissionPct", e.parent_id as "parentId", p.name as "parentName", e.is_online as "isOnline", e.last_assigned_at as "lastAssignedAt" FROM employees e LEFT JOIN employees p ON e.parent_id = p.id WHERE e.active = true AND e.salon_id = $1 ORDER BY e.role, e.name`, [_sid]);
    res.json(r.rows.map(row => ({ ...row, id: row.id.toString(), parentId: row.parentId ? row.parentId.toString() : undefined })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff', requireAdmin, async (req, res) => {
  const { name, email, password, phone: rawPhone, active, commissionPct, parentId } = req.body;
  const role = normalizeRoleValue(req.body?.role);
  if (!role) return res.status(400).json({ error: "role inválido: debe ser uno de 'superadmin', 'admin', 'recepcionista', 'estilista', 'manicurista', 'advisor', 'operator', 'sales_agent'" });
  const phone = normalizePhoneString(rawPhone);
  if (!name || !email) return res.status(400).json({ error: 'Nombre y correo son obligatorios' });
  try {
    // Antes: sin contraseña se creaba el usuario con la clave por defecto
    // '123456', y al editar por email existente el upsert SIEMPRE reseteaba
    // la clave. Ahora: crear exige contraseña; editar sin contraseña deja
    // la clave existente intacta.
    // AUDITORÍA v1.1: el upsert global por email movía empleados de un
    // salón a otro. Ahora el correo pertenece a UN salón: si ya existe en
    // otro, se rechaza; si existe aquí, se actualiza solo aquí.
    const existing = await pool.query('SELECT id, salon_id FROM employees WHERE email = $1', [email]);
    if (existing.rows[0] && Number(existing.rows[0].salon_id) !== salonIdNum(req)) {
      return res.status(400).json({ error: 'Ese correo ya pertenece a un empleado de otro salón' });
    }
    if (existing.rows.length === 0 && !password) {
      return res.status(400).json({ error: 'La contraseña es obligatoria al crear un empleado' });
    }
    if (password && isWeakPassword(password)) {
      return res.status(400).json({ error: 'Esa contraseña es demasiado débil (mínimo 8 caracteres y no una clave común)' });
    }
    // v1.3 (CRM v5.3.29 H-A2): el nombre del profesional es único por salón.
    // Dos 'María' en el mismo salón confunden comisiones, agenda y ranking
    // (todo se filtra por nombre). La migración en initDB renombra los
    // duplicados viejos a 'Nombre (2)', 'Nombre (3)'...
    if (['estilista', 'manicurista', 'operator'].includes(role)) {
      const dup = await pool.query("SELECT id, email FROM employees WHERE salon_id = $1 AND active = true AND LOWER(TRIM(name)) = LOWER(TRIM($2)) AND role IN ('estilista','manicurista','operator')", [salonIdNum(req), name]);
      if (dup.rows.length && dup.rows.some((x) => x.email !== email)) {
        return res.status(400).json({ error: `Ya existe un profesional llamado "${name}" en este salón: los nombres deben ser únicos` });
      }
    }
    let result;
    if (password) {
      const hashedPw = await bcrypt.hash(password, 10);
      const query = `INSERT INTO employees (name, email, password, role, phone, active, commission_pct, parent_id, salon_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password = EXCLUDED.password, role = EXCLUDED.role, phone = EXCLUDED.phone, active = EXCLUDED.active, commission_pct = EXCLUDED.commission_pct, parent_id = EXCLUDED.parent_id, salon_id = EXCLUDED.salon_id, token_version = employees.token_version + 1 RETURNING id`;
      result = await pool.query(query, [name, email, hashedPw, role, phone, active ?? true, commissionPct || 0, parentId || null, salonIdNum(req)]);
    } else {
      const query = `INSERT INTO employees (name, email, role, phone, active, commission_pct, parent_id, salon_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, phone = EXCLUDED.phone, active = EXCLUDED.active, commission_pct = EXCLUDED.commission_pct, parent_id = EXCLUDED.parent_id, salon_id = EXCLUDED.salon_id RETURNING id`;
      result = await pool.query(query, [name, email, role, phone, active ?? true, commissionPct || 0, parentId || null, salonIdNum(req)]);
    }
    // v5 Parte 2C: el cambio de equipo queda en system_events.
    await recordEvent('info', 'staff', `Empleado ${name} (${email}) ${existing.rows.length ? 'actualizado' : 'creado'} por ${req.user?.email || 'admin'}`, { email, employee_id: result.rows[0].id });
    notifyUpdate('staff');
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/staff/:id', requireAdminOrLeader, async (req, res) => {
  const { id } = req.params;
  const _own = await pool.query('SELECT salon_id FROM employees WHERE id = $1', [id]);
  if (!_own.rows[0] || Number(_own.rows[0].salon_id) !== salonIdNum(req)) return res.status(404).json({ error: 'Empleado no encontrado en este salón' });
  const { name, email, password, phone: rawPhone, active, commissionPct, parentId } = req.body;
  const role = normalizeRoleValue(req.body?.role);
  if (!role) return res.status(400).json({ error: "role inválido: debe ser 'admin', 'advisor', 'operator' o 'sales_agent'" });
  const phone = normalizePhoneString(rawPhone);
  try {
    if (password && isWeakPassword(password)) {
      return res.status(400).json({ error: 'Esa contraseña es demasiado débil (mínimo 8 caracteres y no una clave común)' });
    }
    // v1.3 (auditoría v1.2): el PUT actualizaba el correo sin comprobar
    // duplicados (500 por UNIQUE o, peor, mover el empleado a otro salón).
    if (email) {
      const emailDup = await pool.query('SELECT id FROM employees WHERE email = $1 AND id <> $2', [email, id]);
      if (emailDup.rows[0]) return res.status(400).json({ error: 'Ese correo ya está en uso por otro empleado' });
    }
    if (name && ['estilista', 'manicurista', 'operator'].includes(role)) {
      const nameDup = await pool.query("SELECT id FROM employees WHERE salon_id = $1 AND active = true AND LOWER(TRIM(name)) = LOWER(TRIM($2)) AND role IN ('estilista','manicurista','operator') AND id <> $3", [salonIdNum(req), name, id]);
      if (nameDup.rows[0]) return res.status(400).json({ error: `Ya existe un profesional llamado "${name}" en este salón: los nombres deben ser únicos` });
    }
    let query = 'UPDATE employees SET name=$1, email=$2, role=$3, phone=$4, active=$5, commission_pct=$6, parent_id=$7';
    let params = [name, email, role, phone, active ?? true, commissionPct || 0, parentId || null];
    if (password) { const hashedPw = await bcrypt.hash(password, 10); query += ', password=$8, token_version = token_version + 1 WHERE id=$9'; params.push(hashedPw, id); }
    else { query += ' WHERE id=$8'; params.push(id); }
    await pool.query(query, params);
    // v5 Parte 2C: el cambio de equipo queda en system_events.
    await recordEvent('info', 'staff', `Empleado ${name || id} actualizado por ${req.user?.email || 'admin'}`, { employee_id: id, email: email || null });
    notifyUpdate('staff');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/staff/:id', requireAdmin, async (req, res) => {
  try {
    const target = await pool.query('SELECT name, email FROM employees WHERE id = $1 AND salon_id = $2', [req.params.id, salonIdNum(req)]);
    if (!target.rows[0]) return res.status(404).json({ error: 'Empleado no encontrado en este salón' });
    await pool.query('UPDATE employees SET active = false WHERE id = $1', [req.params.id]);
    // v5 Parte 2C: la desactivación queda en system_events.
    await recordEvent('warn', 'staff', `Empleado ${target.rows[0]?.name || req.params.id} desactivado por ${req.user?.email || 'admin'}`, { employee_id: req.params.id, email: target.rows[0]?.email || null });
    notifyUpdate('staff');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/staff/status', requireAdmin, async (req, res) => {
  const { id, isOnline } = req.body;
  try {
    const chk = await pool.query('UPDATE employees SET is_online = $1 WHERE id = $2 AND salon_id = $3 RETURNING id', [isOnline, id, salonIdNum(req)]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'Empleado no encontrado en este salón' });
    notifyUpdate('staff_status');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  // El login es público (sin JWT), así que comprueba la DB aquí mismo: antes
  // esta ruta hacía pool.query sin try/catch y un error de conexión tumbaba
  // todo el proceso.
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const { email, password } = req.body;
    // v1.3 (CRM v5.3.29): bloqueo por correo+IP: 5 fallos en 10 min = 429
    // durante 15 min (antes 10 min y solo por correo).
    const blockKey = `${(email || '').toLowerCase()}|${req.ip}`;
    const now = Date.now();
    const blockedUntil = loginBlocks.get(blockKey);
    if (blockedUntil && now < blockedUntil) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos: espera 15 minutos antes de reintentar' });
    }
    const r = await pool.query('SELECT * FROM employees WHERE email = $1 AND active = true', [email]);
    if (r.rows.length > 0 && await bcrypt.compare(password, r.rows[0].password)) {
      loginFailures.delete((email || '').toLowerCase());
      loginBlocks.delete(blockKey);
      const user = { id: r.rows[0].id.toString(), name: r.rows[0].name, role: r.rows[0].role.toLowerCase(), email: r.rows[0].email, isOnline: r.rows[0].is_online, salonId: r.rows[0].salon_id ? Number(r.rows[0].salon_id) : null, tv: r.rows[0].token_version ?? 0 };
      const token = jwt.sign(user, jwtSecret, { expiresIn: '24h' });
      // v1.3: el JWT sale en cookie HttpOnly (no en localStorage). El token
      // también se devuelve en el cuerpo por compatibilidad con clientes API.
      res.cookie(AUTH_COOKIE, token, authCookieOptions(req));
      res.json({ success: true, user, token });
    } else {
      // Login fallido: queda registrado. 5 fallos en 10 min con el mismo
      // correo+IP = posible ataque de fuerza bruta (evento crítico + alerta).
      const key = (email || '').toLowerCase();
      const fails = (loginFailures.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
      fails.push(now);
      loginFailures.set(key, fails);
      if (fails.length >= 5) {
        loginBlocks.set(blockKey, now + 15 * 60 * 1000);
        recordEvent('critical', 'auth', `Posible fuerza bruta: ${fails.length} intentos fallidos de login con ${email} en 10 min`, { email });
        maybeAlert(`brute-${key}`, `🚨 Seguridad: ${fails.length} intentos fallidos de login con ${email} en 10 minutos.`);
        return res.status(429).json({ error: 'Demasiados intentos fallidos: espera 15 minutos antes de reintentar' });
      } else {
        recordEvent('warn', 'auth', `Login fallido con ${email}`, { email });
      }
      res.status(401).json({ error: 'Credenciales inválidas o cuenta desactivada' });
    }
  } catch (err) {
    logger.error('Error en login', err);
    res.status(500).json({ error: 'Error de base de datos' });
  }
});

// v1.3 (CRM v5.3.26): sesión actual desde el middleware (cookie o Bearer).
app.get('/api/auth/me', (req, res) => {
  res.json({ success: true, user: req.user });
});

// v1.3 (CRM v5.3.26): logout revoca el JWT (sube token_version) y borra
// las cookies. Es público para que siempre pueda borrar la cookie, aunque
// el token ya haya expirado.
app.post('/api/auth/logout', async (req, res) => {
  const token = tokenFromRequest(req);
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.clearCookie(SUPERADMIN_COOKIE, { path: '/' });
  if (token && dbUrl) {
    try {
      const d = jwt.verify(token, jwtSecret);
      await pool.query('UPDATE employees SET token_version = token_version + 1 WHERE id = $1', [employeeBaseId(d)]);
    } catch { /* token ya inválido: basta con borrar la cookie */ }
  }
  res.json({ success: true });
});

// v1.3 (CRM v5.3.26): cambiar la propia contraseña revoca las demás sesiones.
app.post('/api/auth/change-password', async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Faltan la contraseña actual y la nueva' });
  if (isWeakPassword(newPassword)) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres y no ser una clave común' });
  try {
    const baseId = employeeBaseId(req.user);
    const r = await pool.query('SELECT * FROM employees WHERE id = $1 AND active = true', [baseId]);
    if (!r.rows[0] || !(await bcrypt.compare(currentPassword, r.rows[0].password))) {
      return res.status(401).json({ error: 'La contraseña actual no coincide' });
    }
    const hashedPw = await bcrypt.hash(newPassword, 10);
    const upd = await pool.query('UPDATE employees SET password = $1, token_version = token_version + 1 WHERE id = $2 RETURNING token_version', [hashedPw, baseId]);
    const row = r.rows[0];
    const user = { id: row.id.toString(), name: row.name, role: (row.role || '').toLowerCase(), email: row.email, isOnline: row.is_online, salonId: row.salon_id ? Number(row.salon_id) : null, tv: upd.rows[0].token_version };
    const token = jwt.sign(user, jwtSecret, { expiresIn: '24h' });
    res.cookie(AUTH_COOKIE, token, authCookieOptions(req));
    res.json({ success: true, user, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/services', async (req, res) => {
  const { page = 1, limit = 50, search = '', dealStatus = 'all', startDate, endDate, location, staff, payment } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const _sid = salonIdNum(req);
  if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
  try {
    let params = [];
    params.push(`%${search}%`);
    const namePh = `$${params.length}`;
    const phoneCond = likeAny(params, 'client_phone', phoneSearchPatterns(search));
    let whereClauses = [`(client_name ILIKE ${namePh} OR id::text ILIKE ${namePh} OR ${phoneCond})`];
    
    if (dealStatus !== 'all') {
      params.push(dealStatus);
      whereClauses.push(`deal_status = $${params.length}`);
    }

    if (startDate) {
      params.push(startDate);
      whereClauses.push(`date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      whereClauses.push(`date <= $${params.length}`);
    }
    if (location && location !== 'all') {
      params.push(location);
      whereClauses.push(`neighborhood = $${params.length}`);
    }
    if (staff && staff !== 'all') {
      params.push(staff);
      whereClauses.push(`($${params.length} = ANY(operators) OR advisor = $${params.length})`);
    }
    if (payment && payment !== 'all') {
      params.push(payment);
      whereClauses.push(`payment_method = $${params.length}`);
    }

    // --- RESTRICCIÓN DE SEGURIDAD POR ROL v5.2: alcance del JWT ---
    const scope = await getRoleScope(req);
    whereClauses.push(`salon_id = ${_sid}`);
    applyRoleScopeClauses(scope, whereClauses, params, { operatorsCol: 'operators' });
    if (scope.role === 'operator') whereClauses.push("deal_status NOT IN ('AGENDADO', 'REAGENDADO', 'CANCELADO')");

    const whereSql = " WHERE " + whereClauses.join(" AND ");
    
    const countQuery = `SELECT COUNT(*) FROM services ${whereSql}`;
    const totalCount = await pool.query(countQuery, params);

    const query = `
      SELECT * FROM services 
      ${whereSql}
      ORDER BY date DESC, time ASC 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(parseInt(limit), offset);
    
    const r = await pool.query(query, params);
    res.json({
      data: r.rows.map(row => ({
        id: row.id.toString(),
        date: row.date ? row.date.toISOString().split('T')[0] : '',
        time: row.time,
        clientName: row.client_name,
        clientPhone: row.client_phone,
        city: row.city,
        neighborhood: row.neighborhood,
        address: row.address,
        advisor: row.advisor,
        operators: row.operators || [],
        itemsToClean: row.items_to_clean,
        servicePerformed: row.service_performed,
        observations: row.observations,
        initialValue: Number(row.initial_value),
        additionalItems: row.additional_items,
        additionalValue: Number(row.additional_value),
        totalValue: Number(row.total_value),
        paymentMethod: row.payment_method,
        expenses: Number(row.expenses),
        expensesNote: row.expenses_note,
        operatorPayment: Number(row.operator_payment),
        advances: Number(row.advances),
        netProfit: Number(row.net_profit),
        isWarranty: row.is_warranty,
        dealStatus: row.deal_status,
        technicalImages: row.technical_images || [],
        afterImages: row.after_images || [],
        clientSignature: row.client_signature || '',
        cancellationReason: row.cancellation_reason,
        rescheduleCount: row.reschedule_count,
        source: row.source,
        total: parseInt(totalCount.rows[0].count)
      })),
      total: parseInt(totalCount.rows[0].count)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/services', async (req, res) => {
  const s = req.body;
  // El teléfono del cliente se guarda normalizado (+57...) para que el
  // mismo cliente no se duplique con '300...' en un lado y '+57300...' en otro.
  const clientPhone = normalizePhoneString(s.clientPhone);
  const _sid = salonIdNum(req);
  if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
  try {
    // AUDITORÍA v1.1: el upsert por id global permitía sobrescribir el
    // servicio de otro salón (y el UPDATE posterior lo reasignaba de
    // salón). Ahora: si el id ya existe en otro salón, 403.
    if (s.id) {
      const own = await pool.query('SELECT salon_id FROM services WHERE id = $1', [s.id]);
      if (own.rows[0] && Number(own.rows[0].salon_id) !== _sid) return res.status(403).json({ error: 'Ese servicio pertenece a otro salón' });
    }
    const query = `
    INSERT INTO services (
      id, date, time, client_name, client_phone, city, neighborhood, address, advisor,
      operators, items_to_clean, service_performed, observations, initial_value, additional_items, additional_value, total_value,
      payment_method, expenses, expenses_note, operator_payment, advances, net_profit, is_warranty, deal_status, technical_images, after_images, client_signature, source, reschedule_count, cancellation_reason, salon_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
    ON CONFLICT (id) DO UPDATE SET
      date=EXCLUDED.date, time=EXCLUDED.time, client_name=EXCLUDED.client_name, client_phone=EXCLUDED.client_phone,
      city=EXCLUDED.city, neighborhood=EXCLUDED.neighborhood, address=EXCLUDED.address, advisor=EXCLUDED.advisor,
      operators=EXCLUDED.operators, items_to_clean=EXCLUDED.items_to_clean, service_performed=EXCLUDED.service_performed, observations=EXCLUDED.observations, initial_value=EXCLUDED.initial_value,
      additional_items=EXCLUDED.additional_items, additional_value=EXCLUDED.additional_value,
      total_value=EXCLUDED.total_value, payment_method=EXCLUDED.payment_method,
      expenses=EXCLUDED.expenses, expenses_note=EXCLUDED.expenses_note, operator_payment=EXCLUDED.operator_payment, advances=EXCLUDED.advances, net_profit=EXCLUDED.net_profit, is_warranty=EXCLUDED.is_warranty,
      deal_status=EXCLUDED.deal_status,
      technical_images=EXCLUDED.technical_images, after_images=EXCLUDED.after_images, client_signature=EXCLUDED.client_signature,
      source=COALESCE(EXCLUDED.source, services.source),
      reschedule_count=EXCLUDED.reschedule_count, cancellation_reason=EXCLUDED.cancellation_reason
    RETURNING id`;
    const r = await pool.query(query, [
      s.id, s.date, s.time, s.clientName, clientPhone, s.city, s.neighborhood, s.address, s.advisor,
      s.operators, s.itemsToClean, s.servicePerformed || '', s.observations || '', s.initialValue, s.additionalItems, s.additionalValue, s.totalValue,
      s.paymentMethod, s.expenses || 0, s.expensesNote || '', s.operatorPayment || 0, s.advances || 0, s.netProfit || 0, s.isWarranty || false, s.dealStatus || 'AGENDADO',
      s.technicalImages || [], s.afterImages || [], s.clientSignature || '', s.source, s.rescheduleCount || 0, s.cancellationReason || null, _sid
    ]);

    const peopleInvolved = [s.advisor, ...(s.operators || [])];
    const idsRes = await pool.query("SELECT id FROM employees WHERE name = ANY($1)", [peopleInvolved]);
    notifyUpdate('service', idsRes.rows.map(r => r.id));

    res.json({ id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/services/update-deal', async (req, res) => {
  const { id, status, reason, date, time } = req.body;
  try {
    // v1.3 (CRM v5.3, bug hunt): cambiar el estado de una venta no es cosa
    // de la profesional que la ejecuta (solo lectura, como en el chat): es
    // de admin, recepcionista o quien vende (asesor/director).
    if (['operator', 'estilista', 'manicurista'].includes(normalizeRoleValue(req.user?.role))) {
      return res.status(403).json({ error: 'Solo administradores, recepción o ventas pueden cambiar el estado de una venta' });
    }
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const serviceInfo = await pool.query("SELECT advisor, operators, reschedule_count FROM services WHERE id = $1 AND salon_id = $2", [id, _sid]);
    if (!serviceInfo.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado en este salón' });
    
    // cancellation_reason solo se toca al CANCELAR: antes, cualquier cambio
    // de estado (p. ej. AGENDADO -> CONFIRMADO) borraba el motivo guardado.
    let query = 'UPDATE services SET deal_status = $1';
    let params = [status, id, _sid];
    if (status === 'CANCELADO') {
      query += ', cancellation_reason = $4 WHERE id = $2 AND salon_id = $3';
      params.push(reason || null);
    } else if (status === 'REAGENDADO') {
      const newCount = (serviceInfo.rows[0]?.reschedule_count || 0) + 1;
      query += ', date = $4, time = $5, reschedule_count = $6, observations = $7 WHERE id = $2 AND salon_id = $3';
      params.push(date, time, newCount, reason || null);
    } else {
      query += ' WHERE id = $2 AND salon_id = $3';
    }

    await pool.query(query, params);
    
    if (serviceInfo.rows[0]) {
      const people = [serviceInfo.rows[0].advisor, ...(serviceInfo.rows[0].operators || [])];
      const idsRes = await pool.query("SELECT id FROM employees WHERE name = ANY($1)", [people]);
      notifyUpdate('service_status', idsRes.rows.map(r => r.id));
    } else {
      notifyUpdate('service_status');
    }
    
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/services/:id', requireAdmin, async (req, res) => {
  try {
    const chk = await pool.query('DELETE FROM services WHERE id = $1 AND salon_id = $2 RETURNING id', [req.params.id, salonIdNum(req)]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado en este salón' });
    notifyUpdate('service_deleted');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- FACTURACIÓN Y COBROS v5 Parte 2A (Colombia) ----------
// Esto es facturación INTERNA con cobro por Wompi/PayU. NO es facturación
// electrónica DIAN: no hay envío a la DIAN ni CUFE. Los campos DIAN-ready
// (NIT empresa/cliente, régimen, resolución) y el export JSON existen para
// alimentar a un proveedor certificado (Siigo/Alegra). Ver README.
const INVOICE_STATUSES = ['pendiente', 'parcial', 'pagado', 'anulado'];

function formatInvoiceNumber(n) {
  return `FAC-${String(n).padStart(4, '0')}`;
}

async function getSettingValue(key, fallback = null) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return r.rows[0]?.value ?? fallback;
  } catch { return fallback; }
}

async function getCompanySettings() {
  const keys = ['company_nit', 'company_regime', 'dian_resolution_number', 'dian_resolution_range', 'dian_resolution_date'];
  const out = {};
  for (const k of keys) out[k] = await getSettingValue(k, '');
  try {
    const r = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'branding_%'");
    for (const row of r.rows) out[row.key] = row.value;
  } catch { /* sin branding aún */ }
  return out;
}

// v5.1 Tipos de factura válidos. 'normal' = factura de venta sin DIAN;
// 'electronica' = DIAN-ready (lista para el proveedor certificado).
const INVOICE_TYPES = ['normal', 'electronica'];

function mapInvoice(row) {
  return {
    id: row.id,
    number: row.number,
    type: INVOICE_TYPES.includes(row.type) ? row.type : 'normal',
    serviceId: row.service_id,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    clientNit: row.client_nit || '',
    subtotal: Number(row.subtotal),
    advances: Number(row.advances),
    total: Number(row.total),
    balance: Number(row.balance),
    status: row.status,
    paymentMethod: row.payment_method || '',
    paymentLink: row.payment_link || '',
    createdAt: row.created_at,
    serviceDate: row.service_date ? row.service_date.toISOString().split('T')[0] : null,
    servicePerformed: row.service_performed || '',
  };
}

async function getInvoicePayments(invoiceId) {
  const r = await pool.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC', [invoiceId]);
  return r.rows.map(p => ({
    id: p.id, invoiceId: p.invoice_id, amount: Number(p.amount),
    method: p.method || '', reference: p.reference || '', createdAt: p.created_at,
  }));
}

function invoiceStatusFor(total, advances, balance) {
  if (balance <= 0) return 'pagado';
  if (advances > 0) return 'parcial';
  return 'pendiente';
}

// Reserva el siguiente número de factura (FAC-XXXX) dentro de una
// transacción con bloqueo de fila, para que dos facturas no repitan número.
// AUDITORÍA v1.1: el consecutivo era global (settings.invoice_next_number):
// dos salones compartían la numeración FAC-XXXX. Ahora cada salón lleva
// su propio consecutivo en salons.invoice_next_number.
async function allocateInvoiceNumber(client, salonId) {
  const r = await client.query('SELECT invoice_next_number FROM salons WHERE id = $1 FOR UPDATE', [salonId]);
  const next = parseInt(r.rows[0]?.invoice_next_number || '1', 10) || 1;
  await client.query('UPDATE salons SET invoice_next_number = $1 WHERE id = $2', [next + 1, salonId]);
  return formatInvoiceNumber(next);
}

app.get('/api/invoices', requireBilling, async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const { status, service_id, type } = req.query;
    const clauses = [`i.salon_id = ${_sid}`];
    const params = [];
    if (status && INVOICE_STATUSES.includes(status)) { params.push(status); clauses.push(`i.status = $${params.length}`); }
    if (type && INVOICE_TYPES.includes(type)) { params.push(type); clauses.push(`i.type = $${params.length}`); }
    if (service_id) { params.push(service_id); clauses.push(`i.service_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT i.*, s.date AS service_date, s.service_performed FROM invoices i
       LEFT JOIN services s ON s.id = i.service_id ${where} ORDER BY i.id DESC`,
      params
    );
    res.json(r.rows.map(mapInvoice));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices/:id', requireBilling, async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const r = await pool.query(
      'SELECT i.*, s.date AS service_date, s.service_performed FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1 AND i.salon_id = $2',
      [req.params.id, _sid]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    const invoice = mapInvoice(r.rows[0]);
    invoice.payments = await getInvoicePayments(invoice.id);
    res.json(invoice);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices', requireBilling, async (req, res) => {
  const { service_id, client_nit, type } = req.body || {};
  if (!service_id) return res.status(400).json({ error: 'service_id requerido' });
  // v5.1 Tipo de factura: si viene, se valida; si no, se usa el tipo por
  // defecto de settings (invoice_default_type, 'normal' si no está).
  let invoiceType = 'normal';
  if (type !== undefined && type !== null && type !== '') {
    if (!INVOICE_TYPES.includes(type)) return res.status(400).json({ error: "type debe ser 'normal' o 'electronica'" });
    invoiceType = type;
  } else {
    const def = await getSettingValue('invoice_default_type', 'normal');
    invoiceType = INVOICE_TYPES.includes(def) ? def : 'normal';
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const svc = await client.query(
      'SELECT id, client_name, client_phone, total_value, advances FROM services WHERE id = $1 AND salon_id = $2',
      [service_id, salonIdNum(req)]
    );
    if (!svc.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Servicio no encontrado' }); }
    const existing = await client.query('SELECT id FROM invoices WHERE service_id = $1 ORDER BY id ASC LIMIT 1', [service_id]);
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      // v1.3 (CRM v5.3.29 H-A1): el atajo already_exists re-leía la factura
      // por id SIN filtro de salón: un salón podía ver la factura de otro.
      const r = await pool.query('SELECT i.*, s.date AS service_date, s.service_performed FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1 AND i.salon_id = $2', [existing.rows[0].id, salonIdNum(req)]);
      if (!r.rows[0]) { return res.status(404).json({ error: 'Factura no encontrada en este salón' }); }
      return res.json({ ...mapInvoice(r.rows[0]), already_exists: true });
    }
    const s = svc.rows[0];
    const subtotal = Number(s.total_value) || 0;
    const advances = Math.min(Number(s.advances) || 0, subtotal);
    const balance = Math.max(0, subtotal - advances);
    const status = invoiceStatusFor(subtotal, advances, balance);
    const number = await allocateInvoiceNumber(client, salonIdNum(req));
    const ins = await client.query(
      `INSERT INTO invoices (number, type, service_id, client_name, client_phone, client_nit, subtotal, advances, total, balance, status, salon_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [number, invoiceType, s.id, s.client_name, s.client_phone, (client_nit || '').trim() || null, subtotal, advances, subtotal, balance, status, salonIdNum(req)]
    );
    await client.query('COMMIT');
    await recordEvent('info', 'invoices', `Factura ${number} (${invoiceType === 'electronica' ? 'electrónica' : 'normal'}) creada desde servicio ${s.id} (${status}, saldo ${balance})`, { invoice: number, type: invoiceType, service_id: s.id });
    notifyUpdate('invoice');
    res.status(201).json(mapInvoice(ins.rows[0]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/invoices/:id/payments', requireBilling, async (req, res) => {
  const { amount, method, reference } = req.body || {};
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que 0' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const _sid = salonIdNum(req);
    if (!_sid) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Sin contexto de salón' }); }
    const inv = await client.query('SELECT * FROM invoices WHERE id = $1 AND salon_id = $2 FOR UPDATE', [req.params.id, _sid]);
    if (!inv.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Factura no encontrada' }); }
    const row = inv.rows[0];
    if (row.status === 'anulado') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La factura está anulada' }); }
    if (row.status === 'pagado') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La factura ya está pagada' }); }
    const paid = Math.min(value, Number(row.balance));
    await client.query(
      'INSERT INTO payments (invoice_id, amount, method, reference) VALUES ($1, $2, $3, $4)',
      [row.id, paid, (method || '').trim() || null, (reference || '').trim() || null]
    );
    const newBalance = Math.max(0, Number(row.balance) - paid);
    const status = invoiceStatusFor(Number(row.total), Number(row.advances), newBalance);
    const upd = await client.query(
      'UPDATE invoices SET balance = $1, status = $2, payment_method = COALESCE($3, payment_method) WHERE id = $4 RETURNING *',
      [newBalance, status, (method || '').trim() || null, row.id]
    );
    await client.query('COMMIT');
    await recordEvent('info', 'invoices', `Pago manual de ${paid} en ${row.number} (saldo ${newBalance}, ${status})`, { invoice: row.number, amount: paid, method: method || null });
    notifyUpdate('invoice');
    res.json(mapInvoice(upd.rows[0]));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/invoices/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const r = await pool.query("UPDATE invoices SET status = 'anulado' WHERE id = $1 AND salon_id = $2 AND status <> 'anulado' RETURNING *", [req.params.id, _sid]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Factura no encontrada o ya anulada' });
    await recordEvent('warn', 'invoices', `Factura ${r.rows[0].number} anulada por ${req.user?.email || 'admin'}`, { invoice: r.rows[0].number });
    notifyUpdate('invoice');
    res.json(mapInvoice(r.rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export DIAN-ready: JSON con todos los campos que un proveedor certificado
// (Siigo, Alegra, etc.) pide para emitir la factura electrónica. Esto NO
// emite nada ante la DIAN; es solo el insumo para ese proveedor.
app.get('/api/invoices/:id/export', requireAdmin, async (req, res) => {
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const r = await pool.query(
      'SELECT i.*, s.date AS service_date, s.service_performed, s.address, s.city, s.neighborhood FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1 AND i.salon_id = $2',
      [req.params.id, _sid]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    const inv = mapInvoice(r.rows[0]);
    // v5.1 Decisión: la exportación DIAN solo aplica a facturas
    // electrónicas. Una factura normal no tiene nada que exportar a la
    // DIAN, así que se rechaza con un 400 claro en vez de devolver un
    // JSON con campos DIAN vacíos que podrían confundir.
    if (inv.type !== 'electronica') {
      return res.status(400).json({ error: 'Esta factura es normal (sin DIAN) y no tiene exportación DIAN. Solo las facturas electrónicas se exportan para el proveedor certificado.' });
    }
    inv.payments = await getInvoicePayments(inv.id);
    const company = await getCompanySettings();
    res.json({
      nota: 'Datos listos para un proveedor de facturación electrónica certificado (Siigo/Alegra). Este JSON NO es una factura electrónica ni se envió a la DIAN.',
      empresa: {
        nombre: company.branding_company_name || 'SalonOS',
        nit: company.company_nit || null,
        regimen: company.company_regime || null,
        resolucion_facturacion: {
          numero: company.dian_resolution_number || null,
          rango: company.dian_resolution_range || null,
          fecha: company.dian_resolution_date || null,
        },
      },
      factura: {
        numero_interno: inv.number, tipo: inv.type, fecha: inv.createdAt, estado: inv.status,
        cliente: { nombre: inv.clientName, telefono: inv.clientPhone, nit: inv.clientNit || null },
        servicio: { id: inv.serviceId, fecha: inv.serviceDate, descripcion: inv.servicePerformed || '', direccion: r.rows[0].address || '', ciudad: r.rows[0].city || '', barrio: r.rows[0].neighborhood || '' },
        subtotal: inv.subtotal, abonos: inv.advances, total: inv.total, saldo: inv.balance,
        moneda: 'COP', medio_pago: inv.paymentMethod || null, link_pago: inv.paymentLink || null,
      },
      pagos: inv.payments,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- LINKS DE PAGO (Wompi / PayU) ----------
app.post('/api/invoices/:id/payment-link', requireBilling, async (req, res) => {
  const { provider } = req.body || {};
  try {
    const _sid = salonIdNum(req);
    if (!_sid) return res.status(403).json({ error: 'Sin contexto de salón' });
    const r = await pool.query('SELECT * FROM invoices WHERE id = $1 AND salon_id = $2', [req.params.id, _sid]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    const inv = r.rows[0];
    if (inv.status === 'anulado') return res.status(400).json({ error: 'La factura está anulada' });
    if (inv.status === 'pagado' || Number(inv.balance) <= 0) return res.status(400).json({ error: 'La factura ya está pagada' });
    const amount = Number(inv.balance);
    let url = null;

    if (provider === 'wompi') {
      const publicKey = (process.env.WOMPI_PUBLIC_KEY || '').trim();
      if (!publicKey) return res.status(400).json({ error: 'Pasarela no configurada: falta WOMPI_PUBLIC_KEY en el .env' });
      // Link de pago Wompi (checkout): public-key, currency COP, monto en
      // centavos y referencia = número de factura. Ver docs de Wompi
      // "Links de pago". redirect-url solo si se configuró WOMPI_REDIRECT_URL.
      const params = new URLSearchParams({
        'public-key': publicKey,
        currency: 'COP',
        'amount-in-cents': String(Math.round(amount * 100)),
        reference: inv.number,
      });
      const redirectUrl = (process.env.WOMPI_REDIRECT_URL || '').trim();
      if (redirectUrl) params.set('redirect-url', redirectUrl);
      url = `https://checkout.wompi.co/p/?${params.toString()}`;
    } else if (provider === 'payu') {
      const merchantId = (process.env.PAYU_MERCHANT_ID || '').trim();
      const apiKey = (process.env.PAYU_API_KEY || '').trim();
      const accountId = (process.env.PAYU_ACCOUNT_ID || '').trim();
      if (!merchantId || !apiKey || !accountId) return res.status(400).json({ error: 'Pasarela no configurada: faltan PAYU_MERCHANT_ID, PAYU_API_KEY o PAYU_ACCOUNT_ID en el .env' });
      // Firma PayU (WebCheckout Colombia): MD5(apiKey~merchantId~referenceCode~amount~currency).
      // El monto va con 2 decimales, igual en la firma y en el parámetro.
      const amountStr = amount.toFixed(2);
      const signature = crypto.createHash('md5').update(`${apiKey}~${merchantId}~${inv.number}~${amountStr}~COP`).digest('hex');
      const params = new URLSearchParams({
        merchantId, accountId,
        description: `Pago factura ${inv.number} - SalonOS`,
        referenceCode: inv.number,
        amount: amountStr, tax: '0', taxReturnBase: '0', currency: 'COP',
        signature, test: '0',
      });
      const responseUrl = (process.env.PAYU_RESPONSE_URL || '').trim();
      const confirmationUrl = (process.env.PAYU_CONFIRMATION_URL || '').trim();
      if (responseUrl) params.set('responseUrl', responseUrl);
      if (confirmationUrl) params.set('confirmationUrl', confirmationUrl);
      url = `https://checkout.payulatam.com/ppp-web-gateway-payu/?${params.toString()}`;
    } else {
      return res.status(400).json({ error: "provider debe ser 'wompi' o 'payu'" });
    }

    const upd = await pool.query('UPDATE invoices SET payment_link = $1 WHERE id = $2 RETURNING *', [url, inv.id]);
    await recordEvent('info', 'invoices', `Link de pago ${provider} generado para ${inv.number} (${amount} COP)`, { invoice: inv.number, provider });
    notifyUpdate('invoice');
    res.json({ ...mapInvoice(upd.rows[0]), payment_url: url, provider });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- WEBHOOKS DE PASARELAS (públicos, verificados por firma) ----------
// Wompi: el evento trae data.transaction {id, status, amount_in_cents,
// reference} y signature.checksum = SHA256(id + status + amount_in_cents +
// secreto de eventos). El secreto es WOMPI_EVENTS_SECRET (del panel de
// Wompi, "Secreto de eventos"); si no está, se acepta WOMPI_PRIVATE_KEY
// como respaldo. SIN secreto configurado el evento se registra pero NO se
// marca nada como pagado (no se puede verificar que venga de Wompi).
app.post('/api/webhooks/wompi', async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const tx = req.body?.data?.transaction;
    const checksum = req.body?.signature?.checksum;
    if (!tx?.id || !tx?.reference) return res.status(400).json({ error: 'Evento Wompi sin transacción' });
    const secret = (process.env.WOMPI_EVENTS_SECRET || process.env.WOMPI_PRIVATE_KEY || '').trim();
    let verified = false;
    if (secret && checksum) {
      const expected = crypto.createHash('sha256').update(`${tx.id}${tx.status}${tx.amount_in_cents}${secret}`).digest('hex');
      const given = String(checksum).toLowerCase();
      verified = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    }
    await recordEvent(verified ? 'info' : 'warn', 'invoices',
      `Webhook Wompi ${tx.status} ref ${tx.reference} (firma ${verified ? 'verificada' : 'NO verificada'})`,
      { transaction_id: tx.id, status: tx.status, reference: tx.reference, verified });
    if (!verified) return res.json({ ok: true, verified: false, note: 'Firma no verificada: evento registrado pero la factura NO se marcó como pagada' });
    if (tx.status !== 'APPROVED') return res.json({ ok: true, verified: true, note: `Estado ${tx.status}: no se marca pagado` });
    // AUDITORÍA v1.1: antes el anticipo se marcaba pagado sin validar el
    // monto ni el estado de la cita, y sin dejar rastro en caja; y un pago
    // PARCIAL de factura la marcaba 'pagado' con saldo 0.
    if (String(tx.reference).startsWith('ANT-')) {
      const apptId = Number(String(tx.reference).slice(4));
      const paidCents = Number(tx.amount_in_cents) / 100;
      const r = await applyWebhookDeposit({ provider: 'Wompi', reference: String(tx.id), apptId, paid: paidCents });
      return res.json({ ok: true, verified: true, ...r });
    }
    const inv = await pool.query("SELECT * FROM invoices WHERE number = $1 AND status <> 'anulado'", [tx.reference]);
    if (!inv.rows[0]) return res.json({ ok: true, verified: true, note: 'Factura no encontrada en el CRM' });
    const row = inv.rows[0];
    if (row.status === 'pagado') return res.json({ ok: true, verified: true, note: 'Factura ya estaba pagada' });
    const paidAmount = Math.min(Number(tx.amount_in_cents) / 100, Number(row.balance));
    const r2 = await applyWebhookInvoicePayment({ provider: 'Wompi', reference: String(tx.id), row, paid: paidAmount });
    return res.json({ ok: true, verified: true, ...r2 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- APLICACIÓN DE PAGOS POR WEBHOOK v1.1 ----------
// Antes cada webhook repetía la lógica con dos bugs: el anticipo se
// marcaba pagado sin validar el monto ni el estado de la cita y sin
// dejar rastro en caja (pos_sales); y un pago parcial de factura la
// marcaba 'pagado' con saldo 0. Ahora: transacción, monto validado
// contra el anticipo / saldo real, estado por invoiceStatusFor, e
// idempotencia por la referencia del proveedor (un reintento del
// webhook no cobra dos veces).
async function applyWebhookDeposit({ provider, reference, apptId, paid }) {
  const ap = await pool.query('SELECT * FROM appointments WHERE id = $1', [apptId]);
  if (!ap.rows[0]) return { note: 'Anticipo sin cita en el sistema' };
  const cur = ap.rows[0];
  if (['completada', 'cancelada', 'no-show'].includes(cur.status)) return { note: `La cita está ${cur.status}: anticipo no aplicado` };
  if (cur.deposit_status === 'pagado') return { note: 'El anticipo ya estaba pagado', appointment: apptId, deposit: 'pagado' };
  if (paid < Number(cur.deposit_amount)) return { note: `Monto insuficiente: pagó ${paid} y el anticipo es ${cur.deposit_amount}` };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const where = cur.group_id ? 'group_id=$1 AND salon_id=$2' : 'id=$1 AND salon_id=$2';
    await client.query(`UPDATE appointments SET deposit_status='pagado', status=CASE WHEN status='pendiente' THEN 'confirmada' ELSE status END, confirmation_status='confirmada' WHERE ${where}`, [cur.group_id || apptId, cur.salon_id]);
    await client.query(
      `INSERT INTO pos_sales (salon_id, appointment_id, professional_id, client_phone, client_name, items, subtotal, discount, tip_amount, total, payment_methods, document_type, dian_transmitted, cashier_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$7,$8,'anticipo',false,'webhook')`,
      [cur.salon_id, cur.id, cur.professional_id, cur.client_phone, cur.client_name,
       JSON.stringify([{ name: `Anticipo: ${cur.service_name}`, qty: 1, price: Number(cur.deposit_amount) }]), Number(cur.deposit_amount),
       JSON.stringify([{ method: provider.toLowerCase(), amount: Number(cur.deposit_amount), reference: reference || null }])]);
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
  finally { client.release(); }
  await recordEvent('info', 'appointments', `Anticipo pagado por ${provider} para la cita ${apptId} (${paid} COP)`, { appointment_id: apptId });
  notifyUpdate('appointment');
  return { appointment: apptId, deposit: 'pagado' };
}

async function applyWebhookInvoicePayment({ provider, reference, row, paid }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT id FROM payments WHERE invoice_id=$1 AND reference=$2', [row.id, reference]);
    if (dup.rows[0]) { await client.query('ROLLBACK'); return { note: 'Pago ya registrado (webhook repetido)', invoice: row.number }; }
    const inv = await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [row.id]);
    const cur = inv.rows[0];
    if (!cur || cur.status === 'anulado') { await client.query('ROLLBACK'); return { note: 'Factura anulada o inexistente', invoice: row.number }; }
    if (cur.status === 'pagado') { await client.query('ROLLBACK'); return { note: 'Factura ya estaba pagada', invoice: row.number }; }
    const paidAmount = Math.min(paid, Number(cur.balance));
    await client.query('INSERT INTO payments (invoice_id, amount, method, reference) VALUES ($1, $2, $3, $4)', [cur.id, paidAmount, provider, reference]);
    const newBalance = Math.max(0, Number(cur.balance) - paidAmount);
    const status = invoiceStatusFor(Number(cur.total), Number(cur.advances), newBalance);
    await client.query("UPDATE invoices SET balance=$1, status=$2, payment_method=$3 WHERE id=$4", [newBalance, status, provider, cur.id]);
    await client.query('COMMIT');
    await recordEvent('info', 'invoices', `Factura ${cur.number} ${status} por webhook ${provider} (${paidAmount} COP, saldo ${newBalance})`, { invoice: cur.number, transaction_id: reference });
    notifyUpdate('invoice');
    return { invoice: cur.number, status, balance: newBalance };
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
  finally { client.release(); }
}

// PayU: la confirmación trae merchant_id, reference_sale, value, currency,
// state_pol (4 = aprobado) y sign = MD5(apiKey~merchant_id~reference_sale~
// value~currency~state_pol), con value a 1 decimal. Sin PAYU_API_KEY no se
// puede verificar la firma: se registra el evento pero NO se marca pagado.
app.post('/api/webhooks/payu', async (req, res) => {
  if (!dbUrl) return res.status(503).json({ error: 'Base de datos no configurada' });
  try {
    const b = req.body || {};
    const reference = b.reference_sale;
    if (!reference) return res.status(400).json({ error: 'Confirmación PayU sin reference_sale' });
    const apiKey = (process.env.PAYU_API_KEY || '').trim();
    let verified = false;
    if (apiKey && b.sign) {
      const value1 = Number(b.value || 0).toFixed(1);
      const expected = crypto.createHash('md5')
        .update(`${apiKey}~${b.merchant_id}~${reference}~${value1}~${b.currency}~${b.state_pol}`)
        .digest('hex');
      verified = String(b.sign).toLowerCase() === expected;
    }
    await recordEvent(verified ? 'info' : 'warn', 'invoices',
      `Webhook PayU state_pol ${b.state_pol} ref ${reference} (firma ${verified ? 'verificada' : 'NO verificada'})`,
      { reference_sale: reference, state_pol: b.state_pol, verified });
    if (!verified) return res.json({ ok: true, verified: false, note: 'Firma no verificada: evento registrado pero la factura NO se marcó como pagada' });
    if (String(b.state_pol) !== '4') return res.json({ ok: true, verified: true, note: `state_pol ${b.state_pol}: no es aprobado, no se marca pagado` });
    if (String(reference).startsWith('ANT-')) {
      const apptId = Number(String(reference).slice(4));
      const r = await applyWebhookDeposit({ provider: 'PayU', reference: String(b.transaction_id || ''), apptId, paid: Number(b.value || 0) });
      return res.json({ ok: true, verified: true, ...r });
    }
    const inv = await pool.query("SELECT * FROM invoices WHERE number = $1 AND status <> 'anulado'", [reference]);
    if (!inv.rows[0]) return res.json({ ok: true, verified: true, note: 'Factura no encontrada en el CRM' });
    const row = inv.rows[0];
    if (row.status === 'pagado') return res.json({ ok: true, verified: true, note: 'Factura ya estaba pagada' });
    const paidAmount = Math.min(Number(b.value || 0), Number(row.balance));
    const r2 = await applyWebhookInvoicePayment({ provider: 'PayU', reference: String(b.transaction_id || ''), row, paid: paidAmount });
    return res.json({ ok: true, verified: true, ...r2 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Endpoints /api/tasks/* eliminados en v4: ningún componente del frontend
// los llamaba (las tareas solo se cuentan en GET /api/chats con
// pendingTasksCount, y la tabla tasks sigue existiendo para eso).
app.get('/api/templates', async (req, res) => { const r = await pool.query('SELECT * FROM templates ORDER BY id ASC'); res.json(r.rows); });
app.post('/api/templates', async (req, res) => {
  const { id, title, content } = req.body;
  if (id) { await pool.query('UPDATE templates SET title=$1, content=$2 WHERE id=$3', [title, content, id]); } 
  else { await pool.query('INSERT INTO templates (title, content) VALUES ($1, $2)', [title, content]); }
  notifyUpdate('template');
  res.json({ success: true });
});
app.delete('/api/templates/:id', requireAdmin, async (req, res) => {
  const chk = await pool.query('DELETE FROM templates WHERE id=$1 RETURNING id', [req.params.id]);
  if (!chk.rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
  notifyUpdate('template'); res.json({ success: true });
});

app.get('/api/settings', async (req, res) => {
  const r = await pool.query('SELECT * FROM settings');
  const s = {}; r.rows.forEach(row => s[row.key] = row.value);
  // El token de Meta NUNCA se devuelve al frontend (ni siquiera enmascarado:
  // no sale la clave). El frontend sabe si existe por GET /api/wa/meta/status.
  // AUDITORÍA v1.1: se borraban solo el token global, pero los tokens por
  // salón (salon_<id>_meta_wa_token) se devolvían a CUALQUIER usuario
  // autenticado, incluida la estilista. Ahora no sale ningún token.
  delete s['meta_wa_token'];
  for (const k of Object.keys(s)) if (/^salon_\d+_meta_wa_token$/.test(k)) delete s[k];
  // v1.3 (CRM v5.3, bug hunt): el refresh token de Google, el client
  // secret y el token de Telegram tampoco salen a roles que no son admin
  // (antes cualquier usuario autenticado los leía en GET /api/settings).
  const _role = (req.user?.role || '').toLowerCase();
  if (_role !== 'admin' && _role !== 'superadmin') {
    for (const k of Object.keys(s)) if (/google_|telegram_|backup_allow_unencrypted|uploads_max_mb|uploads_user_day_max_mb/.test(k)) delete s[k];
  }
  res.json(s);
});

app.post('/api/settings', settingsLimiter, async (req, res) => {
  const { key, value } = req.body;
  // Sin allow-list cualquier clave (incluidas branding_* o last_backup) se
  // podía pisar desde el frontend. Solo las que el frontend usa de verdad.
  // v5 Facturación/DIAN-ready: NIT y régimen de la empresa y datos de la
  // resolución de facturación. invoice_next_number NO está aquí a propósito:
  // el consecutivo solo lo mueve la creación de facturas, no un formulario.
  // v5 Parte 2B Meta: token y phone number id de WhatsApp Cloud API.
  const ALLOWED_SETTINGS_KEYS = ['reassignment_timeout', 'daily_capacity', 'company_nit', 'company_regime', 'dian_resolution_number', 'dian_resolution_range', 'dian_resolution_date', 'meta_wa_token', 'meta_wa_phone_number_id', 'invoice_default_type', 'google_refresh_token', 'google_calendar_id', 'google_calendar_duration_minutes', 'google_calendar_enabled', 'google_client_id', 'google_client_secret', 'telegram_bot_token', 'telegram_chat_id', 'backup_allow_unencrypted', 'uploads_max_mb', 'uploads_user_day_max_mb'];
  // v1.3: configuración de Google Calendar por salón (salon_<id>_google_*):
  // solo admin y solo del propio salón (el superadmin puede con cualquiera).
  const salonGoogleKey = /^salon_(\d+)_google_(refresh_token|calendar_id|duration_minutes|enabled|client_id|client_secret)$/.exec(key || '');
  if (salonGoogleKey) {
    const sid = Number(salonGoogleKey[1]);
    const role = (req.user?.role || '').toLowerCase();
    if (salonIdNum(req) !== sid && role !== 'superadmin') return res.status(403).json({ error: 'Esa configuración de Google Calendar pertenece a otro salón' });
    if (role !== 'admin' && role !== 'superadmin') return res.status(403).json({ error: 'Solo administradores' });
  } else if (!ALLOWED_SETTINGS_KEYS.includes(key)) return res.status(400).json({ error: `Clave no permitida: ${key}` });
  // (la comprobación de clave permitida está arriba, junto al patrón salon_<id>_google_*)
  // Las claves de Meta son credenciales: solo el admin las escribe.
  if (key.startsWith('meta_wa_') && !isAdminRole(req.user?.role)) {
    return res.status(403).json({ error: 'Solo administradores' });
  }
  // v5.2 Facturación (B6): el tipo de factura por defecto y los datos de
  // la empresa para facturar son solo admin, aunque el asesor (vendedor)
  // ya puede crear facturas y cobrar.
  const ADMIN_ONLY_SETTINGS = new Set(['invoice_default_type', 'company_nit', 'company_regime', 'dian_resolution_number', 'dian_resolution_range', 'dian_resolution_date', 'google_refresh_token', 'google_calendar_id', 'google_calendar_duration_minutes', 'google_calendar_enabled', 'google_client_id', 'google_client_secret', 'telegram_bot_token', 'telegram_chat_id', 'backup_allow_unencrypted', 'uploads_max_mb', 'uploads_user_day_max_mb']);
  if (ADMIN_ONLY_SETTINGS.has(key) && !isAdminRole(req.user?.role)) {
    return res.status(403).json({ error: 'Solo el administrador puede cambiar esa configuración' });
  }
  if (key === 'meta_wa_phone_number_id' && value && !/^\d+$/.test(String(value).trim())) {
    return res.status(400).json({ error: 'El phone number id de Meta debe ser solo dígitos' });
  }
  // v1.3 (CRM v5.3.34): validaciones del opt-in de respaldo sin cifrar y
  // de las cuotas de disco, y de la duración del evento de Google Calendar.
  if (key === 'backup_allow_unencrypted' && value && !['true', 'false'].includes(String(value).trim())) {
    return res.status(400).json({ error: "backup_allow_unencrypted debe ser 'true' o 'false'" });
  }
  if (key === 'uploads_max_mb' && value && (!/^\d+$/.test(String(value).trim()) || +value < 10 || +value > 100000)) {
    return res.status(400).json({ error: 'uploads_max_mb debe ser un número entre 10 y 100000 MB' });
  }
  if (key === 'uploads_user_day_max_mb' && value && (!/^\d+$/.test(String(value).trim()) || +value < 1 || +value > 10000)) {
    return res.status(400).json({ error: 'uploads_user_day_max_mb debe ser un número entre 1 y 10000 MB' });
  }
  if ((key === 'google_calendar_duration_minutes' || (salonGoogleKey && salonGoogleKey[2] === 'duration_minutes')) && value && (!/^\d+$/.test(String(value).trim()) || +value < 15 || +value > 1440)) {
    return res.status(400).json({ error: 'La duración del evento de Google Calendar debe estar entre 15 y 1440 minutos' });
  }
  // v5.1 El tipo de factura por defecto solo admite los dos tipos válidos.
  if (key === 'invoice_default_type' && value && !INVOICE_TYPES.includes(String(value).trim())) {
    return res.status(400).json({ error: "invoice_default_type debe ser 'normal' o 'electronica'" });
  }
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  notifyUpdate('settings');
  res.json({ success: true });
});

// ---------- MARCA BLANCA ----------
// Se guarda en la tabla settings (key/value) con claves branding_*.
const BRANDING_DEFAULTS = {
  company_name: 'SalonOS',
  tagline: 'Sistema multisalón para estilistas y manicuristas',
  logo_url: '',
  primary_color: '#0284c7',
  secondary_color: '#0ea5e9',
};
const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

app.get('/api/settings/branding', async (req, res) => {
  try {
    // Con contexto de salón, la marca es la DEL SALÓN (tabla salons),
    // no la global de la plataforma.
    const sid = salonIdNum(req);
    if (sid) {
      const s = await pool.query('SELECT name AS company_name, logo_url, primary_color, secondary_color FROM salons WHERE id=$1', [sid]);
      if (s.rows[0]) return res.json({ ...BRANDING_DEFAULTS, tagline: 'Sistema multisalón para estilistas y manicuristas', ...s.rows[0] });
    }
    const r = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'branding_%'");
    const out = { ...BRANDING_DEFAULTS };
    r.rows.forEach((row) => { out[row.key.replace('branding_', '')] = row.value; });
    res.json(out);
  } catch (err) {
    // Sin DB: devolver los valores por defecto para que el login se vea bien.
    res.json({ ...BRANDING_DEFAULTS });
  }
});

app.put('/api/settings/branding', requireAdmin, async (req, res) => {
  const { company_name, tagline, primary_color, secondary_color } = req.body || {};
  if (primary_color && !isHexColor(primary_color)) return res.status(400).json({ error: 'primary_color debe ser hexadecimal (#RRGGBB)' });
  if (secondary_color && !isHexColor(secondary_color)) return res.status(400).json({ error: 'secondary_color debe ser hexadecimal (#RRGGBB)' });
  const values = { company_name, tagline, primary_color, secondary_color };
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`branding_${k}`, String(v)]);
    }
    notifyUpdate('settings');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
app.post('/api/settings/logo', requireAdmin, uploadLimiter, uploadQuotaGuard, logoUpload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sube un archivo de imagen' });
  if (!['image/png', 'image/jpeg'].includes(req.file.mimetype)) return res.status(400).json({ error: 'Solo PNG o JPG' });
  // v1.3 (H-M11): el logo también cuenta para la cuota total de uploads/
  // (el viejo se borra justo después, así que la comprobación es
  // conservadora por el tamaño del logo anterior, 2 MB como mucho).
  const logoMaxTotal = await getUploadsMaxBytes();
  if (dirSizeBytes(uploadsDir()) + req.file.buffer.length > logoMaxTotal) {
    return res.status(413).json({ error: `Cuota de almacenamiento llena (${fmtMB(logoMaxTotal)}). Borra archivos o amplía UPLOADS_MAX_MB.` });
  }
  const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  try {
    for (const old of ['logo.png', 'logo.jpg']) {
      const p = path.join(uploadsDir(), old);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.writeFileSync(path.join(uploadsDir(), `logo.${ext}`), req.file.buffer);
    if (req.user?.id != null) addUserDayUsage(req.user.id, req.file.buffer.length);
    const logoUrl = `/uploads/logo.${ext}`;
    await pool.query("INSERT INTO settings (key, value) VALUES ('branding_logo_url', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [logoUrl]);
    notifyUpdate('settings');
    res.json({ success: true, logo_url: logoUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- GOOGLE CALENDAR (v1.3, CRM v5.3, adaptado a salón) ----------
// Al agendar/reprogramar/cancelar una CITA se crea/actualiza/borra el
// evento en el calendario del salón/profesional. La duración es la del
// SERVICIO (no 2 h fijas como en limpieza) y la zona es America/Bogota.
// La configuración es POR SALÓN (settings salon_<id>_google_*); si el
// salón no tiene, se usan las variables de entorno de la instalación.
// Sin credenciales el salón funciona exactamente igual: sync es un no-op
// que devuelve el motivo, nunca rompe la cita ni el arranque.
let googleApisLib = null;
let googleApisTried = false;
async function loadGoogleApis() {
  if (googleApisTried) return googleApisLib;
  googleApisTried = true;
  try {
    const mod = await import('googleapis');
    googleApisLib = mod.google || mod.default?.google || null;
  } catch { googleApisLib = null; }
  return googleApisLib;
}
async function getGoogleCalendarConfig(salonId) {
  const sid = salonId ? String(salonId) : '';
  const get = async (key, envVal) => {
    const v = sid ? (await getSettingValue(`salon_${sid}_${key}`, '')) : '';
    return (v || '').trim() || envVal;
  };
  const enabledRaw = sid ? (await getSettingValue(`salon_${sid}_google_calendar_enabled`, '')) : '';
  const enabled = String(enabledRaw || '').trim().toLowerCase() === 'true'
    || (!enabledRaw && (process.env.GOOGLE_CALENDAR_ENABLED || '').trim().toLowerCase() === 'true');
  const clientId = await get('google_client_id', GOOGLE_CLIENT_ID);
  const clientSecret = await get('google_client_secret', GOOGLE_CLIENT_SECRET);
  const refreshToken = await get('google_refresh_token', GOOGLE_REFRESH_TOKEN_ENV);
  const calendarId = (await get('google_calendar_id', GOOGLE_CALENDAR_ID_ENV)) || 'primary';
  const durationRaw = await get('google_calendar_duration_minutes', process.env.GOOGLE_CALENDAR_DURATION_MINUTES || '');
  const durationMinutes = Math.min(1440, Math.max(15, parseInt(durationRaw || '60', 10) || 60));
  return { enabled, clientId, clientSecret, refreshToken, calendarId, durationMinutes };
}
async function getGoogleCalendarClient(salonId) {
  const cfg = await getGoogleCalendarConfig(salonId);
  const google = await loadGoogleApis();
  if (!google) return { client: null, cfg, reason: 'googleapis no instalado (npm install)' };
  if (!cfg.enabled) return { client: null, cfg, reason: 'Google Calendar apagado para este salón' };
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) return { client: null, cfg, reason: 'Faltan credenciales de Google (client id/secret/refresh token)' };
  try {
    const auth = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
    auth.setCredentials({ refresh_token: cfg.refreshToken });
    return { client: google.calendar({ version: 'v3', auth }), cfg, reason: null };
  } catch (e) { return { client: null, cfg, reason: e.message }; }
}
// La fecha de Postgres llega como Date (medianoche UTC = mismo día
// calendario) o como 'YYYY-MM-DD'; la hora como 'HH:MM:SS' o 'HH:MM'.
function googleDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s.slice(0, 10);
}
function buildGoogleCalendarEvent(appt, durationMinutes) {
  const d = googleDateStr(appt.date);
  let t = String(appt.start_time || '08:00').slice(0, 5);
  if (!/^\d{1,2}:\d{2}$/.test(t)) t = '08:00';
  const [hh, mm] = t.split(':').map(Number);
  const [y, mo, dd] = d.split('-').map(Number);
  const start = new Date(y, (mo || 1) - 1, dd || 1, hh || 0, mm || 0);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}:00`;
  const who = appt.professional_name ? ` con ${appt.professional_name}` : '';
  return {
    summary: `${appt.service_name || 'Cita'} — ${appt.client_name || 'Cliente'}${who}`,
    description: `Cita de salón: ${appt.service_name || ''}\nClienta: ${appt.client_name || ''} (${appt.client_phone || ''})\nProfesional: ${appt.professional_name || ''}\nEstado: ${appt.status || ''}`,
    start: { dateTime: fmt(start), timeZone: 'America/Bogota' },
    end: { dateTime: fmt(end), timeZone: 'America/Bogota' },
  };
}
async function syncAppointmentToCalendar(salonId, appt) {
  try {
    if (!appt || !appt.date || !appt.start_time) return { synced: false, reason: 'Cita sin fecha u hora' };
    const { client, cfg, reason } = await getGoogleCalendarClient(salonId);
    if (!client) return { synced: false, reason };
    const duration = Number(appt.duration_minutes) || cfg.durationMinutes;
    const event = buildGoogleCalendarEvent(appt, duration);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let eventId = appt.google_calendar_event_id || null;
    try {
      if (eventId) {
        await client.events.patch({ calendarId: cfg.calendarId, eventId, resource: event, signal: ctrl.signal });
      } else {
        const ins = await client.events.insert({ calendarId: cfg.calendarId, resource: event, signal: ctrl.signal });
        eventId = ins.data?.id || null;
      }
    } finally { clearTimeout(timer); }
    if (eventId && appt.id) {
      await pool.query('UPDATE appointments SET google_calendar_event_id=$1 WHERE id=$2 AND salon_id=$3', [eventId, appt.id, salonId]).catch(() => {});
    }
    return { synced: true, eventId };
  } catch (e) {
    return { synced: false, reason: e.message };
  }
}
async function deleteAppointmentFromCalendar(salonId, appt) {
  try {
    if (!appt?.google_calendar_event_id) return { deleted: false, reason: 'Sin evento de Google Calendar' };
    const { client, cfg, reason } = await getGoogleCalendarClient(salonId);
    if (!client) return { deleted: false, reason };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      await client.events.delete({ calendarId: cfg.calendarId, eventId: appt.google_calendar_event_id, signal: ctrl.signal });
    } catch (e) {
      if (e.code === 404 || e.code === 410) return { deleted: true, reason: 'El evento ya no existía en Google' };
      throw e;
    } finally { clearTimeout(timer); }
    if (appt.id) await pool.query('UPDATE appointments SET google_calendar_event_id=NULL WHERE id=$1 AND salon_id=$2', [appt.id, salonId]).catch(() => {});
    return { deleted: true };
  } catch (e) {
    return { deleted: false, reason: e.message };
  }
}
async function testGoogleCalendar(salonId) {
  const { client, cfg, reason } = await getGoogleCalendarClient(salonId);
  if (!client) return { ok: false, reason };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r;
    try {
      r = await client.events.list({ calendarId: cfg.calendarId, maxResults: 1, singleEvents: true, orderBy: 'startTime', timeMin: new Date().toISOString(), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    return { ok: true, calendarId: cfg.calendarId, durationMinutes: cfg.durationMinutes, nextEvent: r.data?.items?.[0] ? { summary: r.data.items[0].summary, start: r.data.items[0].start } : null };
  } catch (e) { return { ok: false, reason: e.message }; }
}
async function googleCalendarStatus(salonId) {
  const cfg = await getGoogleCalendarConfig(salonId);
  const google = await loadGoogleApis();
  const base = { enabled: cfg.enabled, configured: Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken), calendarId: cfg.calendarId, durationMinutes: cfg.durationMinutes, googleapisInstalled: Boolean(google) };
  if (!base.configured) return { ...base, ok: false, reason: cfg.enabled ? 'Faltan credenciales de Google para este salón' : 'Google Calendar apagado para este salón' };
  return { ...base, ok: true };
}

// ---------- SalonOS v1: rutas multisalón (ver salon-routes.js) ----------
const salonApi = registerSalonRoutes(app, {
  pool, jwt, jwtSecret, bcrypt, normalizePhoneCO, normalizePhoneString,
  sendWhatsAppMessage, getMetaConfig, recordEvent, notifyUpdate, logger, getSettingValue,
  hasDb: () => !!dbUrl,
  googleCalendar: { syncAppointmentToCalendar, deleteAppointmentFromCalendar, googleCalendarStatus, getGoogleCalendarConfig, testGoogleCalendar },
});

// Bot de reservas por WhatsApp v1.1 (bot-engine.js + bot-store.js): un solo
// motor para QR y Meta. El salón se resuelve por instancia/número, nunca por
// el contenido del mensaje. Apagado por defecto en salones nuevos.
try {
  botEngine = createBotEngine({
    pool,
    store: new PgBotStore(pool, salonApi?.bot),
    send: sendWhatsAppMessage,
    logger,
  });
  logger.info(`Bot de reservas SalonOS v${APP_VERSION} listo (QR + Meta, apagado por defecto por salón)`);
} catch (e) {
  logger.error('No se pudo crear el bot de reservas', e);
}

// /api desconocida -> JSON 404 (antes devolvía el index.html del SPA).
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint no encontrado' }));
// Archivos sensibles: nunca servir el código fuente ni la configuración.
app.get(['/server.js', '/package.json', '/package-lock.json', '/.env', '/.env.example', '/Dockerfile', '/docker-compose.yml', '/vite.config.ts', '/tsconfig.json', '/.dockerignore'], (req, res) => res.status(404).send('Not found'));

app.use(express.static(path.join(__dirname, 'dist')));

// Middleware de Manejo de Errores Centralizado
app.use((err, req, res, next) => {
  logger.error(`Error en ${req.method} ${req.path}`, err);
  res.status(err.status || 500).json({
    error: err.message || 'Error interno del servidor',
    timestamp: new Date().toISOString()
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

server.listen(PORT, () => {
  console.log(`🚀 SalonOS v1 multisalón ON :${PORT}`);
  
  // AUDITORÍA v1.1: al arrancar se restauran las instancias guardadas en
  // wa_instances (antes la tabla se escribía pero nunca se leía: tras un
  // reinicio no había ninguna instancia hasta crearla a mano). Las Meta
  // se registran como virtuales; las QR inician su cliente.
  if (dbOk) {
    pool.query('SELECT id, name, channel, salon_id FROM wa_instances ORDER BY id').then((r) => {
      for (const row of r.rows) initWhatsApp(row.id, row.name || row.id, row.channel || 'qr', row.salon_id || null).catch((e) => logger.error(`No se pudo restaurar WhatsApp ${row.id}`, e));
    }).catch(() => { /* sin tabla aún */ });
  }
});
