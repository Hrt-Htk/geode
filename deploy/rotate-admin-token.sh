#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Rotate the Geode server admin token.
#
# Generates a new token (same way deploy/install.sh does), writes it to
# $GEODE_DIR/.admin-token and /etc/geode/geode.env (both 600 root:root),
# restarts the service, waits for /version, and proves the old token is
# refused and the new one accepted on 127.0.0.1. Device tokens are
# untouched. The new token is printed once.
#
# Usage:
#   sudo bash deploy/rotate-admin-token.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root (use sudo)." >&2
  exit 1
fi

GEODE_DIR="${GEODE_DIR:-/opt/geode}"
TOKEN_FILE="$GEODE_DIR/.admin-token"
ENV_FILE="/etc/geode/geode.env"
UNIT_FILE="/etc/systemd/system/geode.service"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Admin token file not found at $TOKEN_FILE" >&2
  echo "       Run deploy/install.sh first, or check GEODE_DIR." >&2
  exit 1
fi
if [ ! -f "$UNIT_FILE" ]; then
  echo "ERROR: Systemd unit not found at $UNIT_FILE" >&2
  echo "       Run deploy/install.sh first." >&2
  exit 1
fi

# Port from the installed unit (install.sh substitutes @GEODE_PORT@).
PORT="$(grep -o -- '--port [0-9][0-9]*' "$UNIT_FILE" | awk '{print $2}')"
PORT="${PORT:-8080}"
BASE_URL="http://127.0.0.1:${PORT}"

OLD_TOKEN="$(cat "$TOKEN_FILE")"

# Same generation as deploy/install.sh.
if command -v openssl &>/dev/null; then
  NEW_TOKEN="$(openssl rand -base64 36 | tr -d '\n/+=' | cut -c1-40)"
else
  NEW_TOKEN="$(head -c 30 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-40)"
fi

printf '%s' "$NEW_TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
chown root:root "$TOKEN_FILE"

# Mirror into the root-only systemd EnvironmentFile (same format as install.sh).
mkdir -p "$(dirname "$ENV_FILE")"
printf 'GEODE_ADMIN_TOKEN=%s\n' "$NEW_TOKEN" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
chmod 700 "$(dirname "$ENV_FILE")"

echo "New admin token generated; restarting geode service..."
systemctl restart geode

echo "Waiting for $BASE_URL/version ..."
up=""
for i in $(seq 1 30); do
  if up="$(curl -fsS --max-time 2 "$BASE_URL/version" 2>/dev/null)"; then
    break
  fi
  sleep 1
done
if [ -z "$up" ]; then
  echo "ERROR: server did not come back on $BASE_URL after restart." >&2
  echo "       Check: journalctl -u geode -n 40" >&2
  exit 1
fi
echo "Server is up: $up"

# Prove the rotation on a harmless admin-only route (GET /vaults, read-only).
old_status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OLD_TOKEN" "$BASE_URL/vaults")"
new_status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NEW_TOKEN" "$BASE_URL/vaults")"
if [ "$old_status" != "401" ]; then
  echo "ERROR: old admin token was NOT refused (got HTTP $old_status)." >&2
  exit 1
fi
if [ "$new_status" != "200" ]; then
  echo "ERROR: new admin token was NOT accepted (got HTTP $new_status)." >&2
  exit 1
fi
echo "Old token refused (401), new token accepted (200)."

echo "============================================="
echo "  Admin token rotated"
echo "============================================="
echo ""
echo "  New admin token : $NEW_TOKEN"
echo ""
echo "  Enter it in the plugin when you add or revoke a device."
echo "  Print it again: sudo bash deploy/print-admin-token.sh"
echo ""
