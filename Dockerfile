# Geode sync server. One image per architecture (linux/amd64, linux/arm64); the release
# builds each on a native runner and merges the two into one manifest (release.yml).
FROM denoland/deno:debian-2.9.7

# SQLite is reached over FFI (@db/sqlite ships no binary) and the disk-usage route
# reads statvfs through libc. Debian's libsqlite3 lives under an arch-specific
# directory (x86_64-linux-gnu, aarch64-linux-gnu), so copy it to a fixed path:
# one DENO_SQLITE_PATH for both architectures.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends libsqlite3-0 \
 && rm -rf /var/lib/apt/lists/* \
 && cp "$(dpkg -L libsqlite3-0 | grep -m1 '/libsqlite3\.so\.0$')" /usr/local/lib/geode-sqlite.so

ARG VERSION=0.0.0

WORKDIR /app

# Production-only package.json, the way deploy/install.sh writes it: the server
# imports it for pkg.version alone, and the repo's copy would resolve the dev
# toolchain (Playwright, Obsidian typings, eslint) onto the image.
RUN printf '{"name":"geode","private":true,"license":"Apache-2.0","version":"%s"}\n' "$VERSION" \
  > package.json
COPY deno.json deno.lock ./
COPY server server
COPY core core
COPY db db

# The dependency graph is fetched here, so the container needs no network: the
# image runs on an `internal: true` network.
RUN deno install \
 && chown -R 1993:1993 /app /deno-dir

ENV DENO_SQLITE_PATH=/usr/local/lib/geode-sqlite.so \
    HOME=/app

# uid 1993, the owner ./data must have on the host (docs/architecture/server.md §11).
USER 1993:1993

EXPOSE 8080

# No curl in the image, so the probe is the interpreter the server already runs on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["deno", "eval", "--allow-net=127.0.0.1:8080", \
  "const r = await fetch('http://127.0.0.1:8080/version'); Deno.exit(r.ok ? 0 : 1)"]

# The deploy/geode.service permission set. --allow-ffi stays unscoped: server/fs-usage.ts
# opens "libc.so.6" by soname, and a path-scoped allowlist does not admit a bare soname
# (Deno resolves it against the working directory and the load fails).
ENTRYPOINT ["/tini", "--", "deno", "run", \
  "--allow-net=0.0.0.0:8080", \
  "--allow-read=/data,/app/server,/app/core,/app/db", \
  "--allow-write=/data", \
  "--allow-ffi", \
  "--allow-env=GEODE_ADMIN_TOKEN,GEODE_TRASH_RETENTION_DAYS,DENO_SQLITE_PATH,DENO_SQLITE_LOCAL,GEODE_MIN_PLUGIN_VERSION,GEODE_VAULT_MAX_BYTES,GEODE_TRUST_PROXY", \
  "server/main.ts", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8080"]
