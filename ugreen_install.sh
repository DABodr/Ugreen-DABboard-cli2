#!/bin/bash
#
# ugreen_install.sh – automated setup for the uGreen DAB board + Node web interface
#
set -euo pipefail

# --------------------
# Variables
# --------------------
FILES_URL="${FILES_URL:-https://ugreen.eu/wp-content/uploads/files/Files_v16.zip}"
FILES_NAME="Files_v16.zip"

INSTALL_DIR="/usr/local/lib/ugreen-dab+"
RADIO_CLI_SYMLINK="/usr/local/sbin/radio_cli"
DAB_RADIO_SYMLINK="/usr/local/sbin/DABBoardRadio"

WEB_PORT="${WEB_PORT:-9595}"
WEB_ROOT="/opt/dab-web-interface"
SERVICE_NAME="dab-webserver"

SERVICE_USER="dabweb"
LOG_DIR="/var/log/dab-web-interface"
LOG_FILE="${LOG_DIR}/radio.log"

# --------------------
# Helpers
# --------------------
need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Erreur: lance ce script en root (sudo ./ugreen_install.sh)."
    exit 1
  fi
}

msg() { echo -e "\n==> $*"; }

arch_pick() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64) echo "64-bit" ;;
    armv7l|armv7*|armhf|arm) echo "32-bit" ;;
    x86_64|amd64) echo "64-bit" ;; # au cas où
    *)
      echo "64-bit" # fallback pragmatique
      ;;
  esac
}

install_deps() {
  msg "Installation des dépendances (apt)…"
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git \
    libncurses5 alsa-utils

  # Node.js (si pas déjà là)
  if ! command -v node >/dev/null 2>&1; then
    msg "Installation de Node.js (NodeSource 20.x)…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
}

create_user_and_perms() {
  msg "Création utilisateur système ${SERVICE_USER} + permissions (spi/gpio)…"
  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi

  # Groupes utiles (selon distro)
  getent group spi >/dev/null && usermod -aG spi "${SERVICE_USER}" || true
  getent group gpio >/dev/null && usermod -aG gpio "${SERVICE_USER}" || true

  # Logs
  mkdir -p "${LOG_DIR}"
  touch "${LOG_FILE}"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${LOG_DIR}"
  chmod 750 "${LOG_DIR}"
  chmod 640 "${LOG_FILE}"

  # Sudoers: autoriser radio_cli sans mot de passe
  msg "Configuration sudoers pour permettre à ${SERVICE_USER} d’exécuter radio_cli en root…"
  cat > /etc/sudoers.d/dab-web-interface <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: ${RADIO_CLI_SYMLINK}
Defaults!${RADIO_CLI_SYMLINK} !requiretty
EOF
  chmod 440 /etc/sudoers.d/dab-web-interface
}

download_ugreen() {
  msg "Téléchargement uGreen: ${FILES_URL}"
  rm -f "/tmp/${FILES_NAME}"
  curl -fL "${FILES_URL}" -o "/tmp/${FILES_NAME}"

  msg "Extraction uGreen…"
  rm -rf /tmp/Files_v16
  unzip -o "/tmp/${FILES_NAME}" -d /tmp

  if [[ ! -d /tmp/Files_v16 ]]; then
    echo "Erreur: archive inattendue, /tmp/Files_v16 introuvable après unzip."
    exit 1
  fi

  local bitdir
  bitdir="$(arch_pick)"

  local src_radio="/tmp/Files_v16/bin/${bitdir}/radio_cli_v3.2.1"
  local src_dab="/tmp/Files_v16/bin/${bitdir}/DABBoardRadio_v0.17.2"

  if [[ ! -f "${src_radio}" ]]; then
    echo "Erreur: binaire radio_cli introuvable: ${src_radio}"
    exit 1
  fi
  if [[ ! -f "${src_dab}" ]]; then
    echo "Erreur: binaire DABBoardRadio introuvable: ${src_dab}"
    exit 1
  fi

  msg "Installation dans ${INSTALL_DIR} (arch: ${bitdir})…"
  rm -rf "${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}"

  # On copie en noms stables (sans suffixe), sinon tu vas revivre l’enfer des symlinks.
  cp -f "${src_radio}" "${INSTALL_DIR}/radio_cli"
  cp -f "${src_dab}" "${INSTALL_DIR}/DABBoardRadio"

  chmod 755 "${INSTALL_DIR}/radio_cli" "${INSTALL_DIR}/DABBoardRadio"

  # Liens dans /usr/local/sbin
  ln -sf "${INSTALL_DIR}/radio_cli" "${RADIO_CLI_SYMLINK}"
  ln -sf "${INSTALL_DIR}/DABBoardRadio" "${DAB_RADIO_SYMLINK}"

  msg "Vérif exécution (root)…"
  "${RADIO_CLI_SYMLINK}" --help >/dev/null
}

