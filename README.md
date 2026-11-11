# SalonOS v1.3 — Sistema multisalón tipo AgendaPro para estilistas y manicuristas (Colombia)

Sistema de gestión para salones de belleza y nail spas, **multi-salón y marca blanca**,
basado en el CRM v5.2 (React 19 + Vite + Express + PostgreSQL, WhatsApp QR con
whatsapp-web.js + Meta Cloud API, facturación, Wompi/PayU, roles, monitoreo y respaldo).

> **Versión 1.3.0 (2026-11-09).** Port completo de TODAS las correcciones del CRM Purifica v5.3–v5.3.34 a salón (seguridad, Google Calendar, limitadores por usuario, chat paginado, WhatsApp endurecido, respaldo fail-closed + cuota de disco, Railway/VPS). La carpeta `salon-v1-2/` **no se tocó**: esta es una copia completa en `salon-v1-3/`.

> **Versión 1.2.0 (2026-11-07).** Métodos de pago separados en la caja. La carpeta `salon-v1-1/` **no se tocó**: esta es una copia completa en `salon-v1-2/`.

## Novedades de la v1.3 — port del CRM v5.3–v5.3.34 a salón

La v1.3 no trae funciones nuevas de cara a la clienta: trae **todo el endurecimiento que el CRM de limpieza recibió después de v5.2**, adaptado a salones. Fuente: diff archivo por archivo entre `crm-v5-2/` y `crm-v5-3-34/` (47 archivos, 10 624 inserciones). La v5.3.34 **sí está completa** (al inicio se creyó en curso, pero su carpeta ya dice 5.3.34 y el diff 33→34 existe): H-M8 y H-M11 **sí se portaron**, no quedan como pendientes.

### Seguridad — auditoría CRM v5.3.28 (43 hallazgos), 5 altos corregidos en v5.3.29/30
- **H-A1 — facturas con alcance**: el atajo `already_exists` de `POST /api/invoices` re-lee la factura con `AND salon_id = $2` (antes devolvía la factura de otro salón). Todos los endpoints de salón exigen `salon_id` desde el JWT.
- **H-A2 — nombre de profesional único por salón**: `POST` y `PUT /api/staff` rechazan (400) un nombre duplicado entre profesionales activas del mismo salón; la migración renombra los duplicados viejos a `Nombre (2)`, `(3)`… e instala un índice único parcial `(salon_id, LOWER(TRIM(name)))`. También se rechaza el correo duplicado en `PUT`.
- **H-A3 — sin contenido de mensajes en logs**: el log de WhatsApp entrante ya solo guarda remitente, tipo y longitud, nunca el texto.
- **H-A4 — `TRUST_PROXY` configurable**: `app.set('trust proxy', TRUST_PROXY === '1' ? 1 : 0)` (antes fijo; con proxy en compose bloqueaba mal).
- **H-A5 — sin clave por defecto**: el seed del superadmin **se niega a arrancar** si la clave es `cambia-esta-clave` o tiene menos de 12 caracteres. `install.sh` genera una clave aleatoria de 20 caracteres si no se escribe nada (también para Postgres) y la muestra. Crear/cambiar claves rechaza las débiles (mín. 8, lista de comunes).
- **JWT en cookie HttpOnly** (`salon_token`, `SameSite=Strict`; Bearer sigue como respaldo) + **`token_version` en `employees`**: logout y cambio de clave revocan **todas** las demás sesiones (el JWT viejo da 401). Sin DB o con error de consulta, la autenticación falla cerrada (503). Login: 5 fallos por correo+IP en 10 min → 429 por 15 min. Nuevos endpoints: `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/change-password`. El token de salón también es cookie (1 h) y `POST /api/salons/exit` restaura la cookie de superadmin guardada.
- **`GET /api/settings` sin secretos para no-admin**: las claves Google/Telegram/respaldo/cuota no salen a recepcionista ni a profesionales. Las claves Google por salón (`salon_<id>_google_*`) solo las escribe el admin de ese salón o el superadmin. **Corregido en v1.3 (bug encontrado en pruebas)**: el superadmin quedaba bloqueado (403) de los ajustes solo-admin (`backup_allow_unencrypted`, cuotas, claves globales) porque la guarda pedía rol `admin` exacto; ahora acepta `admin` o `superadmin` (`isAdminRole`).
- **Deletes con rol y 404**: plantillas, leads, recordatorios e instancias de WhatsApp solo los borra el admin (403 si no) y devuelven 404 si no existen. `POST /api/services/update-deal`: estilista/manicurista/operator → 403 (era el pendiente D9 de v1.1, cerrado).
- **`/api/health` con detalle solo para admin**: sin sesión solo `{ok, version}`; con JWT de admin, detalle de DB, WhatsApp y disco.

### Limitadores por usuario + pool — prueba de estrés CRM v5.3.30
- Limitadores **por USUARIO** (`user:<id>`, si no hay sesión la IP), no por IP: con 30 personas en la misma oficina ya no se bloquean entre sí. API 600/15 min, envío WhatsApp 60, ajustes 30, subidas 10, webhook 300.
- Pool Postgres `max: 25, min: 2` + timeouts (antes 10).
- **Chat con tope de 50 mensajes por conversación** + endpoint paginado `GET /api/chats/:id/messages?before=<id>&limit=` (máx. 200) y botón **"Cargar mensajes anteriores"** en el inbox. `POST /api/chats/:id/read` marca leída de verdad.
- **Refresco por último mensaje (v5.3.31)**: el inbox se actualiza cuando cambia `lastMessageId`, **no** el conteo (con el tope de 50 el conteo dejaba de cambiar y las imágenes no aparecían hasta refrescar). Los mensajes propios muestran `enviando…` o `⚠️ sin confirmar`.

### Google Calendar por salón — CRM v5.3, adaptado
- Al crear, reprogramar o cancelar una **cita de salón** se crea/actualiza/borra el evento en **el calendario de ese salón** (nunca se mezclan salones). Duración = **duración del servicio** (no 2 h fijas de limpieza), zona `America/Bogota`.
- Credenciales por salón (`salon_<id>_google_*` en ajustes; si no, variables globales `GOOGLE_*`). Endpoints: `GET /api/salon/calendar/status`, `POST /api/salon/calendar/config`, `POST /api/salon/calendar/test`, `POST /api/salon/calendar/sync` (próximas 30 días), `POST /api/salon/appointments/:id/sync-calendar`.
- **Sin credenciales el salón sigue funcionando igual**: la cita se crea, queda pendiente de sincronizar y se registra un aviso (nunca rompe la cita). Script `scripts/get-google-refresh-token.js` para sacar el refresh token.
- Nueva columna `appointments.google_calendar_event_id` (un evento por grupo de 4 manos).

### WhatsApp — lecciones de integración en vivo (CRM en Railway)
- **Conectado ≠ listo**: el estado distingue `authenticated` (autenticado, aún no listo) de `ready` (vivo). Una instancia `authenticated` más de 5 min sin llegar a `ready` genera evento de aviso + alerta. `GET /api/wa/meta/status` sonda de verdad la Graph API (`live`, `liveError`): `configured` ya no significa "vivo".
- **Evento crudo logueado antes de filtrar** (remitente, tipo, media, ids; nunca el contenido), en QR y en el webhook de Meta.
- **Media entrante que no se descarga ya no se descarta**: se guarda el mensaje con etiqueta (QR: `msg.downloadMedia()` a `/uploads/wa-media`; Meta: `downloadMetaMedia` por Graph API, best-effort 15 s).
- **Anti-duplicado antes de reintentar**: un envío igual de `agent` con estado `enviado` en los últimos 5 min no se vuelve a mandar (en el flush de la cola: últimos 10 min por conversación). Un reintento de un envío **fallido** sí se vuelve a intentar.
- **Un envío sin confirmación es `sin_confirmar`, no `enviado`**: el mensaje pasa por `enviando` y solo queda `enviado` si WhatsApp lo confirma. El flush de la cola (`POST /api/salon/wa/flush`) cuenta intentos (`attempts`, `last_error`) y a los 5 intentos queda `fallido`; los fallos intermedios se quedan `pendiente` para reintentarse (nada se pierde).
- `bot-engine.js`: `say()` ahora devuelve `{replied:false, error}` si el envío no se confirma; antes tragaba el error y decía que sí había respondido.
- `/uploads/wa-media` protegido con sesión (cookie o Bearer) + cabeceras nosniff/sandbox; el logo sigue público.

