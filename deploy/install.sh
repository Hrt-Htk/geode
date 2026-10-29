#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Geode turnkey install script
#
# Run as root on a fresh Ubuntu server.  Idempotent where reasonable.
#
# Usage:
#   sudo bash deploy/install.sh
#   sudo GEODE_DOMAIN=geode.example.com bash deploy/install.sh
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Defaults (override via environment) ───────────────────────────────
GEODE_DIR="${GEODE_DIR:-/opt/geode}"
GEODE_USER="${GEODE_USER:-geode}"
GEODE_PORT="${GEODE_PORT:-8080}"
GEODE_DOMAIN="${GEODE_DOMAIN:-}"
DENO_VERSION="${DENO_VERSION:-2.9.7}"

# ── 1. Require root ──────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root (use sudo)." >&2
  exit 1
fi

echo "=== Geode install ==="

# Bind to localhost when a public domain + Caddy front the service (deploy/Caddyfile
# proxies to 127.0.0.1); bind 0.0.0.0 for direct LAN/Tailscale clients.
if [ -n "$GEODE_DOMAIN" ]; then
  GEODE_HOST="127.0.0.1"
else
  GEODE_HOST="0.0.0.0"
fi

# ── 2. Install prerequisites and Deno ───────────────────────────────
missing=""
for pkg in curl unzip openssl ca-certificates; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
done
if [ -n "$missing" ]; then
  echo "Installing prerequisites:$missing"
  apt-get update -qq
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing
fi

# Pinned Deno: exact version, downloaded from the GitHub release and verified
# against its published .sha256sum (never curl | sh). The unit runs
# /usr/local/bin/deno by absolute path, so that's the binary we pin.
if [ -x /usr/local/bin/deno ] && /usr/local/bin/deno --version 2>/dev/null | grep -q "^deno ${DENO_VERSION} "; then
  echo "Deno ${DENO_VERSION} already installed at /usr/local/bin/deno, skipping install."
else
  echo "Installing pinned Deno ${DENO_VERSION} to /usr/local/bin..."
  case "$(uname -m)" in
    x86_64) DENO_ARCH="x86_64" ;;
    aarch64|arm64) DENO_ARCH="aarch64" ;;
    *) echo "ERROR: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  DENO_BASE="https://github.com/denoland/deno/releases/download/v${DENO_VERSION}"
  DENO_ZIP="deno-${DENO_ARCH}-unknown-linux-gnu.zip"
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/$DENO_ZIP" "$DENO_BASE/$DENO_ZIP"
  curl -fsSL -o "$TMP/$DENO_ZIP.sha256sum" "$DENO_BASE/$DENO_ZIP.sha256sum"
  ( cd "$TMP" && sha256sum -c "$DENO_ZIP.sha256sum" )
  unzip -oq "$TMP/$DENO_ZIP" -d "$TMP"
  install -m 0755 "$TMP/deno" /usr/local/bin/deno
  rm -rf "$TMP"
  echo "Deno installed: $(deno --version | head -1)"
fi

# ── 3. Create system user ─────────────────────────────────────────────
if ! id "$GEODE_USER" &>/dev/null; then
  echo "Creating system user '$GEODE_USER'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$GEODE_USER"
else
  echo "User '$GEODE_USER' already exists, skipping."
fi

# ── 4. Lay down the repo ──────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Deploying repo to $GEODE_DIR ..."
mkdir -p "$GEODE_DIR/data"

# Copy the code without rsync (missing on minimal images). Drop stale code
# dirs first so re-runs don't leave removed files behind; data/ and
# .admin-token are preserved across re-runs.
for dir in server core db deploy; do
  rm -rf "$GEODE_DIR/$dir"
  cp -a "$REPO_ROOT/$dir" "$GEODE_DIR/"
done
for file in deno.json deno.lock; do
  cp -f "$REPO_ROOT/$file" "$GEODE_DIR/"
done

