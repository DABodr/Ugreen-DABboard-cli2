#!/usr/bin/env bash
set -euo pipefail

# uGreen DABBoard installer (Files_v16+ aware)
# - Installs uGreen CLI tools under /usr/local/lib/ugreen-dab+
# - Creates symlinks in /usr/local/sbin (radio_cli, DABBoardRadio, get_station_text)
# - Picks the correct binary for your OS (32-bit vs 64-bit) on Raspberry Pi OS / Debian

# You can override these:
UGREEN_ZIP_URL="${UGREEN_ZIP_URL:-https://ugreen.eu/wp-content/uploads/files/Files_v16.zip}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/lib/ugreen-dab+}"
SBIN_DIR="${SBIN_DIR:-/usr/local/sbin}"
TMP_ZIP="${TMP_ZIP:-/tmp/ugreen_files.zip}"
TMP_DIR="${TMP_DIR:-/tmp/ugreen_extract}"
RADIO_CLI_SYMLINK="${RADIO_CLI_SYMLINK:-$SBIN_DIR/radio_cli}"
DABBOARD_SYMLINK="${DABBOARD_SYMLINK:-$SBIN_DIR/DABBoardRadio}"
GET_STATION_SYMLINK="${GET_STATION_SYMLINK:-$SBIN_DIR/get_station_text}"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1"; exit 1; }; }

echo "==> Checking dependencies…"
need_cmd wget
need_cmd unzip
need_cmd uname
need_cmd getconf
need_cmd file
need_cmd install

BITS="$(getconf LONG_BIT || true)"
ARCH="$(uname -m || true)"
echo "==> Detected: ARCH=$ARCH, BITS=$BITS"

if [[ "$EUID" -ne 0 ]]; then
  echo "Please run as root (sudo)."
  exit 1
fi

echo "==> Downloading uGreen DAB software from: $UGREEN_ZIP_URL"
rm -f "$TMP_ZIP"
if ! wget -O "$TMP_ZIP" "$UGREEN_ZIP_URL"; then
  echo "Download failed (wget). Check your internet or URL."
  exit 1
fi

echo "==> Extracting…"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
if ! unzip -q "$TMP_ZIP" -d "$TMP_DIR"; then
  echo "Unzip failed. The ZIP might be corrupted."
  exit 1
fi