### Respaldo — v5.3.32/33 + fail-closed y cuota v5.3.34
- **pg_dump 18** en el Dockerfile (el 15 se negaba a respaldar el Postgres 18 de Railway: "server version mismatch"; el 18 también respalda servidores 16).
- Respaldos en el **volumen persistente** (`/app/data/backups` en Railway, `./backups` en VPS) + botón **Descargar** solo para admin (nombre validado, sin traversal; 400 ante `../`, 401 sin sesión). El nombre lleva **segundos** (antes dos respaldos en el mismo minuto compartían nombre y un intento fallido borraba el bueno).
- **H-M8 fail-closed**: sin `BACKUP_ENCRYPTION_KEY` válida el respaldo **FALLA** (500, borra el plano, `lastBackup ok:false` persistido, evento de error + alerta Telegram). Con clave válida produce `.enc` (AES-256-GCM `[IV 16B][cifrado][tag 16B]`, se descifra con `scripts/decrypt-backup.js`) y borra el plano. Opt-in explícito `BACKUP_ALLOW_UNENCRYPTED=true` o checkbox en Estado del Sistema permite el plano, pero con evento + alerta en **cada** respaldo sin cifrar. El script `scripts/backup-compose.js` tiene el mismo comportamiento.
- **El respaldo sigue SIN cifrar si no hay clave y hay opt-in: no se finge cifrado.** La tarjeta de Estado del Sistema muestra "SIN cifrar" o "🔒 cifrado".
- **H-M11 cuota de disco**: `uploadLimiter` 10/15 min por usuario; cuota total `uploads/` 300 MB + 100 MB por usuario/día (configurable con `uploads_max_mb` / `uploads_user_day_max_mb`; **413** al superar). Limpieza diaria de huérfanos (solo archivos no referenciados de más de 30 días, nunca `logo.png`; endpoint manual `POST /api/system/cleanup-uploads`, solo admin). Alerta de disco al **80 %** (throttle 1 h, % visible en Estado del Sistema).
- Respaldo diario 02:00 + limpieza de huérfanos tras él.

### Seguimiento de retoque e inactivas — FollowUps del CRM, traducido a salón
- **Retoque por ciclo**: cada servicio del catálogo tiene "Retoque cada (días)". `GET /api/salon/retouches/due` lista las citas completadas con el ciclo cumplido y sin recordatorio (últimos 180 días). `POST /api/salon/retouches/:id/send` manda el recordatorio por WhatsApp (QR y luego Meta) con plantilla configurable (`salon_<id>_retouch_message`, `{nombre} {dias} {servicio} {salon}`) y marca `reminded_retouch_at` **solo si se envió** (400 si ya se envió). Nueva vista **"Retoques y seguimiento"** en el menú (admin/recepcionista).
- **Clientas inactivas**: `GET /api/salon/clients/inactive?days=` (defecto 45, 7–365) con selector 30/45/60/90 días y botón "Abrir chat".
- **Sin campañas masivas**: el bot prohíbe el spam; solo mensajes 1 a 1 a clientas con cita o inactivas. No hay endpoint de envío masivo.

### Railway / VPS — CRM v5.3.1
- `railway.json`, `Dockerfile` multi-etapa como usuario `node`, `HEALTHCHECK` con `${PORT:-3000}` (no 3000 fijo), `entrypoint.sh` con dueño correcto del volumen.
- `docker-compose.yml` con perfiles (app, db, backup manual) y `scripts/backup.sh` / `backup.bat`.
- Guía de despliegue abajo (Railway con plugin Postgres + `DATABASE_URL` + volumen `/app/.wwebjs_auth` para que la sesión QR no se borre en cada despliegue; VPS con docker-compose).

### Anticipo OPCIONAL — añadido a la v1.3 (pedido de Alejandro)
El anticipo nunca fue obligatorio en el código, pero nada lo dejaba explícito: ahora sí, y es verificable.
- **Regla**: el % efectivo de un servicio es su `deposit_pct` si está fijado; si es `NULL`, el `default_deposit_pct` del salón; si no hay ninguno, 20 %. **Con 0 % la cita nace `confirmada`**: sin pedir pago, sin mandar link y sin quedar pendiente.
- **Política**: con 0 % el texto de la cita dice "Sin anticipo: la cita queda confirmada sin pago. Cancelación gratuita hasta 48 h antes; si cancelas con menos tiempo, avísanos para liberar el hueco (no hay anticipo que reembolsar)." Con % > 0 sigue la política actual.
- **Dónde se fija**: formulario de servicio (campo "Anticipo (%)", 0–100, 0 = sin anticipo; validado en POST y PUT, 400 fuera de rango) y nueva vista **Ajustes del salón** (`GET /api/salons/me` + `PUT /api/salons/me/settings`, solo admin del salón; la recepcionista recibe 403). El formulario de servicio también permite asignar profesionales (vacío = todas).
- **Bot**: cuando el anticipo es 0 el bot se salta el paso de pago y confirma directo ("¡Listo! ✅ Tu cita está confirmada."). Con % > 0 pide el pago como siempre (el bot ahora usa el default del salón cuando el servicio no fija %, antes ignoraba ese default).
- **Nunca hay link de $0**: `deposit-link` y el anticipo manual devuelven 400 en una cita sin anticipo. La reserva pública muestra "Sin anticipo: la cita se confirma sin pago." y su pantalla final dice "Sin anticipo: tu cita quedó confirmada".
- **Verificado** (`scripts/test-v13-deposito-disponibilidad.mjs`): servicio 0 % → cita interna y pública `confirmada`, `deposit_amount` 0, política "Sin anticipo"; servicio sin % + default 0 → confirmada; servicio sin % + default 20 → `pendiente` con anticipo 20 %; servicio 0 % manda sobre default 20.

### Disponibilidad por profesional — añadido a la v1.3 (pedido de Alejandro)
Al crear una profesional (rol estilista/manicurista, horario, servicios) su disponibilidad sale **automática** en Agenda, en Hoy y en la reserva/bot, porque los huecos se calculan desde su horario + sus citas (sin cruces, con 15 min de limpieza entre citas).
- **Nuevo endpoint** `GET /api/salon/professionals/availability` (cualquier rol del salón; sin token 401; una profesional solo se ve a sí misma con `ownOnly`): por cada profesional, `{status, label, busyUntil, appointmentsToday, isOnline}`. Estados: `disponible` → "Disponible ahora"; `ocupada` → "Ocupada hasta las HH:MM" (fin de la cita que cubre ahora); `fuera_horario` → "Fuera de horario (HH:MM–HH:MM)"; `sin_horario` → "Sin horario definido". La hora es la de Bogotá. **No se inventa disponibilidad**: sin horario ese día, el estado es `sin_horario`; sin citas y dentro de su horario, es disponible.
- **Horario**: nueva vista en **Equipo** (botón "Horario" por profesional, solo admin): filas Lun–Dom con hora de inicio y fin; día vacío = no trabaja ese día (se guarda `["",""]` para que no aplique el horario por defecto Lun–Sáb 09:00–19:00, Dom cerrado, que sigue vigente para profesionales que nunca guardaron horario). El editor muestra ese horario efectivo al abrirlo. Endpoint `PUT /api/salon/professionals/:id/schedule` (solo admin).
- **Dónde se ve**: insignia por profesional en **Equipo** (con "· sin conexión" si su `is_online` manual está apagado), tira de disponibilidad en **Hoy**, etiqueta en el selector de profesional de **Agenda** (solo para la fecha de hoy), y servicios que hace cada una en Equipo. En Agenda y en la reserva pública el servicio muestra "sin anticipo" cuando su % es 0. La vista de servicio del catálogo muestra las profesionales asignadas.
- **Huecos**: `computeSlots` ya los calculaba desde horario + citas y lo usan Agenda, reserva pública y bot; la verificación nueva confirma que el hueco ocupado no se ofrece (10:00–11:00 ocupada → 10:00 no sale, 11:15 sí) y que un servicio asignado a una sola profesional solo ofrece sus huecos.
- **Verificado** (`scripts/test-v13-deposito-disponibilidad.mjs`, 47/47): 4 profesionales (ocupada ahora / libre / horario ya terminado / sin horario) con las 4 etiquetas correctas; huecos sin cruces; asignación por servicio.

### Bugs latentes de v1.2 encontrados por las pruebas de v1.3 (corregidos aquí)
Las pruebas con Postgres real de esta versión destaparon tres INSERTs que **nunca funcionaron con una base de datos real** (en v1–v1.2 solo se verificó `tsc` + build + arranque sin DB, nunca una cita real):
1. **Reserva pública** (`POST /api/public/reserva/:slug`): el INSERT tenía 25 valores para 24 columnas y referenciaba `$21` con solo 20 parámetros → **500 siempre**. La reserva online, función central del producto, estaba rota desde v1.
2. **Creación interna de citas** (`createAppointmentTx`, usada por Agenda y por el bot): 25 valores para 24 columnas, `$23` inexistente → **500 siempre**.
3. **Venta POS** (`POST /api/salon/pos/sale`): 12 parámetros para un INSERT que pide 13 (`tip_professional_id` sin valor) → **500 siempre**. La caja no podía vender productos.
Los otros dos INSERTs de `pos_sales` (anticipo y completar cita) sí estaban bien y no se tocaron. Además: `GET /api/salon/clients/inactive` fallaba con `date <= integer` (Postgres infería el parámetro `$2` como fecha en `CURRENT_DATE - $2`); ahora usa `CURRENT_DATE - ($2 * INTERVAL '1 day')`.

