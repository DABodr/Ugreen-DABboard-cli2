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
  # Use wget with error handling; abort if download fails
  if ! wget -O "/tmp/$FILES_NAME" "$FILES_URL"; then
    echo "Error: failed to download uGreen files from $FILES_URL" >&2
    exit 1
  fi
  echo "Extracting…"
  if ! unzip -o "/tmp/$FILES_NAME" -d /usr/local/lib; then
    echo "Error: failed to extract /tmp/$FILES_NAME" >&2
    exit 1
  fi
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

  # Ensure the binaries are executable for all users.  Sometimes the
  # extracted files may lack executable bits, which would cause
  # permission errors when spawned by non‑root processes (EACCES).  Set
  # read and execute permissions for owner, group and others.
  chmod a+rx "$INSTALL_DIR"/radio_cli* || true
  chmod a+rx "$INSTALL_DIR"/DABBoardRadio* || true

  # The uGreen archive contains multiple versions of the binaries for
  # different CPU architectures (e.g. 32‑bit ARM, 64‑bit ARM, x86_64).
  # Choose the correct binary for this system based on the output of
  # `uname -m`.  If architecture‑specific binaries are not present
  # (e.g. only a generic `radio_cli_v3.1.0` exists), fall back to the
  # first match.  See the I2S documentation for details about
  # selecting the appropriate version【487981551829083†L124-L136】.
  arch="$(uname -m)"
  radio_cli_bin=""
  dab_radio_bin=""
  # Build a list of candidate binaries by searching recursively within
  # the installation directory.  Some versions of the uGreen archive
  # organise binaries inside subdirectories (e.g. armhf/aarch64) rather
  # than in the top level.  Use find to locate all potential radio_cli
  # and DABBoardRadio executables and exclude Markdown files.
  mapfile -t radio_candidates < <(find "$INSTALL_DIR" -type f -name 'radio_cli*' ! -name '*.md' 2>/dev/null)
  mapfile -t dab_candidates < <(find "$INSTALL_DIR" -type f -name 'DABBoardRadio*' ! -name '*.md' 2>/dev/null)
  # Function to select a binary from a list based on architecture patterns
  select_binary() {
    local arch_val="$1"; shift
    local -n _candidates=$1; shift
    local selected=""
    for candidate in "${_candidates[@]}"; do
      base="${candidate##*/}"
      case "$arch_val:$base" in
        *aarch64*:*aarch64*|*aarch64*:*64*|*aarch64*:*arm64*)
          selected="$candidate"; break;;
        *arm64*:*aarch64*|*arm64*:*64*|*arm64*:*arm64*)
          selected="$candidate"; break;;
        *armv7*:*armhf*|*armv7*:*32*|*armv7*:*armv7*|*armv7*:*armv6*|*armv7*:*arm*)
          selected="$candidate"; break;;
        *armv6*:*armhf*|*armv6*:*32*|*armv6*:*armv7*|*armv6*:*armv6*|*armv6*:*arm*)
          selected="$candidate"; break;;
        *armhf*:*armhf*|*armhf*:*32*|*armhf*:*armv7*|*armhf*:*armv6*|*armhf*:*arm*)
          selected="$candidate"; break;;
        *arm*:*armhf*|*arm*:*32*|*arm*:*armv7*|*arm*:*armv6*|*arm*:*arm*)
          selected="$candidate"; break;;
        *x86_64*:*x86_64*|*x86_64*:*64*)
          selected="$candidate"; break;;
      esac
    done
    # Fallback: pick the first candidate
    if [ -z "$selected" ] && [ "${#_candidates[@]}" -gt 0 ]; then
      selected="${_candidates[0]}"
    fi
    echo "$selected"
  }
  # Select the appropriate binary
  radio_cli_bin=$(select_binary "$arch" radio_candidates)
  dab_radio_bin=$(select_binary "$arch" dab_candidates)
  # Create symlinks pointing to the selected binaries
  if [ -n "$radio_cli_bin" ]; then
    ln -sf "$radio_cli_bin" "$RADIO_CLI_SYMLINK"
  else
    echo "Warning: could not determine appropriate radio_cli binary; defaulting to first match." >&2
    # Link to the first radio_cli file (non‑markdown) if present
    candidate=$(ls "$INSTALL_DIR"/radio_cli* 2>/dev/null | grep -v ".md$" | head -n 1 || true)
    [ -n "$candidate" ] && ln -sf "$candidate" "$RADIO_CLI_SYMLINK"
  fi
  if [ -n "$dab_radio_bin" ]; then
    ln -sf "$dab_radio_bin" "$DAB_RADIO_SYMLINK"
  else
    echo "Warning: could not determine appropriate DABBoardRadio binary; defaulting to first match." >&2
    candidate=$(ls "$INSTALL_DIR"/DABBoardRadio* 2>/dev/null | grep -v ".md$" | head -n 1 || true)
    [ -n "$candidate" ] && ln -sf "$candidate" "$DAB_RADIO_SYMLINK"
  fi
  echo "uGreen binaries installed in $INSTALL_DIR (architecture: $arch)"

  # Verify radio_cli is executable and functional.  If it fails to run
  # the script will emit a warning.  Do not exit on failure because
  # some versions of radio_cli may require additional configuration.
  if ! "$RADIO_CLI_SYMLINK" --help >/dev/null 2>&1; then
    echo "Warning: radio_cli does not seem to work correctly (unable to run --help)" >&2
  fi
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

echo -e "\nInstallation complete.  The web interface should now be accessible at http://$(hostname -I | awk '{print $1}'):${WEB_PORT}/"
echo "Reboot your system to ensure group permissions take effect."