# Find the extracted root folder (Files_v16, Files_v12, etc.)
EXTRACT_ROOT=""
for d in "$TMP_DIR"/*; do
  [[ -d "$d" ]] || continue
  base="$(basename "$d")"
  if [[ "$base" == Files_v* || "$base" == DABBoard* ]]; then
    EXTRACT_ROOT="$d"
    break
  fi
done

if [[ -z "$EXTRACT_ROOT" ]]; then
  echo "Could not find extracted Files_v* folder in $TMP_DIR"
  ls -la "$TMP_DIR" || true
  exit 1
fi

echo "==> Found extracted root: $EXTRACT_ROOT"

# Install files (keep a clean target)
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR"/*
cp -a "$EXTRACT_ROOT"/. "$INSTALL_DIR"/

# Helper: pick correct bin folder if present (Files_v16+ layout)
BIN_BASE=""
if [[ -d "$INSTALL_DIR/bin" ]]; then
  if [[ "$BITS" == "64" && -d "$INSTALL_DIR/bin/64-bit" ]]; then
    BIN_BASE="$INSTALL_DIR/bin/64-bit"
  elif [[ "$BITS" == "32" && -d "$INSTALL_DIR/bin/32-bit" ]]; then
    BIN_BASE="$INSTALL_DIR/bin/32-bit"
  fi
fi

# Fallback: old layout (Files_v12 etc.) where executables are in root
if [[ -z "$BIN_BASE" ]]; then
  BIN_BASE="$INSTALL_DIR"
fi

echo "==> Using binaries from: $BIN_BASE"

pick_latest() {
  # $1 = glob pattern
  # prints best candidate path or empty
  local pattern="$1"
  local best=""
  shopt -s nullglob
  local matches=( $pattern )
  shopt -u nullglob
  if (( ${#matches[@]} == 0 )); then
    echo ""
    return 0
  fi
  # sort by version-ish (vX.Y.Z) then take last
  best="$(printf "%s\n" "${matches[@]}" | sort -V | tail -n 1)"
  echo "$best"
}

RADIO_CLI_BIN="$(pick_latest "$BIN_BASE/radio_cli_v"* )"
DABBOARD_BIN="$(pick_latest "$BIN_BASE/DABBoardRadio_v"* )"

# Some zips might name without _v prefix; keep a safe fallback
if [[ -z "$RADIO_CLI_BIN" ]]; then
  RADIO_CLI_BIN="$(pick_latest "$BIN_BASE/radio_cli"* )"
fi
if [[ -z "$DABBOARD_BIN" ]]; then
  DABBOARD_BIN="$(pick_latest "$BIN_BASE/DABBoardRadio"* )"
fi

# get_station_text is usually a script at root
GET_STATION_SRC=""
if [[ -f "$INSTALL_DIR/get_station_text.sh" ]]; then
  GET_STATION_SRC="$INSTALL_DIR/get_station_text.sh"
elif [[ -f "$BIN_BASE/get_station_text.sh" ]]; then
  GET_STATION_SRC="$BIN_BASE/get_station_text.sh"
fi

echo "==> Selected:"
echo "   radio_cli:     ${RADIO_CLI_BIN:-<not found>}"
echo "   DABBoardRadio: ${DABBOARD_BIN:-<not found>}"
echo "   get_station:   ${GET_STATION_SRC:-<not found>}"

if [[ -z "$RADIO_CLI_BIN" || ! -f "$RADIO_CLI_BIN" ]]; then
  echo "ERROR: radio_cli binary not found."
  echo "Contents of $BIN_BASE:"
  ls -la "$BIN_BASE" || true
  exit 1
fi

# Install canonical names into INSTALL_DIR root (so our symlinks are stable)
install -m 0755 "$RADIO_CLI_BIN" "$INSTALL_DIR/radio_cli"
if [[ -n "$DABBOARD_BIN" && -f "$DABBOARD_BIN" ]]; then
  install -m 0755 "$DABBOARD_BIN" "$INSTALL_DIR/DABBoardRadio"
fi
if [[ -n "$GET_STATION_SRC" && -f "$GET_STATION_SRC" ]]; then
  install -m 0755 "$GET_STATION_SRC" "$INSTALL_DIR/get_station_text.sh"
fi

# Symlinks
mkdir -p "$SBIN_DIR"
ln -sf "$INSTALL_DIR/radio_cli" "$RADIO_CLI_SYMLINK"
[[ -f "$INSTALL_DIR/DABBoardRadio" ]] && ln -sf "$INSTALL_DIR/DABBoardRadio" "$DABBOARD_SYMLINK" || true
[[ -f "$INSTALL_DIR/get_station_text.sh" ]] && ln -sf "$INSTALL_DIR/get_station_text.sh" "$GET_STATION_SYMLINK" || true

echo "==> Verifying binaries…"
echo "   file radio_cli: $(file -b "$INSTALL_DIR/radio_cli")"

if ! "$INSTALL_DIR/radio_cli" --help >/dev/null 2>&1; then
  echo "WARNING: radio_cli does not seem to run on this system."
  echo "This usually means: wrong OS bitness (32 vs 64) or missing dynamic loader."
  echo "Try:"
  echo "  getconf LONG_BIT"
  echo "  file $INSTALL_DIR/radio_cli"
  echo "  ldd $INSTALL_DIR/radio_cli || true"
  exit 2
fi

echo
echo "✅ Installed uGreen tools:"
echo "  $RADIO_CLI_SYMLINK  -> $INSTALL_DIR/radio_cli"
if [[ -f "$INSTALL_DIR/DABBoardRadio" ]]; then
  echo "  $DABBOARD_SYMLINK  -> $INSTALL_DIR/DABBoardRadio"
fi
if [[ -f "$INSTALL_DIR/get_station_text.sh" ]]; then
  echo "  $GET_STATION_SYMLINK -> $INSTALL_DIR/get_station_text.sh"
fi
echo
echo "Next: restart your web interface service (if installed):"
echo "  sudo systemctl restart dab-webserver"