### Lo que NO se portó del CRM (no aplica a salón)
- **Pipeline de leads de limpieza** y campos de servicios de limpieza (`technical_images`, `client_signature`, garantía…): solo de limpieza.
- **Facturación DIAN Normal/Electrónica y webhooks Wompi/PayU como dominio del CRM**: en salón solo existen el link de anticipo y el webhook que ya tenía v1.2. El DEE POS real con CUFE sigue siendo el pendiente nº 1 (ver abajo).
- **Escalafones de comisión por rol/rango, capacidad diaria y reasignación**: lógica de equipos de limpieza, no de profesionales de salón (aquí la comisión es por servicio/profesional, congelada al agendar).
- **Campañas masivas** (tope 100, pausa 8 s): no se portan; el bot prohíbe spam. Solo retoques 1 a 1 e inactivas.
- **Limpieza de caché de WhatsApp** (v5.3.16) como endpoint propio: no se portó (no hay endpoint equivalente; la sesión QR vive en el volumen).
- **`multer 2.x`** del CRM: el salón sigue en 1.4.5; no hizo falta.
- Valores de marca "Purifica", `BusinessDeals` y roles `admin/sales_agent/operator` como tales: el patrón de alcance sí aplica, los nombres de limpieza no.
- `AuditModule.tsx` (eliminado en el CRM): no existe en salón.

### Verificación hecha en v1.3 (2026-11-09, Postgres 16 real en local)
- `npx tsc --noEmit`: **sin errores**. `npm run build`: **OK en 13.96 s** (aviso de chunk > 500 kB, igual que antes).
- Arranque **sin DB** (`PORT=3219 node server.js`): `/` **200**, `/api/health` **200** (`{ok:true, version:"1.3.0"}`), `/api/salon/appointments`, `/api/chats`, `/api/system/backup/download` sin token: **401** en todos.
- **Suite API con Postgres real — 70/70** (`/tmp/test-v13.mjs`, scripts guardados en `scripts/test-v13-api.mjs`): login con cookie HttpOnly; 5 fallos → 429; crear salón + token de salón + exit a superadmin; nombre de profesional duplicado → 400; clave débil → 400; email duplicado en PUT → 400; servicio con `retouchDays` 21; cita interna 201 + reserva pública 201 (las dos rutas rotas, ahora funcionan); cita sin evento de Google sin credenciales (sin romper); reprogramar + cancelar; calendario `status`/`test` → `ok:false` con motivo; chat con 60 mensajes → tope 50 + `hasMoreMessages` + paginación (10 anteriores con `before`) + marcar leída; envío sin WhatsApp → `sin_confirmar` (no `enviado`); reintento de fallido se reintenta; mensaje ya enviado → `duplicate:true` sin duplicar fila; `POST /api/settings` 31 veces → 429 por usuario; cambio de clave revoca el token viejo (401); clave Google por salón visible para el admin del salón e invisible para recepcionista; deletes con rol y 404; factura `already_exists` con alcance; retoque pendiente listado y envío sin WhatsApp → 502 sin marcar enviado; clienta inactiva listada; respaldo `.enc` en volumen + descarga 200 + traversal 400 + sin auth 401 + descifrado a SQL válido; logout revoca (401).
- **Fail-closed + deduplicación — 10/10** (`scripts/test-v13-failclosed.mjs`, servidor sin `BACKUP_ENCRYPTION_KEY`): respaldo sin clave → 500 sin archivo en plano + `lastBackup ok:false` persistido; opt-in → 200 en plano con `encrypted:false`; duplicado viejo renombrado a `María Pérez (2)` al arrancar con el índice recreado. El test crea su propio salón (antes asumía `salon_id=2` de otra suite) y resetea el opt-in al inicio para ser idempotente.
- **POS + flush + cuota — 12/12** (`scripts/test-v13-extra.mjs`): venta mixta Nequi $40.000 + Bre-B/Llave Nu $40.000 = $80.000 (201, stock 10→9); cierre por método suma +$40.000 en cada método; flush sin WhatsApp → 0 enviados, intentos contados (`attempts=1`, `last_error` guardado) y el mensaje sigue `pendiente`; logo de 2 MB con cuota de 1 MB/día → **413**; superadmin ya puede cambiar la cuota.
- **Unitarios sin regresión**: `scripts/test-payment-methods.mjs` **28/28** (9 métodos, mixto, cierre, mapeo legacy); `scripts/test-bot-engine.mjs` **17/17** (bot apagado = silencio; `bot_enabled=false` por defecto en salones nuevos, verificado en DB; caso nuevo 4b: servicio con anticipo 20 % muestra "Anticipo: $30.000 (20 %)" y tras SÍ manda link Wompi + cita `pendiente`).
- **Anticipo opcional + disponibilidad — 47/47** (`scripts/test-v13-deposito-disponibilidad.mjs`, Postgres real): ver detalle en las secciones de arriba. Las tres suites de API no son idempotentes entre sí si se corren en la misma DB (correos de personal compartidos): cada una usa sus propios correos `@deposito.local` / `@test.local` y la failclosed crea su salón propio; para una corrida limpia, recrear la DB entre grupos de suites.
- **`install.sh` no interactivo** (con `docker` falso): genera `JWT_SECRET`, clave de Postgres (20) y clave de superadmin (20), sin dejar el placeholder.
- **Sin probar (v1.3)**: QR real escaneado, Meta real (token/webhook), Google Calendar real (con credenciales de verdad), Wompi/PayU real, DIAN real, Railway real, build de imagen Docker, alerta de disco al 80 % (no se pudo forzar), rama "cifrado falla con clave válida" (solo lectura de código), clic del checkbox de opt-in en navegador, pool de 25 no re-medido con la rampa de 30 usuarios. El DEE POS real con CUFE sigue siendo el pendiente nº 1. El piloto sigue esperando los 6 datos del salón.

## Despliegue v1.3

### Railway (recomendado para la prueba del cliente)
1. Sube la carpeta a un repo de GitHub (sin `node_modules` ni `dist`).
2. En Railway: **New Project → Deploy from GitHub**, elige el repo. Railway detecta el `Dockerfile`.
3. **Añade el plugin Postgres** (Add → Database → Postgres). Railway crea `DATABASE_URL` solo; el servidor la lee tal cual.
4. **Variables** (Variables → Raw Editor): `PERSIST_DIR=/app/data`, `JWT_SECRET` (genera con `openssl rand -hex 32`), `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` (mín. 12 caracteres; el servidor no arranca con la de ejemplo), `TRUST_PROXY=1` (Railway es un proxy: sin esto los limitadores ven la IP del proxy), `BACKUP_ENCRYPTION_KEY` (64 hex: `openssl rand -hex 32`) — **sin esta clave el respaldo falla por diseño (H-M8)**; si de verdad quieres respaldos en plano, pon `BACKUP_ALLOW_UNENCRYPTED=true` y asume el riesgo. Opcionales: `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN/CALENDAR_ID`, `TELEGRAM_BOT_TOKEN/CHAT_ID`, `WOMPI_*/PAYU_*`, `META_WA_*`.
5. **UN solo volumen (Trial solo deja uno)**: en el servicio → Settings → Volumes → añade **un solo volumen montado en `/app/data`**. Ahí viven todo: `backups/`, `uploads/` y la sesión de WhatsApp (`/app/data/session-wa-session-<id>/`, porque desde la v1.3.1 LocalAuth usa `PERSIST_DIR` como dataPath, igual que el CRM v5.3.7). La sesión NO se borra en cada despliegue y no hay que reescanear el QR. No añadas un segundo volumen: en Trial no se puede.
6. Despliega. Salud: `https://<tu-dominio>/api/health` debe dar `{"ok":true,"version":"1.3.1"}`.
7. Entra como superadmin, crea el salón, entra a él y conecta WhatsApp (escanea el QR de ese salón).

### VPS con docker-compose
```bash
cp .env.example .env   # pon JWT_SECRET, SUPERADMIN_*, POSTGRES_PASSWORD (o déjalos vacíos: install.sh los genera)
./install.sh           # genera las claves que falten y levanta app + db
# Abre http://localhost:8080 (APP_PORT en .env)
```
- Los datos viven en `./data` (Postgres), `./backups` y `./uploads` (respaldos y media). El backup manual: `docker compose --profile backup run --rm backup` (también fail-closed: sin clave no guarda nada en plano).
- Respaldo completo del servidor: copia `./data`, `./backups` y el `.env` fuera de la máquina (la clave `BACKUP_ENCRYPTION_KEY` es la única que descifra los `.enc`).
- Para exponerlo con dominio + HTTPS, pon un proxy inverso (Caddy/Nginx) delante y `TRUST_PROXY=1`.

