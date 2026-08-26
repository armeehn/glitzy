#!/bin/bash
# Provision the Glitzy studio onto a fresh Ubuntu 22.04+ host.
#
#   studio/deploy/provision.sh <user@host> [--ssh-key <path>] [--port 8090]
#
# Idempotent: safe to re-run. It installs ffglitch, the Python dependencies,
# the engine, and a systemd unit sized from the target's own RAM and disk.
#
# Works on x86_64 and arm64. ffglitch publishes both for Linux -- but note the
# ARM build is a **.7z**, not a .zip, which is why it is easy to conclude from
# the download page that Linux ARM does not exist. It does.
#
# What this does NOT do, on purpose:
#
#   The engine has no authentication of its own and binds 0.0.0.0. On a private
#   network it sits behind an authenticating reverse proxy. If you are putting
#   this on a public host, PUT A GATE IN FRONT OF IT before you point a domain
#   at it: it accepts file uploads and runs ffmpeg-family subprocesses on them.
#   This script binds it to localhost by default for exactly that reason --
#   pass --bind 0.0.0.0 only when something else is doing the gating.
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <user@host> [--ssh-key <path>] [--port N] [--bind ADDR]" >&2; exit 1; }
shift

SSH_KEY=""; PORT=8090; BIND=127.0.0.1
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --port)    PORT="$2";    shift 2 ;;
    --bind)    BIND="$2";    shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

SRC="$(cd "$(dirname "$0")/.." && pwd)"          # the studio/ directory
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[ -n "$SSH_KEY" ] && SSH+=(-i "$SSH_KEY")

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

# --- 1. look at the machine before deciding anything --------------------------
say "inspecting $TARGET"
INFO="$("${SSH[@]}" "$TARGET" 'set -e
  . /etc/os-release
  printf "%s %s %s %s\n" \
    "$(uname -m)" \
    "$(free -m | awk "\$1==\"Mem:\"{print \$2}")" \
    "$(df -Pm / | awk "NR==2{print \$4}")" \
    "$ID"')"
read -r ARCH MEM_MB DISK_MB OSID <<<"$INFO"
# `df` prints a header and `free` prints several lines; both were read wrongly
# in the first cut of this script, which produced "disk=AvailableMB" and an
# arithmetic error 40 lines later rather than a complaint here. Fail loudly.
case "$MEM_MB$DISK_MB" in *[!0-9]*|'') echo "could not read host facts: '$INFO'" >&2; exit 1 ;; esac

case "$ARCH" in
  x86_64)  FFG_URL=https://ffglitch.org/pub/bin/linux64/ffglitch-0.10.2-linux-x86_64.zip ;;
  aarch64) FFG_URL=https://ffglitch.org/pub/bin/linux-aarch64/ffglitch-0.10.2-linux-aarch64.7z ;;
  *) echo "unsupported architecture: $ARCH (ffglitch ships linux x86_64 and aarch64 only)" >&2; exit 1 ;;
esac
say "arch=$ARCH ram=${MEM_MB}MB disk=${DISK_MB}MB os=$OSID"

[ "$MEM_MB" -ge 1800 ] || {
  echo "ERROR: ${MEM_MB} MB of RAM. The engine needs a ~1.4 GB ceiling for a single" >&2
  echo "       render and will be OOM-killed below that -- which surfaces as a 502" >&2
  echo "       from the proxy, not as an engine error. 2 GB is the floor." >&2
  exit 1; }

# Sizing. Leave ~600 MB for the OS, then budget one render against the op that
# actually costs the most. That is colour.hsv, measured at 103.9 bytes per
# output pixel plus a ~31 MB fixed cost -- NOT the 75 B/px the warp family was
# once thought to bound (see the derivation in glitzyd/clip.py). 75 over-admits
# by ~39%, and the failure mode is an uncatchable SIGKILL that reaches the user
# as a 502, so round the divisor up rather than down.
MEM_MAX=$(( MEM_MB - 600 ));       [ "$MEM_MAX" -gt 6000 ] && MEM_MAX=6000
WORKERS=$(( (MEM_MAX - 400) / 1000 )); [ "$WORKERS" -lt 1 ] && WORKERS=1
[ "$WORKERS" -gt 4 ] && WORKERS=4
PER_RENDER_MB=$(( (MEM_MAX - 400) / WORKERS ))
MAX_PIXELS=$(( (PER_RENDER_MB - 31) * 1000000 / 104 ))
CACHE_GB=$(( DISK_MB / 1024 / 3 )); [ "$CACHE_GB" -lt 2 ] && CACHE_GB=2
[ "$CACHE_GB" -gt 40 ] && CACHE_GB=40
say "sizing: MemoryMax=${MEM_MAX}M workers=$WORKERS max_pixels=$MAX_PIXELS cache=${CACHE_GB}G"

