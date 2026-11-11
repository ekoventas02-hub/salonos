#!/usr/bin/env bash
# Instalador de SalonOS v1.3 — Linux / macOS
# Uso: ./install.sh
set -e
cd "$(dirname "$0")"

# sed -i de GNU (Linux) y BSD (macOS) no se escriben igual.
if [[ "$OSTYPE" == "darwin"* ]]; then SED_I=(-i ''); else SED_I=(-i); fi
# Escapar & y | en valores que van a sed (una clave con & rompería el reemplazo).
esc() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
# Clave aleatoria legible (20 caracteres, sin símbolos que rompan sed ni URLs).
randpass() { openssl rand -base64 24 2>/dev/null | tr -d '/+=\n' | head -c 20 || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 20; }

echo "== SalonOS v1.3 — Instalador =="
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker no está instalado. Instálalo primero (https://docs.docker.com/get-docker/) y vuelve a correr ./install.sh"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose no está disponible."; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Se creó .env desde .env.example — revísalo antes de seguir si quieres cambiar claves o puerto."
fi

# Generar JWT_SECRET si está vacío
if grep -q '^JWT_SECRET=$' .env; then
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed "${SED_I[@]}" "s|^JWT_SECRET=$|JWT_SECRET=$SECRET|" .env
  echo "JWT_SECRET generado."
fi

# Pedir clave de Postgres si sigue vacía o la de ejemplo (H-A5: sin clave por defecto).
# Si no se escribe nada (o no hay terminal), se genera una aleatoria.
if grep -Eq '^POSTGRES_PASSWORD=(cambia-esta-clave)?$' .env; then
  read -rsp "Clave de la base de datos (Enter = generar una aleatoria): " PGPASS || true; echo
  if [ -z "$PGPASS" ]; then PGPASS=$(randpass); echo "Clave de Postgres generada (queda guardada en .env)."; fi
  sed "${SED_I[@]}" "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(esc "$PGPASS")|" .env
fi

# Pedir admin inicial si sigue vacío o la clave de ejemplo (H-A5: sin clave por defecto).
# Si no se escribe nada (o no hay terminal), se genera una aleatoria y se
# MUESTRA: el servidor se niega a arrancar con la clave de ejemplo o vacía.
if grep -Eq '^SUPERADMIN_PASSWORD=(cambia-esta-clave)?$' .env; then
  read -rp "Correo del superadmin inicial [superadmin@tudominio.com]: " AEMAIL || true
  read -rsp "Contraseña del superadmin inicial (Enter = generar una aleatoria): " APASS || true; echo
  [ -n "$AEMAIL" ] && sed "${SED_I[@]}" "s|^SUPERADMIN_EMAIL=.*|SUPERADMIN_EMAIL=$(esc "$AEMAIL")|" .env
  if [ -z "$APASS" ]; then
    APASS=$(randpass)
    sed "${SED_I[@]}" "s|^SUPERADMIN_PASSWORD=.*|SUPERADMIN_PASSWORD=$(esc "$APASS")|" .env
    echo ""
    echo "======================================================"
    echo "Contraseña del superadmin generada — ANÓTALA:"
    echo "  $APASS"
    echo "======================================================"
    echo ""
  else
    sed "${SED_I[@]}" "s|^SUPERADMIN_PASSWORD=.*|SUPERADMIN_PASSWORD=$(esc "$APASS")|" .env
  fi
fi

echo "Levantando app + base de datos..."
docker compose up -d --build

PORT=$(grep '^APP_PORT=' .env | cut -d= -f2)
PORT=${PORT:-8080}
echo ""
echo "Listo. Abre http://localhost:$PORT"
echo "Entra con el correo y la contraseña de administrador que definiste en .env."
echo "Después de entrar, cambia la contraseña desde Equipo y conecta WhatsApp en Canales WhatsApp (escanea el QR)."
