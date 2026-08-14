#!/bin/bash
# Publish Etsch to the internal hostname, etsch.hq.ripostelabs.xyz.
#
# This is the *internal* copy, the one the studio hands sheets to. The public
# deployment is a Cloudflare Worker and has nothing to do with this script --
# see DEPLOY.md. Both serve the same etsch/public tree.
#
# Etsch is static, so "deploying" is copying public/ into Caddy's own
# container. There is no upstream, no service to restart, and no reload needed
# for content changes -- only /etc/caddy/sites/165-etsch.caddy needs one.
#
# The source is now the merged repository. It used to be a hand-made copy at
# /root/cs-handoff, because the #handoff= importer was written but never
# committed; that copy is dead and the change is in git.
#
# LXC 104's rootfs is subvol-104-disk-1, NOT -disk-0 -- /z1-pool/subvol-104-disk-0
# exists, is writable and is stale, so writing there silently publishes nothing
# while the site keeps answering a healthy-looking 302. Hence tar over pct exec
# rather than a host-side cp.
set -euo pipefail

SRC_CT=111
SRC_DIR=${SRC_DIR:-/home/user/glitzy/etsch/public}
DST_CT=104
DST_DIR=/var/www/etsch

pct exec "$SRC_CT" -- test -f "$SRC_DIR/index.html"
pct exec "$SRC_CT" -- test -f "$SRC_DIR/js/handoff.js"

pct exec "$DST_CT" -- rm -rf "$DST_DIR"
pct exec "$DST_CT" -- mkdir -p "$DST_DIR"
pct exec "$SRC_CT" -- tar -C "$SRC_DIR" -cf - . | pct exec "$DST_CT" -- tar -C "$DST_DIR" -xf -

echo "published $(pct exec "$DST_CT" -- find "$DST_DIR" -type f | wc -l) files to ${DST_CT}:${DST_DIR}"
pct exec "$DST_CT" -- test -f "$DST_DIR/js/handoff.js" && echo "handoff importer present"
