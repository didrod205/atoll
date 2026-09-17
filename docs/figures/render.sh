#!/usr/bin/env bash
# Renders the README figures to docs/<name>-{light,dark}.png (2x) with headless Chrome.
#   docs/figures/render.sh overview:720 weights:640 discovery:700
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(dirname "$here")"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
for spec in "$@"; do
  name="${spec%%:*}"; height="${spec##*:}"
  for theme in light dark; do
    profile="$(mktemp -d)"
    file="$out/$name-$theme.png"
    rm -f "$file"
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
      --user-data-dir="$profile" --force-device-scale-factor=2 --window-size="1200,$height" \
      --virtual-time-budget=3000 --screenshot="$file" "file://$here/$name.html?theme=$theme" >/dev/null 2>&1 &
    pid=$!
    for _ in $(seq 1 60); do [ -s "$file" ] && break; sleep 0.5; done
    sleep 0.5; kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
    rm -rf "$profile"
    echo "$file"
  done
done
