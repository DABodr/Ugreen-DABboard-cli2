#!/usr/bin/env bash
set -euo pipefail

# ==========================
# PATHS (doivent matcher l'install)
# ==========================
APP_DIR="/opt/dab-web-interface"
BIN_DIR="/usr/local/lib/ugreen-dab+"
SBIN_LINK="/usr/local/sbin/radio_cli"

LOG_DIR="/var/log/dab-web-interface"
DATA_DIR="/var/lib/dab-web-interface"

SERVICE_FILE="/etc/systemd/system/dab-webserver.service"
SERVICE_NAME="dab-webserver.service"

die() { echo "ERROR: $*" >&2; exit 1; }

need_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "Lance en root: sudo bash ugreen_uninstall.sh"
  fi
}

echo "=== uGreen DAB – Désinstallation complète ==="
need_root

# ==========================
# Stop & disable service
# ==========================
if systemctl list-unit-files | grep -q "^$SERVICE_NAME"; then
  echo "Arrêt du service systemd…"
  systemctl stop "$SERVICE_NAME" || true
  systemctl disable "$SERVICE_NAME" || true
else
  echo "Service systemd non trouvé, on continue."
fi

# ==========================
# Remove systemd file
# ==========================
if [[ -f "$SERVICE_FILE" ]]; then
  echo "Suppression du service systemd…"
  rm -f "$SERVICE_FILE"
fi

systemctl daemon-reload

# ==========================
# Remove app files
# ==========================
if [[ -d "$APP_DIR" ]]; then
  echo "Suppression de $APP_DIR"
  rm -rf "$APP_DIR"
fi

# ==========================
# Remove radio_cli + links
# ==========================
if [[ -L "$SBIN_LINK" || -f "$SBIN_LINK" ]]; then
  echo "Suppression du lien $SBIN_LINK"
  rm -f "$SBIN_LINK"
fi

if [[ -d "$BIN_DIR" ]]; then
  echo "Suppression de $BIN_DIR"
  rm -rf "$BIN_DIR"
fi

# ==========================
# Remove logs & data
# ==========================
if [[ -d "$LOG_DIR" ]]; then
  echo "Suppression des logs $LOG_DIR"
  rm -rf "$LOG_DIR"
fi

if [[ -d "$DATA_DIR" ]]; then
  echo "Suppression des données $DATA_DIR"
  rm -rf "$DATA_DIR"
fi

echo
echo "Tout a été supprimé."
echo "Aucun service uGreen/DAB actif."
echo "Système propre. Âme un peu vide, mais propre."
