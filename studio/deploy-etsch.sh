#!/bin/bash
# Publish Etsch to etsch.hq.ripostelabs.xyz.
#
# Etsch is static, so "deploying" is copying public/ into Caddy's own
# container. There is no upstream, no service to restart, and no reload needed
# for content changes -- only /etc/caddy/sites/165-etsch.caddy needs one.
#
# SOURCE is the tree that the tests actually ran against: LXC 111
# /root/cs-handoff, a copy of ~user/etsch carrying the #handoff= importer.
# When that change is merged upstream, point this at /home/user/etsch and
# delete the copy.
#
# LXC 104's rootfs is subvol-104-disk-1, NOT -disk-0 -- /z1-pool/subvol-104-disk-0
# exists, is writable and is stale, so writing there silently publishes nothing.
# Hence tar over pct exec rather than a host-side cp.
set -euo pipefail

SRC_CT=111
SRC_DIR=${SRC_DIR:-/root/cs-handoff/public}
DST_CT=104
DST_DIR=/var/www/etsch

pct exec "$SRC_CT" -- test -f "$SRC_DIR/index.html"
pct exec "$SRC_CT" -- test -f "$SRC_DIR/js/handoff.js"

pct exec "$DST_CT" -- rm -rf "$DST_DIR"
pct exec "$DST_CT" -- mkdir -p "$DST_DIR"
pct exec "$SRC_CT" -- tar -C "$SRC_DIR" -cf - . | pct exec "$DST_CT" -- tar -C "$DST_DIR" -xf -

echo "published $(pct exec "$DST_CT" -- find "$DST_DIR" -type f | wc -l) files to ${DST_CT}:${DST_DIR}"
pct exec "$DST_CT" -- test -f "$DST_DIR/js/handoff.js" && echo "handoff importer present"
