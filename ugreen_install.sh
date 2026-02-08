#!/bin/bash
#
# ugreen_install.sh – automated setup for the uGreen DAB board and web interface
#
# This script automates the installation of the proprietary uGreen DAB
# software alongside the Node.js based web interface provided in this
# repository.  It must be run with root privileges on a Debian/Raspbian
# system such as Raspberry Pi OS.  The procedure below is largely based
# on the commands published in uGreen’s FAQ, which instructs users to
# download the Files_v12 archive, extract it to /usr/local/lib and
# create symlinks to radio_cli and DABBoardRadio【713877084488398†L108-L116】.  Additional steps have been
# added to install dependencies such as wiringPi and libncurses5, set
# up Node.js, copy the web interface and register it as a service on
# port 9595.  You can customise the variables near the top of this
# script to suit a different version or architecture.

set -e

# Variables (edit these if new versions become available)
FILES_URL="https://ugreen.eu/wp-content/uploads/files/Files_v12.zip"
FILES_NAME="Files_v12.zip"
INSTALL_DIR="/usr/local/lib/ugreen-dab+"
RADIO_CLI_SYMLINK="/usr/local/sbin/radio_cli"
DAB_RADIO_SYMLINK="/usr/local/sbin/DABBoardRadio"
WEB_PORT=9595
WEB_ROOT="/opt/dab-web-interface"
SERVICE_NAME="dab-webserver"

download_ugreen() {
  echo "Downloading uGreen DAB software from $FILES_URL…"
  wget -O "/tmp/$FILES_NAME" "$FILES_URL"
  echo "Extracting…"
  unzip -o "/tmp/$FILES_NAME" -d /usr/local/lib
  # After extraction, uGreen’s archive may unpack as DABBoard/ instead of Files_v12.
  # Detect the extracted directory name.  If multiple directories are present
  # (e.g. during an update), prefer the one containing radio_cli.
  extracted_dir=""
  if [ -d "/usr/local/lib/DABBoard" ]; then
    extracted_dir="/usr/local/lib/DABBoard"
  elif [ -d "/usr/local/lib/${FILES_NAME%.zip}" ]; then
    extracted_dir="/usr/local/lib/${FILES_NAME%.zip}"
  else
    # Fallback: choose the first directory containing radio_cli
    for d in /usr/local/lib/*; do
      if [ -d "$d" ] && compgen -G "$d/radio_cli*" >/dev/null; then
        extracted_dir="$d"
        break
      fi
    done
  fi
  if [ -z "$extracted_dir" ]; then
    echo "Error: could not locate extracted uGreen directory after unzip." >&2
    exit 1
  fi
  # Move or rename the extracted directory into the installation directory.  If
  # INSTALL_DIR already exists, remove it first to avoid mixing versions.
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
  fi
  mv -f "$extracted_dir" "$INSTALL_DIR"

  # The uGreen archive contains multiple versions of the binaries for
  # different CPU architectures (e.g. 32‑bit arm, 64‑bit arm, x86_64).
  # Choose the correct binary for this system based on the output
  # of `uname -m`.  As documented in the uGreen I2S guide, a 64‑bit
  # Raspberry Pi requires the 64‑bit version of radio_cli【487981551829083†L124-L136】.
  arch="$(uname -m)"
  radio_cli_bin=""
  dab_radio_bin=""
  # Iterate over all radio_cli* files and pick the first that matches
  # the detected architecture.  Fallback to the plain radio_cli if no
  # architecture suffix is found.
  for candidate in "$INSTALL_DIR"/radio_cli*; do
    case "${candidate##*/}" in
      *64*|*aarch64*)
        if [[ "$arch" == aarch64* ]]; then radio_cli_bin="$candidate"; fi;;
      *32*|*armv7*|*armhf*)
        if [[ "$arch" == armv7* || "$arch" == arm* ]]; then radio_cli_bin="$candidate"; fi;;
      *x86_64*)
        if [[ "$arch" == x86_64* ]]; then radio_cli_bin="$candidate"; fi;;
      *)
        # Default fallback (no suffix)
        if [ -z "$radio_cli_bin" ]; then radio_cli_bin="$candidate"; fi;;
    esac
  done
  # Similarly choose the correct DABBoardRadio binary.
  for candidate in "$INSTALL_DIR"/DABBoardRadio*; do
    case "${candidate##*/}" in
      *64*|*aarch64*)
        if [[ "$arch" == aarch64* ]]; then dab_radio_bin="$candidate"; fi;;
      *32*|*armv7*|*armhf*)
        if [[ "$arch" == armv7* || "$arch" == arm* ]]; then dab_radio_bin="$candidate"; fi;;
      *x86_64*)
        if [[ "$arch" == x86_64* ]]; then dab_radio_bin="$candidate"; fi;;
      *)
        if [ -z "$dab_radio_bin" ]; then dab_radio_bin="$candidate"; fi;;
    esac
  done
  # Create symlinks pointing to the selected binaries
  if [ -n "$radio_cli_bin" ]; then
    ln -sf "$radio_cli_bin" "$RADIO_CLI_SYMLINK"
  else
    echo "Warning: could not determine appropriate radio_cli binary; defaulting to first match."
    ln -sf "$INSTALL_DIR"/radio_cli* "$RADIO_CLI_SYMLINK"
  fi
  if [ -n "$dab_radio_bin" ]; then
    ln -sf "$dab_radio_bin" "$DAB_RADIO_SYMLINK"
  else
    echo "Warning: could not determine appropriate DABBoardRadio binary; defaulting to first match."
    ln -sf "$INSTALL_DIR"/DABBoardRadio* "$DAB_RADIO_SYMLINK"
  fi
  echo "uGreen binaries installed in $INSTALL_DIR (architecture: $arch)"
}

