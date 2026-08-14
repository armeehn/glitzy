#!/bin/bash
# Push the studio into LXC 114 and restart the engine.
#
# The container's rootfs is a ZFS subvol the host can write directly, which is
# faster and less fiddly than `pct push` for a whole tree.
#
# Nothing here touches the v1 engine. v1 is `glitchd.service` on port 8080 --
# still its pre-rename name, on purpose, because it is the rollback and
# renaming it would break the one thing that has to keep working when this
# deploy does not. v2 is `glitzyd.service` on 8090 under its own prefix.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT=/z1-pool/subvol-114-disk-0
DEST="$ROOT/opt/glitzy"

mkdir -p "$DEST"
rm -rf "$DEST/glitzyd" "$DEST/web" "$DEST/rack" "$DEST/tests"
cp -r "$SRC/glitzyd" "$DEST/glitzyd"
cp -r "$SRC/rack"    "$DEST/rack"
[ -d "$SRC/web" ]   && cp -r "$SRC/web"   "$DEST/web"
[ -d "$SRC/tests" ] && cp -r "$SRC/tests" "$DEST/tests"
find "$DEST" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

# The OFL text has to reach the deployed tree with the font it covers -- the
# licence requires it to travel with any redistribution, and serving the font
# over HTTP is a redistribution.
if [ -f "$DEST/web/fonts/jetbrains-mono-latin.woff2" ] \
   && [ ! -f "$DEST/web/fonts/JetBrainsMono-OFL.txt" ]; then
  echo "ERROR: the font deployed without its licence" >&2
  exit 1
fi

echo "deployed to 114:/opt/glitzy"
if [ "${1:-}" = "--restart" ]; then
  pct exec 114 -- systemctl restart glitzyd 2>/dev/null \
    && echo "glitzyd restarted" \
    || echo "glitzyd not installed yet (see DEPLOY.md)"
fi