# --- 2. dependencies ----------------------------------------------------------
say "installing packages"
# libdrm2 / libsdl2 / libasound2 are ffglitch's runtime dependencies. The
# published builds are configured --enable-sdl2 --enable-libdrm, so ffedit
# refuses to start without them even though it never opens a window. A fresh
# cloud image has none of them, and the failure is a dynamic-linker error at
# exec time -- the binary is present and executable and still cannot run.
# libasound2 is libasound2t64 on Debian 13 / Ubuntu 24.04, so try both.
"${SSH[@]}" "$TARGET" "set -e
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    python3 python3-numpy python3-pillow curl unzip libarchive-tools \
    libdrm2 libsdl2-2.0-0 >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libasound2t64 >/dev/null 2>&1 \
    || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libasound2 >/dev/null"

# --- 3. ffglitch --------------------------------------------------------------
say "installing ffglitch ($ARCH)"
"${SSH[@]}" "$TARGET" "set -e
  if [ -x /opt/ffglitch/bin/ffedit ] && /opt/ffglitch/bin/ffedit -version 2>&1 | grep -q 0.10.2; then
    echo '    already present'
  else
    tmp=\$(mktemp -d); cd \"\$tmp\"
    curl -fsSL -o pkg '$FFG_URL'
    # bsdtar (libarchive-tools) reads both .zip and .7z, so one extractor covers
    # both architectures; p7zip is not in Ubuntu's default components on arm64.
    bsdtar -xf pkg
    sudo mkdir -p /opt/ffglitch/bin
    sudo find . -type f \\( -name ffedit -o -name ffgac -o -name fflive -o -name qjs \\) \
      -exec install -m 755 {} /opt/ffglitch/bin/ \\;
    cd /; rm -rf \"\$tmp\"
  fi
  # Run it, and let a failure be a failure. Piping into head hides the exit
  # status behind head's own 0, which is how a linker error got all the way to
  # a passing health check on the first run of this script.
  if ! out=\$(/opt/ffglitch/bin/ffedit -version 2>&1); then
    echo \"ERROR: ffedit is installed but cannot run:\" >&2
    echo \"\$out\" | head -3 >&2
    ldd /opt/ffglitch/bin/ffedit 2>/dev/null | grep 'not found' >&2 || true
    exit 1
  fi
  echo \"    \$(echo \"\$out\" | head -1)\""

# --- 4. the engine ------------------------------------------------------------
say "copying the engine"
# --owner/--group are not cosmetic. This repo is normally checked out inside an
# unprivileged container, so its files carry a mapped uid (e.g. 101000) that the
# target cannot resolve; without these, tar aborts the transfer part-way through
# with "Cannot change ownership to uid 101000" on every single file.
tar -C "$SRC" --exclude=__pycache__ --exclude='*.pyc' \
    --owner=0 --group=0 --numeric-owner -cf - glitzyd rack web tests \
  | "${SSH[@]}" "$TARGET" "sudo mkdir -p /opt/glitzy /var/lib/glitzy && \
      sudo tar -C /opt/glitzy --no-same-owner -xf - && \
      sudo chown -R root:root /opt/glitzy"

# The OFL text must reach the host with the font it covers.
"${SSH[@]}" "$TARGET" "test -f /opt/glitzy/web/fonts/JetBrainsMono-OFL.txt" \
  || { echo 'ERROR: the font arrived without its licence' >&2; exit 1; }

