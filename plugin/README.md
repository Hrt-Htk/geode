# plugin/

Obsidian plugin: all business logic lives here. Desktop and mobile.

| Directory | Purpose |
|-----------|---------|
| `main.ts` | Plugin entry: lifecycle, lock/unlock, settings, command registrations, thin delegations |
| `session.ts` | Per-session wiring: state persistence files, activity log, runtime lifecycle |
| `sync/` | Sync core: transport, commit channel/queue, reconciler, pending ops, apply, merge, conflicts, rename chains, history, trash, recovery, re-key, mass-delete guard |
| `plumbing/` | Infrastructure: state (in-memory + JSON persistence), settings types, vault lock and key cache, logging, atomic write, provisioning/rekey/trash/storage clients, command palette, URL scheme, `http-platform` |
| `ui/` | Obsidian UI: settings tab + one module per section (status, vault, devices, scope, trash, advanced, logs), status bar + status menu, modals (setup wizard, passphrase, conflicts, trash, history, rekey, mass-delete, export, server address), views |
| `manifest/` | `styles.css`. The plugin manifest (`manifest.json`) and `versions.json` live at the repo root |
| `_generated/` | Build output: libsodium WASM as base64, patched libsodium CJS (gitignored) |

Two rules that shape the layout:

- **UI logic lives in an `obsidian`-free module.** Anything importing `obsidian` cannot run under
  `deno test`; the logic it needs is extracted (e.g. `ui/statusbar-icon.ts`, `ui/sync-status.ts`) and
  unit-tested, leaving a thin E2E-verified shell.
- **≤ 500 code lines per file** (blocking; >300 is a review candidate), per-function ≤ 80 lines,
  cyclomatic complexity ≤ 15, nesting ≤ 4: enforced by `deno task standards`.

Architecture and flow: `../docs/architecture/plugin.md`.
