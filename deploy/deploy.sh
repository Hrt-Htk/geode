#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Deploy Geode server to a host you own.
#
# Copies server files to /opt/geode, preserves data/ and .admin-token,
# installs Deno dependencies, and restarts the service.
#
# Usage:
#   GEODE_SSH_HOST=user@host ./deploy/deploy.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${GEODE_SSH_HOST:?set GEODE_SSH_HOST=user@host (see .env.example)}"
SSH_HOST="$GEODE_SSH_HOST"
REMOTE_DIR="/opt/geode"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

json_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1; }

echo "=== Geode deploy to $SSH_HOST ==="

# ── 1. Copy files to ~/geode-deploy-staging on the server ─────────────
echo "Uploading files..."
remote="$SSH_HOST:~/geode-deploy-staging"
ssh "$SSH_HOST" "rm -rf ~/geode-deploy-staging && mkdir -p ~/geode-deploy-staging"
scp -rq "$PROJECT_ROOT/server" "$PROJECT_ROOT/core" "$PROJECT_ROOT/db" "$remote/"
scp -q "$PROJECT_ROOT/deno.json" "$PROJECT_ROOT/deno.lock" "$remote/"
scp -q "$PROJECT_ROOT/deploy/geode-log" "$remote/geode-log"
# #736: a production package.json (version only). The repo one carries the dev
# toolchain, which `deno install` below would fetch onto the server.
printf '{"name":"geode","private":true,"license":"Apache-2.0","version":"%s"}\n' \
  "$(json_version < "$PROJECT_ROOT/package.json")" \
  | ssh "$SSH_HOST" "cat > ~/geode-deploy-staging/package.json"

# ── 2. Move into /opt/geode as root (preserves data/ and .admin-token) ─
echo "Installing to $REMOTE_DIR (preserving data/ and .admin-token)..."
ssh "$SSH_HOST" "bash -s" <<EOF
set -e
sudo mkdir -p $REMOTE_DIR/{server,core,db}

# Remove old code (NOT data/ or .admin-token)
sudo rm -rf $REMOTE_DIR/server/* $REMOTE_DIR/core/* $REMOTE_DIR/db/*

sudo cp -r ~/geode-deploy-staging/server/* $REMOTE_DIR/server/
sudo cp -r ~/geode-deploy-staging/core/*   $REMOTE_DIR/core/
sudo cp -r ~/geode-deploy-staging/db/*     $REMOTE_DIR/db/
sudo cp -f ~/geode-deploy-staging/deno.json ~/geode-deploy-staging/deno.lock ~/geode-deploy-staging/package.json $REMOTE_DIR/

sudo mkdir -p $REMOTE_DIR/.deno-cache
sudo chown -R geode:geode $REMOTE_DIR/{server,core,db} $REMOTE_DIR/.deno-cache

# Install the geode-log vault-inspection helper onto PATH (#216)
sudo cp -f ~/geode-deploy-staging/geode-log /usr/local/bin/geode-log
sudo chmod +x /usr/local/bin/geode-log

rm -rf ~/geode-deploy-staging
EOF

# ── 3. Install Deno dependencies on the server ────────────────────────
echo "Installing Deno dependencies..."
ssh "$SSH_HOST" "cd $REMOTE_DIR && sudo -u geode env DENO_DIR=$REMOTE_DIR/.deno-cache HOME=$REMOTE_DIR /usr/local/bin/deno install 2>&1"

# ── 4. Reload systemd and restart ─────────────────────────────────────
echo "Restarting geode service..."
ssh "$SSH_HOST" "sudo systemctl daemon-reload && sudo systemctl restart geode"

# ── 5. Verify ─────────────────────────────────────────────────────────
sleep 3
status="$(ssh "$SSH_HOST" "sudo systemctl is-active geode" || true)"
if [ "$status" != "active" ]; then
  echo "Service status: $status" >&2
  echo "Check logs: ssh $SSH_HOST 'sudo journalctl -u geode -n 50 --no-pager'" >&2
  exit 1
fi

# Version self-verify: the service runs --port 8090 (from ExecStart), not the code default 8080.
expected="$(json_version < "$PROJECT_ROOT/package.json")"
port="$(ssh "$SSH_HOST" "systemctl show geode -p ExecStart --value | grep -oP '(?<=--port )\d+'" 2>/dev/null || true)"
port="${port:-8080}"
live="$(ssh "$SSH_HOST" "curl -fsS http://127.0.0.1:$port/version" 2>/dev/null | json_version || true)"
if [ "$live" != "$expected" ]; then
  echo "[FAIL] live server /version (:$port) = '$live' but expected '$expected': deploy did NOT take." >&2
  echo "Check logs: ssh $SSH_HOST 'sudo journalctl -u geode -n 50 --no-pager'" >&2
  exit 1
fi

echo "Deploy complete! Service is active. Verified: live /version = $expected"
echo "Admin token: ssh $SSH_HOST 'sudo cat $REMOTE_DIR/.admin-token'"

# ── 6. BRAT release reminder ──────────────────────────────────────────
# This deploy updates the SERVER only; BRAT users get the plugin from a v* tag.
# #731: in a release the new v* tag already points at HEAD, so `describe` here
# returns that tag and the diff would be empty by construction. scripts/release.ts
# passes the tag being replaced; a standalone redeploy compares against the
# newest tag it can see.
prev_tag="${GEODE_PREV_TAG:-}"
[ -n "$prev_tag" ] ||
  prev_tag="$(git -C "$PROJECT_ROOT" describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
if [ -n "$prev_tag" ] &&
  ! git -C "$PROJECT_ROOT" rev-parse -q --verify "refs/tags/$prev_tag" >/dev/null; then
  prev_tag=""
fi
if [ -z "$prev_tag" ]; then
  echo "No v* release tag found yet - cut the first plugin release when ready."
elif [ -n "$(git -C "$PROJECT_ROOT" diff --name-only "$prev_tag..HEAD" -- plugin core)" ]; then
  echo "[!] plugin/ or core/ changed since $prev_tag - BRAT users get it only from a v* tag."
else
  echo "[ok] No plugin/core change since $prev_tag - no BRAT release needed."
fi
