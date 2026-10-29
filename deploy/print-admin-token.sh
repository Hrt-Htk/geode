#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Print the Geode admin token.
#
# Usage:
#   sudo bash deploy/print-admin-token.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

TOKEN_FILE="${GEODE_DIR:-/opt/geode}/.admin-token"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Admin token file not found at $TOKEN_FILE" >&2
  echo "       Run deploy/install.sh first, or check the path." >&2
  exit 1
fi

if [ ! -r "$TOKEN_FILE" ]; then
  echo "ERROR: Cannot read $TOKEN_FILE: likely needs root (sudo)." >&2
  exit 1
fi

cat "$TOKEN_FILE"
echo
