---
covers: [package.json, manifest.json, versions.json, tsconfig.plugin.json, eslint.config.mjs, .github/workflows/*.yml, scripts/plugin-build.ts, scripts/phone-*.ts, test/e2e/playwright.config.ts, test/e2e/global-setup.ts, .env.example]
watches: [deno.json, test/e2e/fixtures/*.ts]
---

# Dev setup

How to set up a machine to work on Geode: tool versions, per-OS prerequisites, the checked-in config
files, the dev loop, and the checks that prove the setup works. Design docs describe the system
(`docs/architecture/overview.md`); this doc only says how to run it.

## 1. Tooling versions

| Tool | Version | Pinned in |
| --- | --- | --- |
| Deno | `2.x` | `.github/workflows/ci.yml` (`deno-version: 2.x`) |
| Node.js | `22` (20.12 or newer required) | `ci.yml`; `@types/node` in `package.json` |
| Obsidian | `1.8.7` or newer | `minAppVersion` in the root `manifest.json` |
| esbuild | `^0.25.5` | `package.json` devDependency; `scripts/plugin-build.ts` imports `npm:esbuild` |
| TypeScript | `^6.0.3` | `package.json` devDependency; the gate is `tsc -p tsconfig.plugin.json` |
| `obsidian` typings | `^1.8.9` | `package.json`, resolved through `package-lock.json` |
| Playwright | `^1.54.0` | `package.json` devDependency |
| jscpd, eslint, ts-unused-exports | current | `package.json`, run by `deno task standards` |
| `libsodium-wrappers-sumo` | `^0.7.15`, plus `libsodium-sumo` as a direct dep | `deno.json` imports, `package.json` |
| `@noble/hashes` | `2.2.0` | `deno.json` imports, `package.json` |
| `node-diff3` | `^3.1.2` | `deno.json` imports, `package.json` |

Node is a dev-time tool only: esbuild, `tsc` and Playwright run on it. The server runs on Deno and the
plugin runs inside Obsidian.

Keep `deno.json`, `package.json` and `ci.yml` in step when you bump a version. A version that lands in
only one of them is a bug.

## 2. Per-OS prerequisites

### Linux (Ubuntu is the primary dev environment and the CI target)

1. Deno: `curl -fsSL https://deno.land/install.sh | sh`, then put `~/.deno/bin` on `PATH`.
2. Node.js 22: `nvm` or nodesource. 20.12 or newer is required for `process.loadEnvFile`, which
   `test/e2e/playwright.config.ts` uses to load `.env.local`.
3. Obsidian: the `.deb` from https://obsidian.md/download, or the AppImage. Only the Playwright E2E
   layer needs it. `isDesktopOnly` is not set, so the plugin targets desktop and mobile.
4. adb: `sudo apt install adb`. Only the `phone` and `hybrid` Playwright projects need it; the
   connect procedure is the `geode-phone-e2e` skill.
5. xvfb: only for a headless desktop E2E run. `sudo apt install xvfb`, then prefix the Playwright
   command with `xvfb-run -a`.

Check the versions:

```bash
deno --version       # 2.x
node --version       # v22.x (>= 20.12)
obsidian --version   # only needed for E2E
adb version          # only needed for phone/hybrid
```

### macOS

`brew install deno node@22`, then the `.dmg` from https://obsidian.md/download. Everything else is the
same.

### Environment and E2E tool resolution

The repo bakes in no machine-specific values. Copy `.env.example` to `.env.local` at the repo root
(gitignored) and fill in what you use. `deno task release`, `deno task after-merge`, `deno task phone*`
and `deno task standards` load it with `--env-file`, and Playwright loads it in
`test/e2e/playwright.config.ts`. A missing required value fails with a message naming the
variable. A Paseo worktree gets `.env.local` symlinked from the main checkout (`paseo.json`).

E2E fixtures and scripts resolve tools from `PATH`. Override with env vars:

| Env var | Default | Used by |
| --- | --- | --- |
| `DENO_BIN` | `deno` | `test/e2e/fixtures/server.ts` |
| `OBSIDIAN_BIN` | `obsidian` | `test/e2e/fixtures/obsidian.ts` |
| `ADB_PATH` | `adb` | `test/e2e/fixtures/phone-*.ts`, phone specs |
| `ANDROID_SERIAL` | none (required for phone and hybrid runs) | `test/e2e/global-setup.ts` (fails fast), `scripts/phone-cli.ts`, phone specs |
| `GEODE_PHONE_VAULT` | none (required when resetting or pushing) | on-device test vault: the plugin install target and the reset interlock (`test/e2e/env.ts`, `test/e2e/vault-interlock.ts`, `test/e2e/fixtures/phone-obsidian.ts`) |
| `GEODE_SERVER_URL` | none (required by specs that use a remote server) | `test/e2e/fixtures/phone-server.ts` |
| `GEODE_SEED_VAULT_DIR` | none (required for hybrid runs and the spinner-continuity spec) | `test/e2e/global-setup.ts` (fails before the first test), `test/e2e/fixtures/hybrid-pair.ts` (read-only source), `test/e2e/scenarios/spinner-continuity.spec.ts` |
| `GEODE_TEST_TIMEOUT_MS` | `900000` | `deno task test:ci` (wall-clock cap) |
| `GEODE_BOARD` | none (board step skipped) | project board node id: `after-merge` moves closed items to Done |

`GEODE_PHONE` and `GEODE_PHONE_RESET` must be exactly `1`. `GEODE_PHONE_PUSH` and `GEODE_PHONE_HOST`
are tested for presence only, so any non-empty value switches them on. `.env.example` documents each
variable.

The ad-hoc phone commands (`deno task phone -- <adb args>`, `deno task phone:cdp -- "<js>"`,
`deno task phone:status`) take the shared phone lock.

## 3. Repository bootstrap

These files exist. This section says what each one is for.

### 3.1 `deno.json`

Holds the import map (aliases for `@noble/hashes/*`, `libsodium-wrappers-sumo`, `@db/sqlite`,
`node-diff3`, `postcss`) and 17 tasks. The ones you use:

| Task | What it does |
| --- | --- |
| `deno task dev` | Server with `--watch`; `--allow-ffi` is needed by `@db/sqlite` |
| `deno task build:plugin` | esbuild bundle, then copies manifest, `versions.json` and `styles.css` into `plugin-dist/` |
| `deno task test` | `deno test --allow-all` |
| `deno task test:ci` | The suite CI runs, with a wall-clock cap (`scripts/test-timeout.ts`) |
| `deno task standards` | lint, plugin `tsc`, ESLint, unused exports, jscpd, CSS syntax, LOC tripwire, docs gate, private-data gate |
| `deno task ci` | install, check, build, standards, `test:ci`, `docs:drift`: the full local gate |
| `deno task docs:drift` | Changed code whose `covers:` doc did not change (warn only; `docs/dev/workflow.md`) |
| `deno task fuzz:sweep` | Multi-seed oracle sweeps (`test/fuzz/sweep.ts`) |

`--allow-ffi` is mandatory for the server: `@db/sqlite` is a native binding.

### 3.2 `package.json`

Holds the dev-only toolchain (esbuild, typescript, eslint, jscpd, ts-unused-exports, Playwright,
`obsidian` typings) and the three runtime deps the plugin bundle needs. Its npm scripts
`build:plugin`, `build:plugin:watch` and `test:e2e` wrap the plugin build and the Playwright run.

### 3.3 `manifest.json` and `versions.json` (repo root)

`manifest.json` is the plugin manifest (`id: geode`, `main: main.js`); `versions.json` maps each plugin
version to its `minAppVersion`: append a row on every release and never edit one. Both live at the repo
root, which is where the community directory reads them; they are the single source. `styles.css` stays
in `plugin/manifest/`. `deno task build:plugin` copies all three into `plugin-dist/`, which is what you
install into a vault.

### 3.4 `tsconfig.plugin.json` and `tsconfig.lint.json`

`tsconfig.plugin.json` is the plugin type gate (`noEmit`, `strict`, bundler resolution).
`tsconfig.lint.json` extends it over `plugin/`, `core/`, `server/`, `test/` and `scripts/` for ESLint.
Deno type-checks the server and core (`deno check server/main.ts core/*.ts`); there is no root
tsconfig file.

### 3.5 `scripts/plugin-build.ts`

esbuild with `format: "cjs"`, `platform: "browser"`, `target: "es2020"`, and Obsidian, Electron and
Node builtins external. It aliases the `@noble/hashes` and libsodium specifiers to their `node_modules`
files (the CJS libsodium entry, see the comment in `deno.json`), inlines the libsodium WASM as a base64
module (`plugin/_generated/`), and copies the manifest, `versions.json` and `styles.css` into
`plugin-dist/`. `--watch` rebuilds on change. It does not talk to a running Obsidian.

Why the WASM is inlined and patched: libsodium's Emscripten loader fetches its `.wasm` file at init,
and that request never resolves in Obsidian's Electron window, so the plugin would hang on unlock. The
build therefore pulls the WebAssembly module out of the JS the sumo build already embeds
(`extractEmbeddedWasm`), writes it as base64 (`plugin/_generated/libsodium-wasm-base64.ts`), and
annotates the libsodium source at `var Module = exports;` with an `instantiateWasm` hook that builds
the instance synchronously from those bytes. `plugin/main.ts` decodes the base64 into
`globalThis.__GEODE_LIBSODIUM_WASM__` before libsodium loads. libsodium is more than half of the
resulting `main.js` (about 3.5 MB), which is why the bundle is that size; it is also why the plugin
fetches nothing from the network at runtime.

### 3.6 `.gitignore` and `LICENSE`

Ignored: runtime data (`data/`, `*.db`, `blobs/`), secrets (`.env*`, `.admin-token`), build output
(`plugin-dist/`, `plugin/_generated/`), `node_modules/`, Playwright artifacts, `tmp/`. `deno.lock` is
tracked. The license is Apache-2.0 (`LICENSE`, `package.json`).

### 3.7 Database migrations

`db/migrations/001_init.sql` to `015_rename_mark.sql`, applied in number order by `server/db.ts`, which
records the applied version in `_meta.schema_version`. Forward only: never edit a committed migration.

## 4. Test-vault credentials and secrets

Nothing secret is committed. A dev setup has:

- an admin token: `GEODE_ADMIN_TOKEN` (env only, never a command-line flag: argv is world-readable in
  `/proc/<pid>/cmdline`). It gates
  provisioning (`POST /vaults`, `POST /vaults/:id/devices`), the admin routes (`GET /vaults`,
  `GET /vaults/:id/devices`, `POST /vaults/:id/trash/purge-all`) and every device revoke
  (`DELETE /vaults/:id/devices/:deviceId`). It also purges a trash row inside the server's retention
  floor (`POST /vaults/:id/trash/:path_hash/purge`), where a device token gets
  `403 purge_requires_admin` (#677). `GET /vaults/:id/info` accepts it as well as a device token.
  `deploy/rotate-admin-token.sh` rotates it on the server.
- a device token per device, minted by the server (`POST /vaults/:id/devices`) and stored in that
  vault's plugin `data.json` together with `serverUrl`, `vaultId`, `deviceId`, `salt`, `verifier` and
  `argon2Params`. It may revoke its own device through the same `DELETE` route, and purge a trash row
  past the server's retention floor (#677). It can do nothing else.
- a passphrase you type (or a spec passes to `unlockVault`). It is never stored. The derived keys may
  be cached per device in `app.saveLocalStorage("key-cache")` for `unlockTimeoutHours`.

For E2E, each test provisions its own server, vault and tokens (`test/e2e/fixtures/server.ts`), so no
credential file is shared.

## 5. The dev loop

One-time per machine:

```bash
git clone https://github.com/Hrt-Htk/geode.git
cd geode
npm ci                         # plugin toolchain + Playwright
deno install                   # full tree from deno.lock (build:plugin needs libsodium-sumo)
deno task build:plugin
```

Daily:

| Terminal | Command | Purpose |
| --- | --- | --- |
| 1 | `GEODE_ADMIN_TOKEN=dev deno task dev` | Server on `:8080` with `--watch`. Without the token, nothing can be provisioned |
| 2 | `deno task build:plugin --watch` | Rebuild `plugin-dist/` on save |
| 3 | Obsidian | Two vaults, each with `.obsidian/plugins/geode/` pointing at `plugin-dist/` |

Reload the plugin from Obsidian after a rebuild (command palette, "Reload app without saving"): the
build script does not talk to the running app. To inspect the transport from the renderer console
(Ctrl+Shift+I), read `app.plugins.plugins.geode.transport?.getState()`.

To iterate on the E2E layer instead, `test/e2e/playwright.config.ts` loads `.env.local` and the dev
loop in `docs/testing/e2e-playwright.md` §9 is the same server plus build watch.

## 6. Verification block

Every step must succeed before you can say the environment works.

```bash
# 1. Tool versions
deno --version | head -1                 # expect "deno 2.x"
node --version                           # expect "v22.x" (>= 20.12)

# 2. Full local gate: check + build + standards + tests
deno task ci

# 3. Server boots with a token, and provisioning works
GEODE_ADMIN_TOKEN=dev deno task dev &
sleep 2
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/vaults \
  -H "Authorization: Bearer dev" -H 'content-type: application/json' \
  -d '{"name":"smoketest"}'          # expect 201; the body carries vault_id + salt
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/vaults \
  -H 'content-type: application/json' -d '{"name":"nope"}'   # expect 401
kill %1

# 4. Plugin build output
ls plugin-dist/main.js plugin-dist/manifest.json plugin-dist/versions.json plugin-dist/styles.css

# 5. E2E smoke (desktop only, needs Obsidian on PATH)
node node_modules/@playwright/test/cli.js test \
  --config=test/e2e/playwright.config.ts --project=default \
  test/e2e/scenarios/gate4-plugin-loads.spec.ts
```

Steps 1 and 4 need nothing but the repo. Steps 2 and 5 need Node: step 5 runs
`node node_modules/@playwright/test/cli.js`, so run `npm ci` first. Step 5 also needs a desktop session
(or `xvfb-run -a`) and an Obsidian binary.

## 7. Troubleshooting

### `deno task dev` fails with sqlite3 or FFI errors

`@db/sqlite` is a native binding. The server needs `--allow-ffi` (the task has it) and, on an install
where the library is not found, `DENO_SQLITE_PATH` set to the shared library. `deploy/install.sh`
resolves that path for the deployed service.

### The plugin is not listed in a vault

Obsidian loads plugins from `<vault>/.obsidian/plugins/geode/`, and the plugin must be enabled in
`.obsidian/community-plugins.json`. Copy the four `plugin-dist/` files in, then enable it once in
Settings, Community plugins, with restricted mode off. The E2E fixture does this per test.

### Specs fail on a fresh checkout with "manifest.json missing: run deno task build:plugin"

`test/e2e/fixtures/obsidian.ts` installs `plugin-dist/`, which does not exist until you build it.

### Desktop E2E hangs before the first assertion (~25 s)

Chromium blocks for about 25 s on a locked keyring. The fixture launches Obsidian with
`DBUS_SESSION_BUS_ADDRESS=disabled:` for that reason (`test/e2e/fixtures/obsidian.ts`); if you drive
Obsidian yourself, do the same.

### Electron exits immediately on a headless machine

There is no display. Prefix the Playwright command with `xvfb-run -a`.

### A phone or hybrid run fails with "ANDROID_SERIAL is not set"

Copy `.env.example` to `.env.local` and fill in `ANDROID_SERIAL` (and `GEODE_PHONE_VAULT`, plus
`GEODE_SEED_VAULT_DIR` for hybrid). The connect procedure is the `geode-phone-e2e` skill. The reset
interlock aborts rather than wiping a vault that is not `GEODE_PHONE_VAULT`.

### `deno task standards` fails on CSS

`plugin/manifest/styles.css` is parsed by postcss, so a malformed declaration fails the task before the
build does.
