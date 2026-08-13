#!/bin/bash
# Push the working tree into LXC 114 and restart the engine.
#
# The container's rootfs is a ZFS subvol the host can write directly, which is
# faster and less fiddly than `pct push` for a whole tree. Nothing here touches
# the v1 service: v2 lives in its own prefix and its own unit until it is
# proven, so a broken deploy cannot take glitchsheet.hq down.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT=/z1-pool/subvol-114-disk-0
DEST="$ROOT/opt/glitchsheet2"

mkdir -p "$DEST"
rm -rf "$DEST/glitchd" "$DEST/web" "$DEST/rack" "$DEST/tests"
cp -r "$SRC/app/glitchd" "$DEST/glitchd"
cp -r "$SRC/app/rack"    "$DEST/rack"
[ -d "$SRC/app/web" ]   && cp -r "$SRC/app/web"   "$DEST/web"
[ -d "$SRC/tests" ]     && cp -r "$SRC/tests"     "$DEST/tests"
find "$DEST" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

echo "deployed to 114:/opt/glitchsheet2"
if [ "${1:-}" = "--restart" ]; then
  pct exec 114 -- systemctl restart glitchd2 2>/dev/null \
    && echo "glitchd2 restarted" \
    || echo "glitchd2 not installed yet (run install.sh inside the container)"
fi