say "installing the unit"
"${SSH[@]}" "$TARGET" "sudo tee /etc/systemd/system/glitzyd.service >/dev/null <<UNIT
[Unit]
Description=Glitzy engine (chain studio)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/glitzy
ExecStart=/usr/bin/python3 -m glitzyd.server
Environment=PYTHONUNBUFFERED=1
Environment=GLITZY_DATA=/var/lib/glitzy
Environment=GLITZY_WEB=/opt/glitzy/web
Environment=GLITZY_RACK=/opt/glitzy/rack
Environment=GLITZY_HOST=$BIND
Environment=GLITZY_PORT=$PORT
Environment=GLITZY_FFGAC=/opt/ffglitch/bin/ffgac
Environment=GLITZY_FFEDIT=/opt/ffglitch/bin/ffedit
Environment=GLITZY_MAX_WORKERS=$WORKERS
Environment=GLITZY_MAX_PIXELS=$MAX_PIXELS
Environment=GLITZY_CACHE_BUDGET=$(( CACHE_GB * 1024 * 1024 * 1024 ))
Restart=on-failure
RestartSec=2
# Sized from this host's RAM. Exceeding it SIGKILLs the whole cgroup, so the
# engine cannot catch it -- GLITZY_MAX_PIXELS above is what keeps work below it.
MemoryMax=${MEM_MAX}M
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable glitzyd >/dev/null 2>&1
# Restart unconditionally. \`enable --now\` returns 0 when the unit is already
# running, so an \`|| restart\` fallback never fires on a re-run and the host
# quietly keeps serving the previous code -- the deploy reports success and
# changes nothing.
sudo systemctl restart glitzyd"

# --- 5. prove it ---------------------------------------------------------------
say "verifying"
"${SSH[@]}" "$TARGET" "set -e
  for i in \$(seq 1 15); do
    if curl -sf -m 5 http://127.0.0.1:$PORT/api/health >/dev/null 2>&1; then break; fi
    sleep 1
  done
  h=\$(curl -sf -m 10 http://127.0.0.1:$PORT/api/health)
  echo \"    \$h\"
  echo \"\$h\" | grep -q '\"ok\": true'          || { echo 'health not ok' >&2; exit 1; }
  # Assert the ffglitch VERSION, not merely that the key exists -- the key is
  # always there and now carries the error string when the binary cannot run.
  echo \"\$h\" | grep -q '\"ffglitch\": \"ffglitch-' || { echo 'ffglitch did not report a version' >&2; exit 1; }
  echo \"\$h\" | grep -q '\"ops\": 50'            || { echo 'op library did not load' >&2; exit 1; }"

# A health endpoint is still only a health endpoint. Push one real frame
# through the ffedit path, because that is the thing the missing shared
# libraries actually broke, and nothing above would have caught it.
say "rendering a real frame through ffedit"
"${SSH[@]}" "$TARGET" "sudo GLITZY_DATA=/tmp/glitzy-smoke GLITZY_RACK=/opt/glitzy/rack \
    GLITZY_FFGAC=/opt/ffglitch/bin/ffgac GLITZY_FFEDIT=/opt/ffglitch/bin/ffedit \
    python3 -c \"
import sys; sys.path.insert(0, '/opt/glitzy')
from glitzyd import graph, ops, store
store.init(); ops.load_all()
    # The keys are width/height/frames. Unknown keys fall back to the defaults
    # (480x480x48) without complaining, so asserting the dimensions back is what
    # proves the parameters were actually applied and not silently ignored.
r = graph.evaluate([
    {'op': 'source.flow', 'params': {'width': 128, 'height': 128, 'frames': 2}},
    {'op': 'codec.smear', 'params': {}},
])
m = r['meta']
print('    rendered', m['n'], 'frames at', str(m['w']) + 'x' + str(m['h']),
      '| nodes:', len(r['steps']))
assert (m['n'], m['w'], m['h']) == (2, 128, 128), r
assert store.cached(r['hash']), 'result was not cached'
\" && sudo rm -rf /tmp/glitzy-smoke"

say "done -- glitzyd listening on $BIND:$PORT"
[ "$BIND" = "127.0.0.1" ] && cat <<'NOTE'

    Bound to localhost. The engine has NO authentication of its own, so put a
    reverse proxy with a gate in front of it before exposing it. Reaching it
    over a private overlay (Tailscale/WireGuard) needs no gate and no open port.
NOTE
