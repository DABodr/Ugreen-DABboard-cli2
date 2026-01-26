#!/usr/bin/env bash
set -euo pipefail

# ==========================
# CONFIG: Mets ton URL ici
# ==========================
FILES_ZIP_URL="${FILES_ZIP_URL:-https://ugreen.eu/wp-content/uploads/files/Files_v16.zip}"

# Optionnel: si tu veux aussi télécharger app.js/public/package.json depuis une archive
WEBUI_ZIP_URL="${WEBUI_ZIP_URL:-}"  # ex: https://EXEMPLE.TON_SERVEUR/dab-web-interface.zip

# ==========================
# INSTALL PATHS
# ==========================
APP_DIR="/opt/dab-web-interface"
BIN_DIR="/usr/local/lib/ugreen-dab+"
SBIN_LINK="/usr/local/sbin/radio_cli"

LOG_DIR="/var/log/dab-web-interface"
DATA_DIR="/var/lib/dab-web-interface"

SERVICE_FILE="/etc/systemd/system/dab-webserver.service"
NODE_BIN="/usr/bin/node"

# ==========================
# HELPERS
# ==========================
die() { echo "ERROR: $*" >&2; exit 1; }

need_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "Lance en root: sudo bash ugreen_install.sh"
  fi
}

cmd_exists() { command -v "$1" >/dev/null 2>&1; }

download_file() {
  local url="$1"
  local out="$2"

  [[ -n "$url" ]] || die "URL vide (download_file)"
  echo "Téléchargement: $url"
  if cmd_exists curl; then
    curl -L --fail --retry 3 --retry-delay 1 -o "$out" "$url"
  elif cmd_exists wget; then
    wget -O "$out" "$url"
  else
    die "Ni curl ni wget n'est installé. Installe: sudo apt-get install -y curl"
  fi
}

pick_radio_cli() {
  local search_dir="$1"
  local arch
  arch="$(uname -m)"

  mapfile -t candidates < <(find "$search_dir" -maxdepth 4 -type f -name "radio_cli*" ! -name "*.md" 2>/dev/null || true)
  [[ "${#candidates[@]}" -gt 0 ]] || die "Aucun binaire radio_cli trouvé dans l'archive."

  local best=""
  for f in "${candidates[@]}"; do
    if file "$f" | grep -qiE "ELF"; then
      case "$arch" in
        aarch64|arm64)
          if file "$f" | grep -qi "ARM aarch64"; then best="$f"; break; fi
          ;;
        armv7l|armv6l)
          if file "$f" | grep -qiE "ARM(,| )"; then best="$f"; fi
          ;;
        x86_64|amd64)
          if file "$f" | grep -qi "x86-64"; then best="$f"; break; fi
          ;;
        i386|i686)
          if file "$f" | grep -qiE "Intel 80386"; then best="$f"; break; fi
          ;;
        *)
          best="$f"
          ;;
      esac
    fi
  done

  [[ -n "$best" ]] || die "Impossible de choisir automatiquement radio_cli pour arch=$(uname -m)"
  echo "$best"
}

check_interpreter_exists() {
  local bin="$1"
  local interp
  interp="$(file "$bin" | sed -n 's/.*interpreter \([^,]*\).*/\1/p' | head -n1 || true)"
  if [[ -n "$interp" && ! -e "$interp" ]]; then
    echo "ATTENTION: interpréteur dynamique manquant: $interp" >&2
    echo "=> Souvent: binaire aarch64 sur OS 32-bit, ou libc manquante." >&2
    die "Ce binaire ne pourra pas s'exécuter sur ce système."
  fi
}

# ==========================
# MAIN
# ==========================
need_root

# deps
apt-get update -y >/dev/null
apt-get install -y unzip file >/dev/null

cmd_exists "$NODE_BIN" || die "Node.js introuvable à $NODE_BIN"

mkdir -p "$APP_DIR" "$BIN_DIR" "$LOG_DIR" "$DATA_DIR"
chmod 755 "$LOG_DIR" "$DATA_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FILES_ZIP="$TMP_DIR/Files.zip"
download_file "$FILES_ZIP_URL" "$FILES_ZIP"

echo "Extraction Files.zip…"
unzip -q "$FILES_ZIP" -d "$TMP_DIR/files"

echo "Sélection radio_cli pour arch=$(uname -m)…"
RADIO_BIN="$(pick_radio_cli "$TMP_DIR/files")"
echo " -> $RADIO_BIN"
check_interpreter_exists "$RADIO_BIN"

echo "Installation radio_cli…"
install -m 0755 "$RADIO_BIN" "$BIN_DIR/radio_cli"
rm -f "$SBIN_LINK"
ln -s "$BIN_DIR/radio_cli" "$SBIN_LINK"

# Optionnel: WebUI zip
if [[ -n "$WEBUI_ZIP_URL" ]]; then
  WEBUI_ZIP="$TMP_DIR/webui.zip"
  download_file "$WEBUI_ZIP_URL" "$WEBUI_ZIP"
  echo "Extraction webui.zip…"
  unzip -q "$WEBUI_ZIP" -d "$TMP_DIR/webui"
  # On copie le contenu dans APP_DIR
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  cp -a "$TMP_DIR/webui/." "$APP_DIR/"
fi

# npm install si package.json présent
if [[ -f "$APP_DIR/package.json" ]]; then
  if ! cmd_exists npm; then
    apt-get install -y npm >/dev/null
  fi
  cd "$APP_DIR"
  npm ci --omit=dev || npm install --omit=dev
fi

echo "Installation service systemd (root)…"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=uGreen DAB Web Interface
After=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$APP_DIR
Environment=PORT=3000
Environment=HOST=0.0.0.0
Environment=RADIO_CLI_PATH=$SBIN_LINK
Environment=LOG_DIR=$LOG_DIR
Environment=LOG_PATH=$LOG_DIR/radio.log
Environment=DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN $APP_DIR/app.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dab-webserver.service >/dev/null
systemctl restart dab-webserver.service

echo
systemctl --no-pager --full status dab-webserver.service || true
echo
echo "OK."
echo "UI: http://$(hostname -I | awk '{print $1}'):3000"
echo "radio_cli: $SBIN_LINK -> $BIN_DIR/radio_cli"
echo "logs: $LOG_DIR/radio.log"
