#!/bin/bash
#
# ugreen_install.sh – automated setup for the uGreen DAB board + Node web interface
#
# This script:
# - Downloads and installs uGreen radio_cli binaries
# - Installs Node.js and dependencies
# - Deploys the web interface
# - Creates a systemd service
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

LOG_DIR="/var/log/dab-web-interface"
DATA_DIR="/var/lib/dab-web-interface"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# --------------------
# Helpers
# --------------------
need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo -e "${RED}Erreur: lance ce script en root (sudo ./ugreen_install.sh).${NC}"
    exit 1
  fi
}

msg() { echo -e "\n${GREEN}==> $*${NC}"; }
warn() { echo -e "${YELLOW}Warning: $*${NC}"; }
err() { echo -e "${RED}Error: $*${NC}" >&2; }

# Detect architecture and return the expected directory name
arch_pick() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64) echo "64-bit" ;;
    armv7l|armv7*|armhf|arm) echo "32-bit" ;;
    x86_64|amd64) echo "64-bit" ;;
    i386|i686) echo "32-bit" ;;
    *)
      warn "Unknown architecture: $arch, defaulting to 64-bit"
      echo "64-bit"
      ;;
  esac
}

# Find a binary matching a pattern in a directory
# Returns the path to the most recent version if multiple exist
find_binary() {
  local dir="$1"
  local pattern="$2"
  
  if [[ ! -d "$dir" ]]; then
    return 1
  fi
  
  # Find all matching files and sort by version (assuming format name_vX.Y.Z)
  local found
  found=$(find "$dir" -maxdepth 1 -type f -name "${pattern}*" 2>/dev/null | sort -V | tail -1)
  
  if [[ -n "$found" && -f "$found" ]]; then
    echo "$found"
    return 0
  fi
  
  return 1
}

install_deps() {
  msg "Installation des dépendances système (apt)…"
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl wget unzip git \
    libncurses5 alsa-utils

  # Node.js (if not already installed or version too old)
  local need_node=0
  if ! command -v node >/dev/null 2>&1; then
    need_node=1
  else
    local node_version
    node_version=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
    if [[ -z "$node_version" || "$node_version" -lt 18 ]]; then
      warn "Node.js version too old (need 18+), upgrading..."
      need_node=1
    fi
  fi

  if [[ "$need_node" -eq 1 ]]; then
    msg "Installation de Node.js (NodeSource 20.x)…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    msg "Node.js $(node -v) déjà installé."
  fi
}

create_dirs() {
  msg "Création des dossiers de logs et données…"
  mkdir -p "${LOG_DIR}"
  mkdir -p "${DATA_DIR}"
  touch "${LOG_DIR}/radio.log"
  chmod 755 "${LOG_DIR}" "${DATA_DIR}"
  chmod 644 "${LOG_DIR}/radio.log"
}