deploy_web_interface() {
  msg "Déploiement WebUI dans ${WEB_ROOT}…"
  mkdir -p "${WEB_ROOT}"

  # Le script doit être lancé depuis le dossier du projet qui contient dab-web-interface/
  if [[ -d "dab-web-interface" ]]; then
    rm -rf "${WEB_ROOT:?}/"*
    cp -r dab-web-interface/* "${WEB_ROOT}/"
  else
    echo "Erreur: dossier 'dab-web-interface' introuvable. Lance le script depuis la racine du projet."
    exit 1
  fi

  # Fix log path: l’app veut écrire /opt/dab-web-interface/radio.log
  # On lui donne un symlink vers /var/log/… (écrit par dabweb).
  ln -sf "${LOG_FILE}" "${WEB_ROOT}/radio.log"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${WEB_ROOT}"

  msg "Installation npm (prod)…"
  ( cd "${WEB_ROOT}" && npm install --production )
}

patch_app_js() {
  # On corrige les trucs évidents:
  # - option invalide --list-services -> -g
  # - si le code appelle radio_cli sans sudo, on préfixe
  msg "Patch rapide app.js (options et sudo)…"

  if [[ ! -f "${WEB_ROOT}/app.js" ]]; then
    echo "Warning: ${WEB_ROOT}/app.js introuvable, patch ignoré."
    return 0
  fi

  # 1) --list-services => -g
  sed -i 's/--list-services/-g/g' "${WEB_ROOT}/app.js"

  # 2) Option boot: si ton app utilise --boot=D, radio_cli attend -b D
  # (ton log montrait --boot=D)
  sed -i 's/--boot=\([A-Za-z]\)/-b \1/g' "${WEB_ROOT}/app.js"

  # 3) Préfixe sudo si la commande contient "/usr/local/sbin/radio_cli" et pas déjà sudo
  # (patch simple: remplace "CMD: /usr/local/sbin/radio_cli" côté code souvent construit en string)
  # On vise surtout les constructions type: const cmd = "/usr/local/sbin/radio_cli ..."
  sed -i 's#"\(/usr/local/sbin/radio_cli\)#"sudo \1#g' "${WEB_ROOT}/app.js"
  sed -i "s#'\\(/usr/local/sbin/radio_cli\\)#'sudo \\1#g" "${WEB_ROOT}/app.js"
}

create_service() {
  msg "Création service systemd ${SERVICE_NAME}…"

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=uGreen DAB Web Interface
After=network.target

[Service]
Type=simple
Environment=PORT=${WEB_PORT}
WorkingDirectory=${WEB_ROOT}
ExecStart=/usr/bin/node ${WEB_ROOT}/app.js
Restart=always
RestartSec=2
User=${SERVICE_USER}
Group=${SERVICE_USER}

# Sécurité de base (sans casser sudo/radio_cli)
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
}

final_msg() {
  local ip
  ip="$(hostname -I | awk '{print $1}')"
  msg "Terminé."
  echo "WebUI: http://${ip}:${WEB_PORT}/"
  echo "Service: systemctl status ${SERVICE_NAME}"
  echo "Test radio_cli (via sudo autorisé pour ${SERVICE_USER}): sudo -u ${SERVICE_USER} sudo ${RADIO_CLI_SYMLINK} --help >/dev/null && echo OK"
}

# --------------------
# Main
# --------------------
need_root

echo "Ce script va installer uGreen (ZIP) + WebUI + service systemd."
echo "URL uGreen: ${FILES_URL}"
read -r -p "Continuer ? [y/N] " ans
case "${ans}" in
  y|Y|yes|YES) ;;
  *) echo "Abandon."; exit 0 ;;
esac

install_deps
create_user_and_perms
download_ugreen
deploy_web_interface
patch_app_js
create_service
final_msg
