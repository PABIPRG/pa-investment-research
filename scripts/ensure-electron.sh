#!/usr/bin/env bash
# Ensure the Electron binary is installed for this platform.
#
# Why this exists: electron's own postinstall uses @electron-internal/extract-zip,
# which is broken on Windows (all published versions 1.0.1-1.0.5 ship *.node files
# without the required extract_zip.dll). So we skip electron's postinstall
# (ELECTRON_SKIP_BINARY_DOWNLOAD=1, see init.sh) and download + extract the zip here.
#
# Mirror can be overridden:  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Locate the installed electron package (pnpm layout: frontend/node_modules/.pnpm/electron@x.y.z/node_modules/electron)
ELECTRON_DIR="$(ls -d "$ROOT"/frontend/node_modules/.pnpm/electron@*/node_modules/electron 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "$ELECTRON_DIR" ]]; then
  echo "[ensure-electron] 未找到 electron 包，请先运行初始化（scripts/init.sh）。" >&2
  exit 1
fi

PKG_JSON="$ELECTRON_DIR/package.json"
if command -v cygpath >/dev/null 2>&1; then PKG_JSON="$(cygpath -w "$PKG_JSON")"; fi
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" "$PKG_JSON")"
DIST="$ELECTRON_DIR/dist"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM=win32; EXE=electron.exe ;;
  Darwin)               PLATFORM=darwin; EXE='Electron.app/Contents/MacOS/Electron' ;;
  *)                    PLATFORM=linux;  EXE=electron ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) ARCH="$(uname -m)" ;;
esac

# Already installed? (same check as electron's install.js, which strips a leading
# "v" via replace(/^v/, '') — electron 43+ zips ship "43.2.0", not "v43.2.0")
INSTALLED_VER="$(cat "$DIST/version" 2>/dev/null || true)"
if [[ -f "$DIST/version" && -f "$ELECTRON_DIR/path.txt" && -e "$DIST/$EXE" ]] \
   && [[ "${INSTALLED_VER#v}" == "$VERSION" ]] \
   && [[ "$(cat "$ELECTRON_DIR/path.txt")" == "$EXE" ]]; then
  exit 0
fi

MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron}"
ZIP="electron-v${VERSION}-${PLATFORM}-${ARCH}.zip"
URLS=("$MIRROR/$VERSION/$ZIP" "https://github.com/electron/electron/releases/download/v${VERSION}/$ZIP")

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[ensure-electron] 下载 Electron v$VERSION ($PLATFORM-$ARCH)..."
ZIPFILE="$TMP/$ZIP"
ok=0
for url in "${URLS[@]}"; do
  echo "  -> $url"
  if curl -L --fail --retry 3 -o "$ZIPFILE" "$url"; then ok=1; break; fi
done
[[ $ok == 1 ]] || { echo "[ensure-electron] 下载失败，请检查网络或设置 ELECTRON_MIRROR。" >&2; exit 1; }

echo "[ensure-electron] 解压到 $DIST ..."
rm -rf "$DIST"
mkdir -p "$DIST"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIPFILE" -d "$DIST"
elif tar -xf "$ZIPFILE" -C "$DIST" 2>/dev/null; then
  :  # Windows 10+ bsdtar handles zip
else
  powershell -NoProfile -Command "Expand-Archive -Force '$(cygpath -w "$ZIPFILE" 2>/dev/null || echo "$ZIPFILE")' '$(cygpath -w "$DIST" 2>/dev/null || echo "$DIST")'"
fi

# Move electron.d.ts up one level, same as electron's install.js
if [[ -f "$DIST/electron.d.ts" ]]; then
  mv "$DIST/electron.d.ts" "$ELECTRON_DIR/electron.d.ts"
fi
printf '%s' "$EXE" > "$ELECTRON_DIR/path.txt"

# Sanity check
if [[ ! -e "$DIST/$EXE" ]]; then
  echo "[ensure-electron] 解压后未找到 $DIST/$EXE" >&2
  exit 1
fi
echo "[ensure-electron] 完成：Electron v$VERSION 已就绪。"