install_deps() {
  echo "Updating package lists and installing dependencies…"
  apt-get update
  apt-get install -y libncurses5 git unzip curl
  # arecord/aplay are provided by alsa-utils (for audio monitoring)
  apt-get install -y alsa-utils
  # Install wiringPi if gpio command is absent (deprecated on recent systems)
  if ! command -v gpio >/dev/null 2>&1; then
    echo "Installing wiringPi library…"
    git clone https://github.com/WiringPi/WiringPi /tmp/wiringPi
    (cd /tmp/wiringPi && ./build)
  fi
  # Enable SPI and GPIO access for non‑root users by adding the current
  # user to the appropriate groups; this allows the Node.js service to
  # access /dev/spidev0.* and /dev/gpiomem without running as root.
  if getent group spi >/dev/null; then
    usermod -aG spi $(logname)
  fi
  if getent group gpio >/dev/null; then
    usermod -aG gpio $(logname)
  fi
}

install_node() {
  echo "Installing Node.js (via Nodesource)…"
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
}

deploy_web_interface() {
  echo "Deploying web interface to $WEB_ROOT…"
  mkdir -p "$WEB_ROOT"
  # Copy the contents of the repository's dab-web-interface directory to
  # the target location.  This assumes the script is executed from the
  # root of the repository or that dab-web-interface exists relative to
  # this script.
  if [ -d dab-web-interface ]; then
    cp -r dab-web-interface/* "$WEB_ROOT/"
  else
    echo "Error: dab-web-interface directory not found.  Run this script from the repository root."
    exit 1
  fi
  cd "$WEB_ROOT"
  npm install --production
}

create_service() {
  echo "Creating systemd service for web interface…"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=uGreen DAB Web Interface
After=network.target

[Service]
Environment=PORT=${WEB_PORT}
WorkingDirectory=${WEB_ROOT}
ExecStart=/usr/bin/node ${WEB_ROOT}/app.js
Restart=always
User=$(logname)
Group=$(logname)

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable ${SERVICE_NAME}
  systemctl restart ${SERVICE_NAME}
}

echo "This script will install the uGreen DAB software and a web interface." 
echo "It must be run as root.  Continue? [y/N]"
read -r answer
case "$answer" in
  [Yy]*) ;;
  *) echo "Aborted."; exit 1;;
esac

install_deps
download_ugreen
install_node
deploy_web_interface
create_service

echo "\nInstallation complete.  The web interface should now be accessible at http://$(hostname -I | awk '{print $1}'):${WEB_PORT}/"
echo "Reboot your system to ensure group permissions take effect."