# #736: the repo's package.json also carries the dev toolchain (Playwright, the
# Obsidian/Electron typings, eslint, jscpd, typescript), and `deno install`
# installs what deno.lock records for it: 15 npm packages / 109 MB on a server
# that runs 5 / 15 MB. It imports package.json for its version only, so ship a
# production one: the install below then fetches the server's surface alone and
# reduces the lockfile to it.
printf '{"name":"geode","private":true,"license":"Apache-2.0","version":"%s"}\n' \
  "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)" \
  > "$GEODE_DIR/package.json"

chown -R "$GEODE_USER":"$GEODE_USER" "$GEODE_DIR"
# data/ holds the SQLite DB with device tokens in plaintext: root-only traversable.
chmod 700 "$GEODE_DIR/data"

echo "Repo deployed to $GEODE_DIR"

# ── 5. Generate admin token ───────────────────────────────────────────
ADMIN_TOKEN_FILE="$GEODE_DIR/.admin-token"

if [ -f "$ADMIN_TOKEN_FILE" ]; then
  ADMIN_TOKEN="$(cat "$ADMIN_TOKEN_FILE")"
  echo "Reusing existing admin token from $ADMIN_TOKEN_FILE"
else
  echo "Generating admin token..."
  if command -v openssl &>/dev/null; then
    ADMIN_TOKEN="$(openssl rand -base64 36 | tr -d '\n/+=' | cut -c1-40)"
  else
    # Fallback: /dev/urandom + base64
    ADMIN_TOKEN="$(head -c 30 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-40)"
  fi
  printf '%s' "$ADMIN_TOKEN" > "$ADMIN_TOKEN_FILE"
  echo "Admin token generated and saved to $ADMIN_TOKEN_FILE"
fi

# Outside the if/else on purpose: a re-run's `chown -R "$GEODE_USER"` above hands an
# existing token file to the service user, which would let a compromised geode process
# read the admin token back (#680 N-8).
chmod 600 "$ADMIN_TOKEN_FILE"
chown root:root "$ADMIN_TOKEN_FILE"

# Mirror the token into the root-only systemd EnvironmentFile. Re-runs reuse the
# same token (read above), so this file stays stable. Kept 600 root:root: systemd
# (PID 1) reads it at unit load; the geode process never needs to.
ENV_FILE="/etc/geode/geode.env"
mkdir -p "$(dirname "$ENV_FILE")"
printf 'GEODE_ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
chmod 700 "$(dirname "$ENV_FILE")"
echo "Admin token written to $ENV_FILE (mode 600, root:root)"

# ── 5.5. Locate the system libsqlite3 for @db/sqlite (FFI) ────────────
# The .so lives under an arch-specific dir (x86_64-linux-gnu vs
# aarch64-linux-gnu), so resolve it here; override with DENO_SQLITE_PATH.
if [ -z "${DENO_SQLITE_PATH:-}" ]; then
  if ! dpkg -s libsqlite3-0 >/dev/null 2>&1; then
    echo "Installing libsqlite3-0 (required by @db/sqlite)..."
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libsqlite3-0
  fi
  DENO_SQLITE_PATH="$(dpkg -L libsqlite3-0 | grep -m1 '/libsqlite3\.so\.0$')"
fi
SQLITE_DIR="$(dirname "$DENO_SQLITE_PATH")"

# ── 6. Install systemd unit ───────────────────────────────────────────
echo "Installing systemd unit..."

# Copy the template and substitute values. The token is NOT substituted here:
# the unit loads it from $ENV_FILE via EnvironmentFile=.
sed \
  -e "s|@HOST@|${GEODE_HOST}|g" \
  -e "s|@GEODE_PORT@|${GEODE_PORT}|g" \
  -e "s|@SQLITE_LIB@|${DENO_SQLITE_PATH}|" \
  -e "s|@SQLITE_DIR@|${SQLITE_DIR}|" \
  "$GEODE_DIR/deploy/geode.service" \
  > /etc/systemd/system/geode.service