### Variables nuevas de v1.3 (ver `.env.example`)
`BACKUP_ENCRYPTION_KEY` (64 hex, obligatoria para que el respaldo funcione), `BACKUP_ALLOW_UNENCRYPTED` (opt-in explícito, por defecto no), `UPLOADS_MAX_MB=300`, `UPLOADS_USER_DAY_MAX_MB=100`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID=primary`, `GOOGLE_CALENDAR_ENABLED=false`, `GOOGLE_CALENDAR_DURATION_MINUTES=60`, `TRUST_PROXY=0` (pon `1` detrás de un proxy: Railway, Nginx, Caddy). El calendario por salón se configura desde la app (Estado del Sistema → Google Calendar), sin tocar el `.env`.

> **Versión 1.1.0 (2026-11-07).** Auditoría completa archivo por archivo + bot de reservas por WhatsApp. La carpeta `salon-v1/` **no se tocó**: esta es una copia completa en `salon-v1-1/`. Todo en español, zona horaria `America/Bogota` forzada en el proceso y en la base de datos.

## Novedades de la v1.2 — métodos de pago separados (Nequi, Daviplata, Bre-B / Llave Nu, banco)

Las clientas del salón pagan por **Nequi, Daviplata, llave Nu (Bre-B) y banco**. Antes la llave Nu quedaba mezclada dentro de "transferencia" y el cierre no cuadraba por banco. Ahora son métodos explícitos y separados en todo el sistema.

### Los 9 métodos (iguales en backend y frontend)
| Método (valor guardado) | Etiqueta visible | Para qué sirve |
|---|---|---|
| `efectivo` | Efectivo | Caja |
| `nequi` | Nequi | Caja y anticipo manual |
| `daviplata` | Daviplata | Caja y anticipo manual |
| `breb_nu` | **Bre-B / Llave Nu** | Pago a la cuenta Nu por llave Bre-B. **Método aparte, nunca se mezcla con transferencia banco** |
| `transferencia_banco` | Transferencia banco | Transferencia a la cuenta del banco |
| `tarjeta_bold` | Tarjeta Bold | Datáfono Bold |
| `pse` | PSE | Caja y anticipo manual |
| `wompi` | Wompi | Link de anticipo (lo confirma el webhook) |
| `payu` | PayU | Link de anticipo (lo confirma el webhook) |

Fuente única: `POS_METHODS` y `normalizePaymentMethod()` en `salon-routes.js` (exportados, con pruebas en `scripts/test-payment-methods.mjs`) y `lib/paymentMethods.ts` en el frontend. `GET /api/salon/pos/payment-methods` devuelve la lista, las etiquetas y el mapeo de viejos.

### Mapeo de los métodos viejos (sin perder datos ni romper registros)
| Método viejo (v1/v1.1) | Se lee / se valida como |
|---|---|
| `transferencia` | `transferencia_banco` |
| `bre-b`, `breb` | `breb_nu` (Bre-B / Llave Nu) |

Los registros viejos **no se reescriben** en la base: se normalizan al leerlos (el cierre suma `transferencia` en transferencia_banco y `bre-b` en breb_nu) y al validarlos (un cobro nuevo que mande `transferencia` o `bre-b` se guarda ya normalizado). Un método inventado (por ejemplo `neqiu`) se rechaza con 400, como antes.

### Validación del pago mixto en el servidor (v1.2)
- Método exacto y válido, monto **mayor a $0** por cada parte.
- La suma de las partes debe ser igual al resto por cobrar (**total + propina − anticipo ya pagado**, tolerancia $1).
- A lo sumo **un** método sin monto, que cobra el resto. Un `amount:null` **nunca** se multiplica ni se convierte en el total completo (eso era el bug R9 de v1.1, que aquí quedó cerrado también en `pos/sale`: antes cada null se convertía en total+propina).
- El anticipo manual (Nequi / Daviplata / Bre-B-Llave Nu / transferencia banco / efectivo / tarjeta Bold / PSE) se marca como recibido en caja y **no se auto-confirma**: el pago directo por Nequi o por llave Nu en el salón es manual. El anticipo por link Wompi/PayU sigue igual y solo el webhook lo confirma como pagado.
- Cada pago puede llevar una **referencia/comprobante opcional** (últimos dígitos o número de referencia, nunca obligatoria) que se guarda en `payment_methods` y se ve en la lista de ventas del día.

### Dónde se ven los métodos separados
- **Caja / POS** (`SalonPOS.tsx`): botones con etiquetas en español (Nequi, Daviplata, Bre-B / Llave Nu, Transferencia banco, Efectivo, Tarjeta Bold, Wompi, PayU, PSE), campo de referencia opcional por cada parte del pago mixto, cierre con los 9 métodos (0 si no hubo) y ventas del día con etiqueta y referencia.
- **Agenda** (`SalonAgenda.tsx`): anticipo manual solo con métodos manuales; al cobrar una cita, método con etiqueta y referencia opcional.
- **Cierre de caja** (`GET /api/salon/pos/cash-close`): totales por método calculados en el servidor, con `labels` incluidos; `collected` (total + propinas) debe ser igual a `byMethodSum`.
- **Bot de reservas**: no cobra en el chat; solo manda el link Wompi/PayU del anticipo, como en v1.1. Sin cambios.

### Verificación hecha en v1.2 (2026-11-07)
- `node scripts/test-payment-methods.mjs`: **28/28 pasaron** — ticket mixto Nequi $40.000 + Bre-B/Llave Nu $20.000 + efectivo $10.000 = $70.000 con los tres totales separados y $0 en transferencia_banco; cierre con registros viejos (`transferencia` $10.000 + `bre-b` $5.000 + `breb_nu` $7.000 + `nequi` $40.000 = $62.000, con breb_nu = $12.000); un null cobra el resto ($20.000, no $70.000); rechazos de dos nulls, suma distinta, monto 0/negativo y método inventado.
- `npx tsc --noEmit`: sin errores. `npm run build`: OK en ~13 s (solo aviso de chunk > 500 kB, igual que en v1.1).
- Arranque **sin DB** (`PORT=3102 node server.js`): `/` **200**, `/api/health` **200** (`{ok:true, version:"1.2.0", db:false}`), `/api/salon/pos/cash-close`, `/api/salon/pos/payment-methods`, `/api/salon/pos/sale`, `/api/salon/appointments` y `/api/salon/bot/status` sin token: **401** en todos. `/server.js` y `/.env`: **404**.
- **Sin probar (v1.2)**: DB real (migración de métodos viejos contra datos reales, trigger y aislamiento con dos tokens), QR real, Meta real, Wompi/PayU real, DIAN real. El DEE POS real con CUFE sigue siendo el pendiente nº 1 (no existe: factura interna + export DIAN-ready).



## Novedades de la v1.1 — auditoría completa + bot de reservas por WhatsApp

### Qué bot había de verdad
**Ninguno.** En SalonOS v1 no existía bot de reservas: solo la confirmación S/N a recordatorios dentro de `handleIncomingWhatsApp` y el bot de alertas de Telegram del monitoreo. El bot de Chatwoot del CRM se había quitado en v5 por ser un no-op silencioso y no se reconstruyó en v1. En v1.1 el bot **se construyó de cero** (no se fingió): motor por reglas/menú en `bot-engine.js` + adaptador Postgres en `bot-store.js` + pruebas en `scripts/test-bot-engine.mjs`.

### El bot de reservas (v1.1)
- **Un solo motor para los dos canales**: QR (whatsapp-web.js, evento de mensaje entrante) y Meta Cloud API (webhook entrante). El `salon_id` se resuelve por instancia/número, **nunca** por lo que diga la clienta en el mensaje.
- **Flujo real**: saludo con el nombre del salón → menú (reservar / cancelar / reprogramar / hablar con una persona) → servicios → profesional (o primera disponible) → fecha (hoy/mañana o DD/MM) → huecos reales (la misma `computeSlots` de la reserva web, con limpieza y sin cruces) → nombre → confirmación del teléfono normalizado +57 → resumen y SÍ/NO → crea la cita pendiente. Si el servicio exige anticipo, manda el **link Wompi/PayU** (`ANT-<id>`) y la cita queda confirmada solo cuando el webhook marca el pago; si no hay pasarela configurada, queda pendiente y el salón escribe con el link. Sin anticipo queda confirmada de una vez.
- **También**: cancelar (con la política de anticipo: gratis >48 h, 50 % entre 24–48 h, sin reembolso <24 h), reprogramar (revalida el cruce), responder **S/N a los recordatorios** (S confirma la cita más próxima, N abre la cancelación; cuando el bot está encendido, el S/N heredado del servidor no se dispara para no duplicar la respuesta), y **"hablar con una persona"** que pasa a humano y **pausa el bot para esa clienta** (silencio total hasta que ella escriba `bot` o el salón pulse "Volver al bot").
- **Anti-doble-reserva**: la creación por bot usa la **misma transacción y el mismo trigger anti-cruce** que la web (`createAppointmentTx` en `salon-routes.js`). Si dos clientas piden el mismo hueco a la vez, solo una gana y a la otra se le ofrecen otros huecos (probado en `scripts/test-bot-engine.mjs`, caso 5).
- **Sin IA externa ni cuentas nuevas**: bot por reglas/menú, en español, mensajes cortos. Si no entiende, ofrece el menú y la opción humana. **Máximo 3 intentos por paso** y luego pasa a humano. No responde a grupos, ni a mensajes de estado, ni a sus propios mensajes (filtrado en `server.js` antes de llamar al motor).
- **Pruebas del motor sin WhatsApp real** (`node scripts/test-bot-engine.mjs`): **16/16 pasaron** — bot apagado = silencio, bot encendido = saludo con el nombre del salón, reserva completa sin anticipo, reserva con anticipo + link Wompi, hueco ocupado en carrera (solo una gana, a la otra se le ofrecen otros huecos y confirma otro), cancelar con reembolso completo, reprogramar, pasar a humano + pausa + reanudación con "bot", 3 intentos fallidos → humano, "S" al recordatorio → cita confirmada, reserva a 4 manos con profesional elegida (la pareja incluye a la elegida).

### Cómo se enciende/apaga el bot
- **Por salón (admin del salón)**: Canales WhatsApp → tarjeta **"Bot de reservas por WhatsApp"** → interruptor. Ahí mismo se ven las conversaciones activas con el bot y el botón "Volver al bot" para las clientas que quedaron con una persona. También se ve quién lo cambió y cuándo.
- **Por salón (superadmin)**: panel Salones → cada salón muestra "Bot de reservas: encendido/apagado" con botón para encender/apagar.
- **Por defecto APAGADO en salones nuevos** (`salons.bot_enabled DEFAULT FALSE`): un salón nuevo no recibe respuestas automáticas hasta que su dueño lo encienda.
- **Efecto inmediato, sin reiniciar el servidor**: el motor lee `salons.bot_enabled` en cada mensaje. El cambio queda auditado (quién/cuándo en `salons.bot_enabled_changed_by/_at` y en `system_events`).
- **Por canal no hay interruptor separado**: el bot atiende en QR y en Meta con el mismo motor; el canal que se usa es el de cada instancia (Canales WhatsApp → QR o Meta por instancia). Si el salón no tiene instancia lista en un canal, por ese canal no llegan mensajes y el bot no responde nada.
- **Apagado**: cero respuestas automáticas; los mensajes quedan en el inbox/cola sin contestar por el bot. **Encendido**: responde solo a clientas con cita o que piden reservar, nunca campañas masivas ni spam.
- **Endpoints**: `GET /api/salon/bot/status`, `POST /api/salon/bot/toggle` (admin del salón), `POST /api/salons/:id/bot` (superadmin), `GET /api/salon/bot/sessions`, `POST /api/salon/bot/resume` (volver al bot para un teléfono). Sesiones en `wa_bot_sessions`.

### Bugs encontrados y corregidos en la auditoría v1.1
**Críticos (server.js)**
- **A1 — `POST /api/leads/update` roto al 100 %**: usaba `leadId`, `conversationId`, `clientName`, `itemsToClean`, `estimatedValue`, `lostReason` y `source` sin desestructurarlos (`ReferenceError` en cada llamada; en v5.3 se había dicho que estaba corregido, pero la regresión seguía). Reescrito con nombres correctos, alcance por salón del JWT, y la estilista/manicurista tampoco puede modificar prospectos.
- **A2 — Webhooks Wompi/PayU marcaban un pago parcial como factura pagada**: `balance = 0, status = 'pagado'` aunque se pagara menos. Ahora: saldo real (`balance - pagado`), estado por `invoiceStatusFor` (pendiente/parcial/pagado), todo en transacción e idempotente por referencia del proveedor (un reintento del webhook no cobra dos veces).
- **A3 — `POST /api/services` permitía sobrescribir el servicio de otro salón** por id enviado por el cliente (`ON CONFLICT (id) DO UPDATE` + `UPDATE services SET salon_id`). Igual en `DELETE /api/services/:id` y `DELETE /api/leads/:id` (sin rol ni filtro de salón). Ahora: 403 si el id es de otro salón, `salon_id` en el INSERT, DELETE con `salon_id` y `requireAdmin`.
- **A4 — Facturas de otro salón operables desde otro salón**: pago, anulación, export y link de pago sin `salon_id`. Ahora todos filtran por el salón del JWT.
- **A5 — `GET /api/settings` filtraba los tokens de Meta por salón** (`salon_<id>_meta_wa_token`) a cualquier usuario autenticado, incluida la estilista. Ahora no sale ningún token. `GET /api/wa/meta/status` ahora usa el salón del JWT, no el global.
- **A6 — La estilista/manicurista veía todos los chats y el ranking completo** (solo el operador estaba vacío). Ahora ve solo lo suyo, igual que el operador.
- **A7 — Reconectar WhatsApp recreaba una instancia Meta como QR sin salón** (`initWhatsApp(tid, name)` sin canal ni salón). Ahora reconecta con el mismo canal y salón guardados.
- **A8 — Conversaciones/clientes no aislados por salón**: `clients.phone` y `conversations.id = wa_<dígitos>` eran globales por teléfono. Ahora los mensajes guardan `salon_id` (columna añadida en el esquema) y el borrado de un cliente ya no borra las notas/recordatorios de ese teléfono en otros salones (solo los de su salón; las filas viejas sin `salon_id` se conservan, ver "Dudoso").
**Críticos (salon-routes.js)**
- **R1 — `String(Date).slice(0,10)` devolvía `"Fri Nov 06"`** (node-pg devuelve DATE como objeto Date): el reembolso calculaba `NaN` horas y **siempre devolvía 0**, el recordatorio de 2 h nunca se disparaba (siempre mandaba el de 24 h), PATCH corrompía la fecha y las liquidaciones mostraban `"Fri Nov 06"`. Nuevo helper `dateStr()` usado en reembolsos, recordatorios, PATCH y liquidaciones.
- **R2 — El anticipo pagado NO se descontaba al completar**: la clienta pagaba anticipo + precio completo, y el cierre sumaba ambos (día inflado). Ahora completar cobra solo el resto (total + propina − anticipo), la venta de caja registra ese resto, y los webhooks de anticipo sí crean su `pos_sales`. Además el cierre muestra `collected` (total + propinas) y `byMethodSum` con aviso si no cuadran.
- **R3 — Citas a 4 manos rotas por la mitad**: cancelar/no-show/anticipo/completar/reprogramar tocaban una sola fila del grupo (la otra profesional quedaba pendiente, sin anticipo ni comisión; PATCH dejaba las filas en horarios distintos; completar daba 403 a la segunda profesional). Ahora todas esas operaciones actúan sobre **todo el `group_id`**, con un helper `groupRows()`.
- **R4 — Un servicio a 4 manos con profesional elegida nunca se podía reservar**: `computeSlots` con profesional devolvía huecos de 1 profesional y el filtro pedía ≥2 → cero huecos. Ahora se calculan los huecos de todas y se exige que la elegida esté en la pareja (también en el bot).
- **R5 — Botón "Cobrar / Terminar" en Hoy fallaba siempre**: mandaba `payments:[{amount:null}]` y el servidor sumaba $0 → 400. Ahora manda `paymentMethod` y el servidor cobra el resto (con anticipo descontado).
- **R6 — "Primera disponible" en Agenda fallaba siempre**: el formulario mandaba `professionalId: undefined` y el backend devolvía 400. Ahora el backend resuelve la primera disponible con `computeSlots` (igual que la reserva pública).
- **R7 — PATCH y completar sin guardas**: PATCH permitía `status='completada'` sin pago ni comisión y `'cancelada'` sin reembolso; completar aceptaba precio/descuento arbitrarios del body (base de la propia comisión), completaba citas canceladas/no-show/pendientes sin anticipo, y se podía cancelar una cita ya completada sin revertir venta ni comisión. Ahora: completar solo por `POST .../complete`, cancelar solo por `.../cancel`, la profesional solo puede poner `en_curso` en sus citas, precio limitado al del catálogo, y las citas cerradas no se reprograman ni se cancelan ni se completan.
- **R8 — Anticipo manual sin guardas**: aceptaba citas cerradas, método de texto libre (un "neqiu" quedaba guardado y aparecía en el cierre) y monto mayor al anticipo. Ahora: solo citas abiertas, método contra `POS_METHODS`, monto exacto del anticipo. En la Agenda el método ya es una lista cerrada, no un `prompt()`.
- **R9 — Pago mixto con `amount:null` se multiplicaba**: en `pos/sale` cada null se convertía en `total+propina` (dos nulls = 2×). Ahora solo un método puede quedar sin monto (cobra el resto).
- **R10 — Ventas de TODO el salón para la estilista**: "Hoy" y el dashboard devolvían las ventas del salón entero a la profesional. Ahora se filtran por `professional_id` cuando el rol es estilista/manicurista.
- **R11 — Liquidación a 4 manos contaba el bruto dos veces**: cada fila del grupo guarda el precio completo y `SUM(price)` lo duplicaba. Ahora el bruto se toma de una sola fila por grupo.
- **R12 — Recordatorios de 2 h incluían citas ya pasadas** y `wa/flush` marcaba los fallos como `fallido` para siempre (la cola solo toma `pendiente`: el mensaje se perdía). Ahora los recordatorios de 2 h solo miran citas por venir (desde −15 min) y los fallos de la cola se quedan `pendiente` para reintentarse.
**Medios (server.js / salon-routes.js)**
- **M1** — Asesor/líder veía las facturas de todo el salón en `stats/overview`. Ahora solo las de sus servicios.
- **M2** — `GET /api/dashboard-stats` devolvía ceros en silencio al superadmin (`salon_id = null`). Ahora el superadmin ve el total de todos los salones; sin salón y sin ser superadmin, 403.
- **M3** — `POST /api/staff` movía empleados entre salones por email global; `requireAdminOrLeader` no se usaba nunca. Ahora el correo pertenece a un salón (403 si es de otro) y `requireAdminOrLeader` se usa en `PUT /api/staff/:id`.
- **M4** — Notas, recordatorios y borrado de cliente sin aislamiento por salón. Ahora las tablas tienen `salon_id` y el borrado solo toca lo de su salón.
- **M5** — `POST /api/staff/status` sin rol ni salón. Ahora solo admin y solo de su salón.
- **M6** — La S/N a recordatorios tomaba la primera cita de 48 h aunque ya hubiera pasado, y cancelaba una sola fila de un grupo. Ahora solo citas futuras y todo el grupo; con el bot encendido, la S/N la interpreta el bot.
- **M7** — `sendWhatsAppMessage` mandaba por la instancia de **otro salón** si el propio no tenía una lista. Ahora, con `salonId`, no hay caída a otra instancia.
- **M8** — Webhooks de anticipo `ANT-*` sin validar monto ni estado de la cita y sin `pos_sales`. Ahora validados (monto ≥ anticipo, cita abierta, todo el grupo) con `pos_sales` del anticipo.
- **M9** — El consecutivo de factura era global (`settings.invoice_next_number`): dos salones compartían la numeración FAC-XXXX. Ahora cada salón lleva su propio consecutivo en `salons.invoice_next_number`.
- **M10** — El superadmin no entraba a la sala `global_admin` del socket y no recibía actualizaciones en vivo. Ahora sí. `GET /api/wa/instances` devolvía `[]` siempre para el superadmin; ahora ve todas las instancias (en memoria + guardadas en DB).
- **M11** — Las instancias de WhatsApp vivían solo en memoria: `wa_instances` se escribía pero nunca se leía al arrancar. Ahora se restauran al arrancar (las QR inician su cliente, las Meta se registran virtuales).
- **M12** — Login: 5 fallos en 10 min solo avisaban, sin bloquear. Ahora se bloquea con 429 durante 10 minutos.
**Frontend**
- **F1** — `BrandingSettings` guardaba en `PUT /api/settings/branding` (tabla global, ignora el salón) y al recargar los cambios desaparecían (el GET lee la fila del salón). Ahora guarda en `PUT /api/salons/me/branding`.
- **F2** — `WhatsAppChannels` guardaba el token de Meta en `/api/settings` con claves globales: el token quedaba **compartido entre todos los salones**. Ahora va a `POST /api/salon/wa/meta-config` (por salón).
- **F3** — "Entrar al salón" era un viaje sin regreso (el token de superadmin se perdía). Ahora se guarda y el menú muestra **"← Volver a superadmin"**.
- **F4** — Menú y botones que el servidor rechaza con 403: Agenda/Clientas para estilista/manicurista, Facturación para recepcionista, Equipo para superadmin. Ahora el menú muestra solo lo que cada rol puede usar; el botón Guardar de la ficha solo aparece para admin/recepcionista.
- **F5** — `SalonPOS` no tenía profesional ni clienta: la propina quedaba sin atribuir y la venta como "Mostrador". Ahora tiene selectora de profesional y campos de clienta, y el cierre muestra si cuadra (`collected` vs suma por método).
- **F6** — `SalonProducts` no limpiaba el formulario tras crear y no tenía editar/borrar ni alertas de stock (los endpoints existían sin UI). Ahora: reset, editar, desactivar y tarjeta de stock bajo. Faltaba `DELETE /api/salon/products/:id`: se creó (desactiva, no borra el historial).
- **F7** — `SalonTeam` no podía editar empleados (`PUT /api/staff/:id` no lo llamaba nadie) y pedía contraseña siempre. Ahora edita y la contraseña vacía deja la clave actual.
- **F8** — `SalonAgenda` solo mostraba la lista de espera (no se podía añadir a nadie) y el anticipo solo tenía botón Wompi. Ahora hay formulario de lista de espera y botón PayU.
- **F9** — `SalonsAdmin` no tenía campos de dirección ni plan (el estado los tenía pero el formulario no): cada salón nacía con `address = null`, `plan = 'basico'`. Ahora tiene ambos campos.
- **F10** — `Dashboard` trataba al líder de ventas (`sales_agent`) como admin. Ahora solo `admin`/`superadmin`.
- **F11** — Título `index.html` seguía siendo "Purifica Tu Ambiente CRM" y el reporte contable de `Dashboard` decía "PURIFICA TU AMBIENTE". Ahora "SalonOS". `CapacityWidget` (agenda de limpieza del CRM viejo) ya no se muestra en salones.
- **F12** — Fechas UTC: el Excel de clientes se nombraba con la fecha UTC (después de las 19:00 en Bogotá era el día siguiente), y horas sin zona horaria en POS y chats. Ahora todo en `America/Bogota`. La preselección de chat por teléfono ahora compara normalizando (antes fallaba en silencio si el formato difería).

### Código muerto quitado (100 % verificado por grep, sin llamador)
- `server.js`: `sendEmailAlert` (las alertas salen por Telegram), `sleep`, semilla global `invoice_next_number` en `settings`.
- `salon-routes.js`: `SALON_ROLES`, `bcrypt` y `getSettingValue` desestructurados sin uso, parámetro `excludeId` de `assertNoOverlap`, `apptFilter`/`apptParams` del dashboard.
- Frontend: **`TeamManagement.tsx` (609 líneas, nunca renderizado)** y **`ServiceList.tsx` (342 líneas, sin ruta de menú)** borrados, con sus handlers `handleSaveStaff`/`handleRemoveStaff` y el `case 'services'` de `App.tsx`; imports sin uso (`App.tsx`, `Invoices.tsx`, `Layout.tsx`, `PublicBooking.tsx`); `isNormalizablePhoneCO` (`lib/phone.ts`); dependencia `recharts` en `package.json` (no aparecía en ningún lado); parámetros muertos `?role=&userName=&userId=` en las URLs de `App.tsx` (el servidor los ignora desde v5.2); estado `pros` sin uso en `SalonCatalog.tsx`.
- No se borró nada que tuviera llamador documentado: `reminders/due`, `reminders/send-due`, `wa/flush`, `wa/queue`, `products/alerts` y `professionals/:id/schedule` siguen como endpoints de cron/manual (ver README de v1).

### Qué quedó dudoso (no se pudo asegurar; no se rompió)
- **D1** — La carrera de doble reserva entre dos transacciones simultáneas (`assertNoOverlap` + trigger sin `SELECT … FOR UPDATE` ni `EXCLUDE`): en `READ COMMITTED` dos transacciones podrían pasar el chequeo a la vez; el trigger es la última defensa y no se probó bajo concurrencia real. El bot mitiga con el 409 y re-ofrece huecos.
- **D2** — Semántica del trigger con `group_id` NULL y `OVERLAPS` en citas seguidas (back-to-back): no verificada contra Postgres real. En el código JS ya se excluye el propio grupo en JS (no con `group_id<>$3`, que con NULL excluía mal).
- **D3** — Las fórmulas de firma de Wompi (`WOMPI_PRIVATE_KEY` como secreto de eventos, casi seguro que nunca verifica) y PayU (`value.toFixed(1)`) no se verificaron contra la documentación actual de los proveedores; ante duda, el webhook falla cerrado (no marca pagado).
- **D4** — `process.env.TZ = 'America/Bogota'` depende de la plataforma; el `SET TIME ZONE` por conexión del pool es lo garantizado. En `salon-routes.js` el `SET TIME ZONE` se hace sin `await` al conectar: la primera consulta de una conexión nueva podría correr antes del SET (ventana 19:00–00:00 Bogotá).
- **D5** — `getRoleScope` devuelve formas distintas por rol (heredado de v5.2); no se unificó por no romper los endpoints que lo consumen.
- **D6** — El export DIAN-ready JSON no está probado contra Siigo/Alegra; la resolución del salón en el webhook de Meta por `phone_number_id` falla si el número se comparte o falta.
- **D7** — Notas y recordatorios viejos sin `salon_id` (anteriores a v1.1) no se pueden atribuir a un salón: el borrado de cliente los conserva (no se borran datos ajenos por si acaso) y la lectura prefiere la fila del salón. Las notas nuevas sí guardan salón.
- **D8** — El login bloquea 10 minutos tras 5 fallos; no hay rate limit general en la API.
- **D9** — `POST /api/services/update-deal` sigue sin `requireAdminOrLeader` (lo puede llamar cualquier rol con JWT de salón); se le añadió el filtro de salón, pero el control de rol fino quedó pendiente.
- **D10** — El bot no atiende mensajes multimedia ni audios (solo texto); un audio o una foto quedan en el inbox sin respuesta del bot.

### Verificación hecha en v1.1 (2026-11-07)
- `npx tsc --noEmit`: **sin errores**.
- `npm run build`: **OK** (Vite, ~14–16 s; aviso de chunk > 500 kB, solo advertencia).
- Arranque **sin DB** (`PORT=3101 node server.js`): `/` **200**, `/api/health` **200** (`{ok:true, version:"1.1.0", db:false, ...}`), `/api/salon/today`, `/api/salon/appointments`, `/api/salon/catalog-services`, `/api/salon/pos/cash-close`, `/api/salon/bot/status`, `/api/salons`, `/api/invoices`, `/api/stats/overview` sin token: **401** en todos. `/server.js` y `/.env`: **404**. El log muestra `Bot de reservas SalonOS v1.1 listo (QR + Meta, apagado por defecto por salón)`.
- **Bot**: `node scripts/test-bot-engine.mjs` — **16/16 pruebas pasaron** (ver arriba).
- `node --check` sin errores en `server.js`, `salon-routes.js`, `bot-engine.js` y `bot-store.js`.

## Lo que trae la v1

| Módulo | Qué hace |
|---|---|
| **Multisalón real** | Tabla `salons` (nombre, slug único, logo, colores, plan). Cada salón tiene sus datos aislados. Todas las consultas filtran por `salon_id` del JWT; el `salon_id` **nunca** sale de parámetros de URL (`?salon_id=` se ignora). |
| **Superadmin de plataforma** | Crea/edita/desactiva salones y ve su salud. **No ve** el detalle operativo (clientas, caja) salvo que entre a un salón con un token de 1 hora (`POST /api/salons/:id/token`, auditado en `system_events`). |
| **Marca blanca por salón** | Nombre, logo y colores por salón, sin "Purifica" ni "AgendaPro" en ningún lado. El producto genérico se llama **SalonOS** y es configurable. Link de reserva por slug: `/reserva/:slug`. |
| **Roles por salón** | `superadmin` (plataforma), `admin` (todo en su salón), `recepcionista` (agenda, clientas, caja; sin ajustes ni DIAN), `estilista` / `manicurista` (solo sus citas, sus clientas y sus comisiones, lectura de sus mensajes). Roles en minúscula, alcance solo desde el JWT (heredado de v5.2). |
| **Agenda / citas** | Calendario por día y por profesional, crear/reprogramar/cancelar, estados pendiente/confirmada/en_curso/completada/cancelada/no-show. |
| **Reserva online pública** | `/reserva/:slug` sin login: servicio → profesional (o primera disponible) → huecos reales → nombre y teléfono (+57 normalizado). La clienta solo ve huecos reales. |
| **Anticipo anti-no-show** | % de anticipo por servicio (20–30 % típico; 50 % en servicios largos). Link de pago Wompi/PayU (`ANT-<id>`, el webhook lo marca pagado y confirma la cita) o registro manual (Nequi/Daviplata/Bre-B-Llave Nu/transferencia banco/efectivo). Política automática: gratis hasta 48 h antes, reembolso 50 % entre 24 y 48 h, sin reembolso con menos de 24 h o no-show. El texto de la política aceptada queda guardado en la cita. |
| **Recordatorios WhatsApp** | Confirmación al crear + recordatorio 24 h y 2 h antes (QR → Meta → cola). La clienta responde **S o N** por WhatsApp y la cita se confirma o se cancela sola. Disparo: `POST /api/salon/reminders/send-due` (ver "Recordatorios" abajo). Lista de espera: al cancelarse una cita se avisa automáticamente a la primera persona en espera. |
| **Sin cruces, ni a 4 manos** | La **base de datos rechaza el cruce** (trigger `trg_appt_no_overlap` en Postgres): mismo salón + profesional + día + horarios que se solapan, contando el tiempo de limpieza entre servicios. Servicios a 4 manos (`team_size=2`): dos profesionales a la vez, y el hueco solo se ofrece si los dos están libres. Walk-in: cita creada en recepción como confirmada si hay hueco. |
| **POS / caja colombiano (v1.2)** | Pago **mixto** en un solo ticket con métodos separados: efectivo, Nequi, Daviplata, **Bre-B / Llave Nu** (aparte de transferencia banco), transferencia banco, tarjeta (Bold), PSE, Wompi, PayU. Referencia/comprobante opcional por pago. Propina por profesional (100 % para ella). Descuento con motivo. Cierre de caja por día y salón con **totales por método calculados en el servidor** (los 9 métodos, 0 si no hubo). |
| **Comisiones que cuadran** | % por servicio o por profesional, **congelado al agendar** (`commission_pct_frozen`): si cambia el % del catálogo, las citas viejas no se reescriben. Descuento de insumos antes de liquidar (si el salón lo tiene activo). Liquidación por periodo con detalle línea por línea (bruto, descuento, insumos, comisión, propinas, a pagar) y comprobante. |
| **Clientas / ficha** | Historial de citas y servicios, total gastado, próxima cita, alergias, fórmula/color usado, notas. Autorización de tratamiento de datos (Ley 1581) guardada con fecha y texto aceptado. |
| **Inventario** | Productos de belleza (esmaltes, tintes, cremas) con stock, stock mínimo con alerta, costo/precio. Al completar una cita se pueden descontar insumos usados y se guarda su costo. |
| **WhatsApp QR + Meta por salón** | Reutilizado tal cual de v5.2 (whatsapp-web.js multi-instancia + Meta Cloud API con webhook verificado y firma HMAC). Cada instancia pertenece a **un** salón. Orden de envío: QR activo → Meta → cola (`wa_queue`, reintentable con `POST /api/salon/wa/flush`). |
| **Vista "Hoy"** | La profesional ve qué sigue ahora, quién es, cuánto falta, y dos botones grandes: **Empezar** y **Cobrar / Terminar**, con su comisión del día visible. |
| **Catálogo preconfigurado** | Al crear el salón se elige el tipo (uñas, peluquería, barbería, spa, mixto) y nace con los servicios típicos, precios y duraciones editables. |
| **Heredado de v5.2** | Login JWT+bcrypt, helmet, CORS restringido, `/server.js` y `/.env` dan 404, `/api/health`, Centro de Estado / monitoreo con alertas por Telegram, respaldo diario 02:00 con retención 7 días, facturación Normal/Electrónica (ver sección DIAN), links Wompi/PayU, normalización de teléfonos +57. |

## Instalación

### Docker (recomendado)

```bash
cp .env.example .env
# Edita .env: SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, POSTGRES_PASSWORD, JWT_SECRET
./install.sh        # Linux/macOS — o doble clic en install.bat (Windows)
# Abre http://localhost:8080
```

### Manual

```bash
npm install
npm run build
# Crea la base Postgres y define DATABASE_URL en .env (o POSTGRES_*).
node server.js
```

## Primeros pasos (orden)

1. **Entra como superadmin** con `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` del `.env`
   (se crea solo si la tabla de usuarios está vacía; `ADMIN_EMAIL`/`ADMIN_PASSWORD`
   se aceptan por compatibilidad con v5.2).
2. **Crea el primer salón** (menú Salones): nombre, slug, tipo (uñas/peluquería/mixto…).
   El catálogo inicial se crea solo. El link de reserva es `/reserva/<slug>`.
3. **Entra al salón** (botón "Entrar al salón"): te da un token de admin de 1 hora.
4. **Crea el equipo** (menú Equipo): admin del salón, recepcionista, estilistas/manicuristas
   con su comisión base. Desde ahí cada persona entra con su propio correo y clave.
5. **Conecta WhatsApp** (menú Canales WhatsApp): escanea el QR de **ese** salón, o
   configura Meta Cloud API por salón (token y phone number id; el token nunca se
   devuelve al frontend). Sin canal, los mensajes quedan en cola.
6. **Ajusta la marca** (Personalización): nombre, logo y colores del salón.
7. **Prueba la reserva pública**: abre `/reserva/<slug>` en el navegador.

## Recordatorios automáticos

El sistema no corre un cron interno. Programa una llamada cada 30 minutos
(cron del servidor, UptimeRobot, o el programador que uses) con el token de un
admin o recepcionista del salón:

```bash
curl -X POST https://tu-dominio.com/api/salon/reminders/send-due \
  -H "Authorization: Bearer <TOKEN_DEL_SALON>"