download_ugreen() {
  msg "Téléchargement uGreen: ${FILES_URL}"
  
  # Clean up previous downloads
  rm -f "/tmp/${FILES_NAME}"
  rm -rf /tmp/Files_v*
  rm -rf /tmp/DABBoard
  
  # Download with error handling
  if ! curl -fL "${FILES_URL}" -o "/tmp/${FILES_NAME}"; then
    if ! wget -O "/tmp/${FILES_NAME}" "${FILES_URL}"; then
      err "Échec du téléchargement de ${FILES_URL}"
      exit 1
    fi
  fi

  msg "Extraction de l'archive uGreen…"
  if ! unzip -o "/tmp/${FILES_NAME}" -d /tmp; then
    err "Échec de l'extraction de l'archive"
    exit 1
  fi

  # Find the extracted directory (could be Files_v16, DABBoard, etc.)
  local extracted_dir=""
  for candidate in /tmp/Files_v* /tmp/DABBoard /tmp/ugreen*; do
    if [[ -d "$candidate" ]]; then
      extracted_dir="$candidate"
      break
    fi
  done

  if [[ -z "$extracted_dir" || ! -d "$extracted_dir" ]]; then
    err "Impossible de trouver le dossier extrait dans /tmp"
    ls -la /tmp/
    exit 1
  fi

  msg "Dossier extrait: $extracted_dir"

  # Determine architecture
  local bitdir
  bitdir="$(arch_pick)"
  msg "Architecture détectée: $bitdir"

  # Try to find binaries in various possible locations
  local bin_search_paths=(
    "$extracted_dir/bin/${bitdir}"
    "$extracted_dir/${bitdir}"
    "$extracted_dir/bin"
    "$extracted_dir"
  )

  local src_radio=""
  local src_dab=""

  # Search for radio_cli binary
  for search_path in "${bin_search_paths[@]}"; do
    if [[ -d "$search_path" ]]; then
      local found
      found=$(find_binary "$search_path" "radio_cli") || true
      if [[ -n "$found" ]]; then
        src_radio="$found"
        msg "Trouvé radio_cli: $src_radio"
        break
      fi
    fi
  done

  # Search for DABBoardRadio binary
  for search_path in "${bin_search_paths[@]}"; do
    if [[ -d "$search_path" ]]; then
      local found
      found=$(find_binary "$search_path" "DABBoardRadio") || true
      if [[ -n "$found" ]]; then
        src_dab="$found"
        msg "Trouvé DABBoardRadio: $src_dab"
        break
      fi
    fi
  done

  # Validate we found at least radio_cli
  if [[ -z "$src_radio" || ! -f "$src_radio" ]]; then
    err "Binaire radio_cli introuvable dans l'archive"
    echo "Contenu de l'archive:"
    find "$extracted_dir" -type f -name "*radio*" 2>/dev/null || true
    exit 1
  fi

  # DABBoardRadio is optional (warn if not found)
  if [[ -z "$src_dab" || ! -f "$src_dab" ]]; then
    warn "DABBoardRadio non trouvé (optionnel)"
  fi

  msg "Installation dans ${INSTALL_DIR}…"
  
  # Clean previous installation
  rm -rf "${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}"

  # Copy binaries with stable names
  cp -f "${src_radio}" "${INSTALL_DIR}/radio_cli"
  chmod 755 "${INSTALL_DIR}/radio_cli"

  if [[ -n "$src_dab" && -f "$src_dab" ]]; then
    cp -f "${src_dab}" "${INSTALL_DIR}/DABBoardRadio"
    chmod 755 "${INSTALL_DIR}/DABBoardRadio"
  fi

  # Create symlinks in /usr/local/sbin
  ln -sf "${INSTALL_DIR}/radio_cli" "${RADIO_CLI_SYMLINK}"
  
  if [[ -f "${INSTALL_DIR}/DABBoardRadio" ]]; then
    ln -sf "${INSTALL_DIR}/DABBoardRadio" "${DAB_RADIO_SYMLINK}"
  fi

  # Verify installation
  msg "Vérification de radio_cli…"
  if "${RADIO_CLI_SYMLINK}" --help >/dev/null 2>&1; then
    msg "radio_cli fonctionne correctement ✓"
  else
    # Try running without --help (some versions might not support it)
    if "${RADIO_CLI_SYMLINK}" -h >/dev/null 2>&1; then
      msg "radio_cli fonctionne correctement ✓"
    else
      warn "radio_cli ne répond pas à --help ou -h"
      warn "Cela peut être normal selon la version. Continuons..."
    fi
  fi

  # Clean up
  rm -f "/tmp/${FILES_NAME}"
  rm -rf "$extracted_dir"
}