# Pre-fetch Deno dependencies into the service's cache so first start needs
# no network (the unit's --allow-net only permits the server port). The shipped
# package.json is the production one, so this fetches only the server's surface.
echo "Pre-fetching Deno dependencies..."
( cd "$GEODE_DIR" && DENO_DIR="$GEODE_DIR/.deno-cache" HOME="$GEODE_DIR" /usr/local/bin/deno install )
chown -R "$GEODE_USER":"$GEODE_USER" "$GEODE_DIR/.deno-cache"

# enable, then restart: restart also starts an inactive unit, but unlike
# `enable --now` it replaces a running one, so a re-run serves the new code.
systemctl daemon-reload
systemctl enable geode
systemctl restart geode
echo "geode service enabled and (re)started."

# ── 7. Caddy / TLS ───────────────────────────────────────────────────
if [ -n "$GEODE_DOMAIN" ]; then
  caddy_fresh=0
  if ! command -v caddy &>/dev/null; then
    echo "Installing Caddy from the official apt repo..."
    apt-get install -y -qq debian-keyring debian-archive-keyring gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
    caddy_fresh=1
  fi

  TARGET=/etc/caddy/Caddyfile
  GENERATED="$GEODE_DIR/deploy/Caddyfile.generated"

  # #736: /etc/caddy/Caddyfile is not always Geode's file - one Caddyfile can
  # serve several sites. Install it only when Geode owns it: Caddy was installed
  # by this run, the file is missing, its first line is our marker, or it is
  # exactly what the last install generated (an install from before the marker).
  # The copy used to be a manual install step, so a Caddy fix in a release (the
  # device-token log filter, #727/#733) never reached a running server.
  keeps_previous_generated=0
  if cmp -s "$GENERATED" "$TARGET"; then
    keeps_previous_generated=1
  fi

  sed "s|geode\.example\.com|${GEODE_DOMAIN}|g" \
    "$GEODE_DIR/deploy/Caddyfile" \
    > "$GENERATED"

  marker="$(head -1 "$GENERATED")"
  if [ "$caddy_fresh" -eq 1 ] || [ ! -e "$TARGET" ] ||
    [ "$marker" = "$(head -1 "$TARGET" 2>/dev/null)" ] ||
    [ "$keeps_previous_generated" -eq 1 ]; then
    install -m 0644 "$GENERATED" "$TARGET"
    systemctl reload-or-restart caddy
    echo "Installed $TARGET and reloaded Caddy."
  else
    echo "NOTE: $TARGET is not Geode's file (it serves other sites), so it was left alone."
    echo "      Add the Geode site from $GENERATED yourself, then reload Caddy:"
    echo "        cp $GENERATED $TARGET && systemctl reload caddy"
  fi
else
  echo ""
  echo "NOTE: GEODE_DOMAIN is not set: Geode listens on 0.0.0.0:${GEODE_PORT} for LAN and"
  echo "      Tailscale clients. Never open port ${GEODE_PORT} to the internet."
  echo ""
fi

# ── 8. Summary ────────────────────────────────────────────────────────
# #735: the whole token used to be printed here, so it landed in terminal
# scrollback, any tee'd install log and anything the reader pasted. Show the
# start only; deploy/print-admin-token.sh prints all of it when it is needed.
echo "============================================="
echo "  Geode install complete"
echo "============================================="
echo ""
echo "  Admin token : ${ADMIN_TOKEN:0:4}… (start only, see below)"
echo "  Local URL   : http://127.0.0.1:${GEODE_PORT}"
[ -n "$GEODE_DOMAIN" ] && echo "  Public URL  : wss://${GEODE_DOMAIN}"
echo "  Check       : curl http://127.0.0.1:${GEODE_PORT}/version"
echo "                curl -s -H \"Authorization: Bearer \$(sudo cat $ADMIN_TOKEN_FILE)\" \\"
echo "                  http://127.0.0.1:${GEODE_PORT}/vaults   # [] until you create a vault"
echo ""
echo "  Next step:"
echo "    In Obsidian → Geode settings → Run setup wizard →"
echo "    Create a new vault, and paste the admin token."
echo ""
echo "  To print the admin token:"
echo "    sudo bash deploy/print-admin-token.sh"
echo ""
echo "  Server logs:"
echo "    journalctl -u geode -f"
echo ""
