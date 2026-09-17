#!/usr/bin/env bash
# Installs the PokeDE bridge as a packaged KWin script (persistent across
# sessions — enable it in System Settings > Window Management > KWin Scripts).
# For ad-hoc loading into the running KWin instead, use `pokede bridge-load`.
set -euo pipefail
cd "$(dirname "$0")/.."

PKG="kwin/bridge"

if command -v kpackagetool6 >/dev/null 2>&1; then
    kpackagetool6 --type KWin/Script --upgrade "$PKG" \
        || kpackagetool6 --type KWin/Script --install "$PKG"
elif command -v kpackagetool5 >/dev/null 2>&1; then
    kpackagetool5 --type KWin/Script --upgrade "$PKG" \
        || kpackagetool5 --type KWin/Script --install "$PKG"
else
    # Manual fallback: link into the user kwin scripts dir.
    dest="${HOME}/.local/share/kwin/scripts/pokede-bridge"
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$(pwd)/$PKG" "$dest"
    echo "linked $PKG -> $dest (enable it in System Settings > KWin Scripts)"
fi
echo "done. To load into the *running* KWin: pokede bridge-load"
