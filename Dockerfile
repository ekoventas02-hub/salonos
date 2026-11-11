# SalonOS multisalón — Dockerfile multi-etapa (v1.3).
# Adaptado del Dockerfile del CRM (v5.3.32/33): misma estructura, marca
# SalonOS y cliente PostgreSQL 16 (la base de datos de SalonOS es
# postgres:16-alpine; ver docker-compose.yml).
# Etapa 1 (build): instala TODAS las dependencias (incluidas las de
# desarrollo: vite, typescript) y compila el frontend.
# Etapa 2 (runtime): solo dependencias de producción
# (npm ci --omit=dev) y la app corre como usuario no-root (node).
#
# Nota para instalaciones existentes: los volúmenes nombrados creados
# con la imagen vieja pertenecen a root. Tras actualizar, si la app no
# puede escribir en /app/uploads, ejecuta una vez:
#   docker compose run --rm --user root app chown -R node:node /app/uploads /app/backups /app/.wwebjs_auth
# (los volúmenes nuevos ya nacen con el dueño correcto, porque los
# directorios de la imagen son de node y Docker copia su dueño al
# crear el volumen).

# ---------- Etapa 1: compilación ----------
FROM node:22-slim AS build

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# El build (Vite) no necesita Chrome: no descargarlo aquí ahorra
# tiempo y evita confusión. Chrome se descarga solo en la etapa de
# ejecución, donde sí hace falta (WhatsApp por QR).
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Instalar dependencias (todas: el build necesita vite y typescript)
RUN npm ci

# Copiar el resto del código
COPY . .

# Construir el frontend (Vite)
RUN npm run build

# ---------- Etapa 2: ejecución ----------
FROM node:22-slim

# La base de datos de SalonOS es Postgres 16 en docker-compose, pero en
# Railway el plugin de Postgres ya es 18, y pg_dump 15 (el
# postgresql-client de Debian 12) se niega a respaldar servidores más
# nuevos ("server version mismatch") -> el respaldo siempre fallaría.
# El cliente 18 viene del repo oficial de PostgreSQL (PGDG), que sí lo
# tiene para bookworm; pg_dump 18 respalda servidores 18 y también 16
# (un cliente más nuevo sí respalda servidores más viejos).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    && mkdir -p /usr/share/keyrings \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && rm -rf /var/lib/apt/lists/*

# Instalar dependencias necesarias para Chrome/Puppeteer
# (gconf-service, libgconf-2-4 y libappindicator1 se quitaron: no existen
# en Debian 12/Bookworm y rompían el build de la imagen.)
# postgresql-client-18: el trabajo de respaldo de docker-compose usa
# pg_dump desde esta misma imagen. wget: lo usa el HEALTHCHECK.
RUN apt-get update && apt-get install -y \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libxkbcommon0 \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    libgbm-dev \
    postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de la aplicación
WORKDIR /app

# Dónde vive Chrome. Puppeteer descarga Chrome al instalarse (`npm ci`)
# en $PUPPETEER_CACHE_DIR, o en ~/.cache/puppeteer si no está definido.
# Sin definirlo, el `npm ci` de ejecución corre como root y Chrome queda
# en /root/.cache/puppeteer, pero la app corre como usuario `node` y lo
# busca en /home/node/.cache/puppeteer -> "Could not find Chrome" y
# WhatsApp caído en producción. Ahora el caché vive dentro de /app (con
# dueño node por el chown de abajo) y la variable queda en la imagen, así
# que en ejecución Puppeteer lo encuentra ahí.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Railway usa esta imagen y su edge ES un proxy real, así que aquí
# TRUST_PROXY=1. En docker-compose el `environment:` lo sobreescribe a
# 0 (VPS directo, seguro por defecto); solo se pone a 1 en compose si
# hay un reverse proxy real delante.
ENV TRUST_PROXY=1

# Solo dependencias de producción (sin vite/typescript/terser).
COPY package*.json ./
RUN npm ci --omit=dev

# Código del servidor + frontend compilado + scripts de mantenimiento
# (respaldo de docker-compose y descifrado de respaldos).
# server.js importa salon-routes.js, bot-engine.js y bot-store.js: sin
# ellos la app no arranca, por eso se copian también (el CRM es un solo
# archivo y solo copiaba server.js).
COPY server.js salon-routes.js bot-engine.js bot-store.js ./
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

# Entrypoint: el contenedor arranca como root SOLO para arreglar el
# dueño de los volúmenes (ver entrypoint.sh) y luego baja privilegios.
# Por eso aquí NO hay `USER node`: el entrypoint es quien ejecuta la
# app como node. Sin esto, el volumen de Railway (creado cuando la app
# corría como root) pertenece a root y `node` no puede crear la sesión
# de WhatsApp (EACCES) ni Chrome su perfil (Code: 21).
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Directorios que la app escribe (archivos subidos, sesión de WhatsApp
# QR y respaldos) con dueño node: los volúmenes nuevos heredan este
# dueño al crearse.
RUN mkdir -p /app/uploads /app/.wwebjs_auth /app/backups \
  && chown -R node:node /app

# Exponer el puerto 3000
EXPOSE 3000

# Salud: el monitor externo y Docker usan /api/health (no necesita login ni DB).
# Usa $PORT (Railway asigna un puerto distinto; en VPS/Docker Compose
# sigue siendo 3000). Sin esto, el chequeo de salud fallaba en Railway.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]

# Comando para iniciar la aplicación (el entrypoint lo ejecuta como node).
CMD ["npm", "start"]