deploy_web_interface() {
  msg "Déploiement de l'interface web dans ${WEB_ROOT}…"
  
  # Find the source directory
  local script_dir
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  
  local source_dir=""
  if [[ -d "${script_dir}/dab-web-interface" ]]; then
    source_dir="${script_dir}/dab-web-interface"
  elif [[ -f "${script_dir}/app.js" ]]; then
    source_dir="${script_dir}"
  else
    err "Dossier 'dab-web-interface' introuvable."
    err "Lance le script depuis la racine du projet."
    exit 1
  fi

  # Create target directory and copy files
  mkdir -p "${WEB_ROOT}"
  rm -rf "${WEB_ROOT:?}/"*
  cp -r "${source_dir}/"* "${WEB_ROOT}/"

  msg "Installation des dépendances npm…"
  (cd "${WEB_ROOT}" && npm install --production --no-optional)
  
  # Verify installation
  if [[ ! -f "${WEB_ROOT}/app.js" ]]; then
    err "app.js non trouvé dans ${WEB_ROOT}"
    exit 1
  fi
  
  msg "Interface web installée ✓"
}

create_service() {
  msg "Création du service systemd ${SERVICE_NAME}…"

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=uGreen DAB Web Interface
After=network.target
Wants=network-online.target

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=PORT=${WEB_PORT}
Environment=HOST=0.0.0.0
Environment=RADIO_CLI_PATH=${RADIO_CLI_SYMLINK}
Environment=LOG_DIR=${LOG_DIR}
Environment=DATA_DIR=${DATA_DIR}
Environment=AUDIO_DEVICE=sysdefault:CARD=dabboard
WorkingDirectory=${WEB_ROOT}
ExecStart=/usr/bin/node ${WEB_ROOT}/app.js
Restart=always
RestartSec=5
User=root
Group=root

# Security hardening (compatible with hardware access)
NoNewPrivileges=false
ProtectSystem=false
PrivateTmp=true

# Hardware access
SupplementaryGroups=spi gpio i2c audio

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  
  msg "Démarrage du service…"
  if systemctl restart "${SERVICE_NAME}"; then
    msg "Service démarré ✓"
  else
    warn "Le service n'a pas démarré correctement"
    warn "Vérifiez avec: journalctl -u ${SERVICE_NAME} -f"
  fi
}

print_summary() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || ip="<IP>"
  
  echo ""
  echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Installation terminée avec succès !${NC}"
  echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  📻 Interface web:  http://${ip}:${WEB_PORT}/"
  echo ""
  echo "  🔧 Commandes utiles:"
  echo "     - Status:    sudo systemctl status ${SERVICE_NAME}"
  echo "     - Logs:      sudo journalctl -u ${SERVICE_NAME} -f"
  echo "     - Restart:   sudo systemctl restart ${SERVICE_NAME}"
  echo "     - Stop:      sudo systemctl stop ${SERVICE_NAME}"
  echo ""
  echo "  📁 Fichiers:"
  echo "     - App:       ${WEB_ROOT}"
  echo "     - Logs:      ${LOG_DIR}"
  echo "     - Binaires:  ${INSTALL_DIR}"
  echo ""
  echo -e "${YELLOW}  ⚠️  Si l'I²S est activé, redémarrez le Raspberry Pi.${NC}"
  echo ""
}

# --------------------
# Main
# --------------------
main() {
  need_root

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║     uGreen DAB Board - Installation automatique             ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "Ce script va installer:"
  echo "  • Les binaires uGreen (radio_cli, DABBoardRadio)"
  echo "  • Node.js 20.x"
  echo "  • L'interface web sur le port ${WEB_PORT}"
  echo "  • Un service systemd (${SERVICE_NAME})"
  echo ""
  echo "URL uGreen: ${FILES_URL}"
  echo ""
  
  read -r -p "Continuer l'installation ? [y/N] " ans
  case "${ans}" in
    y|Y|yes|YES|o|O|oui|OUI) ;;
    *) echo "Abandon."; exit 0 ;;
  esac

  install_deps
  create_dirs
  download_ugreen
  deploy_web_interface
  create_service
  print_summary
}

main "$@"
