#!/bin/bash
# Mirror the working tree into the git workspace in LXC 111 and commit.
#
# The split exists because the two things live in different places: deploying
# needs the host (the container rootfs is a ZFS subvol only x can write, and
# `pct` is a host command), while the repo estate and git itself live in LXC
# 111 as the `user` account. So x holds the working copy and 111 holds history.
#
#   ./sync-to-git.sh "commit message"
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
MSG="${1:-update glitzy studio}"
REPO=/home/user/glitzy
TAR=/tmp/glitzy-sync.tar

tar -C "$SRC" --exclude=__pycache__ --exclude='*.pyc' --exclude=scratch \
    -cf "$TAR" .
pct push 111 "$TAR" "$TAR"

pct exec 111 -- su - user -c "
set -e
mkdir -p $REPO
cd $REPO
[ -d .git ] || git init -q
# Replace the tracked tree wholesale so deletions propagate, but keep .git.
find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
tar -xf $TAR -C $REPO
git add -A
git -c user.name='Glitzy' -c user.email='glitzy@hq' \
    commit -q -m \"\$(printf '%s' \"$MSG\")\" || echo 'nothing to commit'
git --no-pager log --oneline -3
git status --short | head
"
rm -f "$TAR"
echo "synced to 111:$REPO"