```

Eso envía los recordatorios de 24 h (citas de mañana sin recordatorio) y de 2 h
(citas de hoy en las próximas 2 h). La confirmación al crear la cita sale en el
momento, sin cron. La respuesta **S/N** de la clienta por WhatsApp se procesa al
recibir el mensaje (QR o webhook de Meta).

## Documento de venta y DIAN — leer con honestidad

**Este sistema NO emite DEE POS real con CUFE/CUDE ni transmite nada a la DIAN.**
Lo que hace:

- Genera **factura de venta interna** (impresa/PDF) y **export JSON DIAN-ready**
  para alimentar a un proveedor certificado (Siigo, Alegra, etc.), heredado de v5.2.
- Al cobrar, calcula y guarda el **documento requerido**: `dee_pos` (venta de
  mostrador ≤ 5 UVT) o `factura_electronica_plena` (venta > 5 UVT — 5 UVT 2026 =
  $261.870 COP — o cuando el cliente pide factura o da NIT). El campo
  `dian_transmitted` es **siempre `false`** hasta la integración real.
- La factura tipo `electronica` de v5.2 es "DIAN-ready", no una factura electrónica
  emitida: no hay CUFE, no hay XML UBL, no hay validación previa ni transmisión.

**No vendas el sistema como "facturación electrónica DIAN" ni prometas CUFE.**
La integración real (proveedor tecnológico autorizado o software propio con
certificado digital y resolución DIAN) es el pendiente principal de la **v1.1**.
Para habilitarse, el salón necesita RUT con responsabilidad 52 (facturador
electrónico). Valida con contador antes de prometer fechas. (Nada de esto es
asesoría legal ni tributaria.)

Tampoco el QR de WhatsApp es "oficial": whatsapp-web.js es no oficial y WhatsApp
puede restringir el número si se usa para spam o campañas. Regla del producto:
QR solo para recordatorios y respuestas a clientas con cita y opt-in; Meta para
lo demás y como migración. Si el QR se cae, el sistema cambia a Meta o encola.

## Precio sugerido (guía comercial, no está en el código)

El informe de investigación (ver `../investigacion-mejoras-colombia.md`) fija el
techo: un salón típico de 3 personas paga $99.000/mes en AgendaPro Básico **sin**
DIAN. Para competir, el precio por salón (no por profesional) debería estar por
debajo de eso **con** lo esencial incluido, y sin adicionales sorpresa. NailsControl
Pro está en $79.900 y Jeloda desde $55.000 + $35.000. Fija el precio contra ellos,
no contra Fresha en dólares. Prueba gratis recomendada: 14 días sin tarjeta.

## Verificación hecha (2026-11-07)

- `npx tsc --noEmit`: **sin errores**.
- `npm run build`: **OK** (Vite, 13–14 s; aviso de chunk > 500 kB, solo advertencia).
- Arranque **sin DB** (`PORT=3101 node server.js`): `/` **200**, `/api/health` **200**
  (`{ok:true, version:"1.0.0", db:false, whatsapp:{instances:0, connected:0}}`),
  `/api/salon/appointments`, `/api/salon/catalog-services`, `/api/salon/clients`,
  `/api/salon/pos/cash-close`, `/api/salon/dashboard`, `/api/salon/liquidations`,
  `/api/salons`, `/api/services`, `/api/clients`, `/api/invoices`,
  `/api/stats/overview` sin token: **401** en todos. `/server.js`: **404**.
  Reserva pública sin DB: **503** "Base de datos no configurada" (corregido en v1:
  antes devolvía 500 con error vacío).
- **Prueba de huecos sin cruces** (`/tmp/test-slots.mjs`, con el módulo real y pool
  simulado): cita ocupada 10:00–11:00 + 15 min de limpieza → el primer hueco libre
  ofrecido es 11:15; 09:00 tampoco se ofrece (60 min + limpieza choca con las 10:00).
  **28 huecos ofrecidos, ninguno cruzado. OK.**
- **Auditoría de aislamiento** (grep): 42 usos de `requireSalon` en `salon-routes.js`,
  30 usos de `salonIdNum(req)` y 74 menciones de `salon_id` en `server.js`, 85 en
  `salon-routes.js`. Todos los endpoints de salón y los heredados
  (services, leads, chats, staff, clients, invoices, stats, dashboard, ranking,
  availability) filtran por el `salon_id` del JWT.
- Sin "Purifica" en el código visible (solo queda en comentarios históricos de
  `server.js`/`salon-routes.js` y en el README de la base, no en la interfaz).

## Qué NO se pudo verificar (sin DB real, sin cuentas reales)

- **Sin probar con Postgres real**: el trigger anti-cruce, las migraciones, el
  seed de catálogo, el backfill del salón por defecto y el aislamiento entre dos
  salones con datos reales. La prueba de aislamiento es estática (código) + la
  prueba de huecos con pool simulado, **no** una prueba con dos tokens reales.
- **Sin probar**: QR real escaneado, Meta real (token/webhook), Wompi/PayU real
  (webhooks de anticipo `ANT-*` incluidos), DIAN real (no existe: ver arriba),
  Docker real, respaldo con `pg_dump` real.
- **Sin probar (v1.1)**: el bot con Postgres real (el motor está probado con
  tienda simulada, 16/16; la tienda real `PgBotStore` — huecos, creación,
  cancelación y anticipo contra la DB — solo está verificada en código, no con
  datos reales), ni el encendido/apagado en vivo, ni la restauración de
  instancias de WhatsApp tras reiniciar.
- **Sin probar**: 100 reservas simultáneas (el trigger debería rechazar el cruce,
  pero no se midió bajo concurrencia real).

Antes de vender: **un salón piloto real durante ~1 mes** (sus clientas, su QR, su
caja y su liquidación semanal). Si la caja y las comisiones no cuadran, no se vende.

## Qué está al nivel de AgendaPro, qué le falta para ser el mejor de Colombia

**Ya está al nivel (o por encima) en v1:**
agenda por profesional con reserva online, recordatorios WhatsApp con S/N, anticipo
con política automática, caja con pago mixto colombiano y cierre por método,
liquidación de comisiones con regla congelada, ficha de clienta con Ley 1581,
multisalón + marca blanca desde el día 1 (AgendaPro lo cobra en planes altos),
WhatsApp dual QR + Meta por salón, vista "Hoy" para la profesional.

**Le falta para ser el mejor de Colombia:**
1. **DEE POS real con CUFE y transmisión a la DIAN** (v1.1, con proveedor certificado).
   Hoy solo hay factura interna + export JSON. Es el hueco más grande frente a
   Kapi/NailsControl/Jeloda, que sí facturan.
2. **Piloto real**: nada de lo nuevo está probado con un salón de verdad.
3. Precio publicado por salón en COP y prueba de 14 días sin tarjeta (decisión
   comercial, no de código).
4. Migración desde cuaderno/Excel en menos de 30 minutos (el catálogo preconfigurado
   ayuda, pero no hay importación Excel todavía).

**Lo siguiente a mejorar (v1.2, en orden):**
lista de espera automática completa (hoy se avisa al primero; falta que su "S"
tome el cupo solo), turnero walk-in en TV, recetas de insumos por servicio con
descuento automático de stock, consentimiento informado digital firmado en
pantalla, retoque por ciclo e inactivos (45/60 días), importación y exportación
Excel de clientes/citas/ventas, migración asistida QR → Meta con medidor de costo
de mensajes, reportes de utilidad real por servicio (ingresos − comisiones −
insumos − descuentos), silla alquilada y especialista en varios salones.
Fase 2: marketplace opt-in (solo clienta nueva, % escrito antes), bonos/paquetes
prepagos, app de clienta, Google Reserve / Instagram.

## Variables de entorno

Ver `.env.example`. Las claves: `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`
(primer usuario de la plataforma), `JWT_SECRET`, `POSTGRES_*` o `DATABASE_URL`,
`WOMPI_*` y `PAYU_*` (links de pago y anticipos), `META_WA_*` (WhatsApp oficial
global; por salón se guarda desde la app), `TELEGRAM_*` (alertas de monitoreo).

## Estructura

- `server.js` — Express + Postgres + WhatsApp (base v5.2 con parches multisalón).
- `salon-routes.js` — todas las rutas nuevas de salón (salones, catálogo, agenda,
  reserva pública, clientas, POS, liquidaciones, dashboard, WhatsApp por salón).
- `components/Salon*.tsx`, `components/PublicBooking.tsx` — vistas de salón.
- `App.tsx` / `components/Layout.tsx` — navegación por rol; `/reserva/:slug` es pública.
