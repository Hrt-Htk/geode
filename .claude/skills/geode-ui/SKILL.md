---
name: geode-ui
description: >
  Native-fidelity UI design, screenshot verification, and mobile/Capacitor runtime for the Geode
  Obsidian plugin: project-scoped to the Geode repo. Use when any change touches the settings tab,
  a modal, a view/debug pane, the status bar, or styles.css. Covers the design judgment and
  render→screenshot→judge loop that the generic `obsidian` lint skill cannot enforce.
allowed-tools:
  - Bash (deno task build:plugin, node node_modules/@playwright/test/cli.js)
  - Read
  - Edit
  - Grep
  - Glob
---

# Geode UI: native fidelity, verification, mobile

Project-scoped to the Geode repo. Machine-specific values: read `.env.local` at the repo root
(template `.env.example`): `set -a; . .env.local; set +a` before the on-device commands. This skill
covers what a static-lint skill structurally cannot: (1) native-fidelity design judgment, (2) the
render→screenshot→judge verification loop on
desktop and real phone, (3) Geode's mobile/Capacitor runtime divergence. It complements, never
duplicates, the `obsidian` skill (`.claude/skills/obsidian/`), which owns generic Obsidian plugin
rules derived from eslint-plugin-obsidianmd.

Authority: CLAUDE.md "3 · Done" UI row (screenshot-verify UI in a loop, incl. the mobile clause) and
the Work-section bullets on `ui/` logic, `FakeVault` and Capacitor.

---

## 1. Purpose and the two-skill split

For **generic Obsidian rules**: sentence case, `.setHeading()`, CSS variables, accessibility, no
`innerHTML`/`:has`/`!important`, `requestUrl` not `fetch`, memory/lifecycle, submission: run or
defer to the **`obsidian` skill** (`.claude/skills/obsidian/SKILL.md`). It is the authoritative
rules foundation.

**This skill** adds only three layers on top:

1. **Native-fidelity design judgment**: does the surface look like it belongs in Obsidian? Every
   claim is grounded in `reference/native-css-catalog.md`, the empirical ground truth mined from
   Obsidian's real `app.css`.
2. **The verification loop**: render in real Obsidian, screenshot, read the PNG, judge against the
   native equivalent, iterate. The desktop screenshot mechanic is inlined in **§9** below; the phone
   mechanic is the `geode-phone-e2e` skill. With Paseo (maintainer setup), delegate the loop to pi and
   read the final PNG yourself; without it, run the loop yourself.
3. **Mobile/Capacitor runtime divergence**: the five runtime facts below that make desktop-green
   insufficient for mobile-verified.

---

## 2. Native-fidelity pre-render checklist

Run this checklist BEFORE showing a screenshot. Each item is checkable against
`reference/native-css-catalog.md` (section numbers cited).

### Match the native `.setting-item` model

The base `.setting-item` has `padding: 0.75em 0` (vertical only) and `border-top` (catalog §2.1).
Horizontal inset comes from an **ancestor container** (`.vertical-tab-content`), never the item
itself. If you hand-roll a wrapper div, it must reproduce that ancestor's horizontal padding,
otherwise rows hug the edge. Never override native padding with a shorthand that resets left/right.

### Group with `.setHeading()` sections and flat rows

Obsidian has **zero native sub-setting nesting**: no indent, `margin-left`, `padding-left`, or
`border-left` on any subordinate `.setting-item` (catalog §2.7, Adjudication A). The only grouping
mechanism is `.setting-item-heading`: a flat, full-width row with `font-weight: var(--font-semibold)`
and `border-top: none`. Group with headings, not indented rows.

### Collapse optional groups

Use the settings tab's section pattern: clickable heading toggles a class on a fields container + a
rotating chevron. Default collapsed for secondary content: see `createCollapsibleSection()` in
`plugin/ui/collapsible-section.ts`.

### Reuse native components and CSS variables

Use Obsidian's CSS variables for all colors, spacing, typography: never hardcode values. Spacing
follows the 4px grid (`--size-4-*`, catalog §1.10). Colors use the base scale, semantic text
variables, or accent (catalog §1.3-§1.8). Reuse native `.Setting` rows, native toggles, native
headings. Don't hand-roll what the platform provides.

### Animate the Obsidian way

Use `--anim-duration-*` variables and Obsidian's easing curves (`--anim-motion-*`, catalog §7.2).
Don't invent timings: common patterns are `0.15s ease-in-out` for checkbox/container transitions
and `var(--anim-duration-fast) ease-in-out` for icon opacity (catalog §7.4).

### `data-testid` hooks

Place stable `data-testid` on the wrapper, each interactive control, and any collapse header/fields,
so the surface is screenshot- and assertion-drivable.

### Verify both states

For anything stateful: collapsed + expanded, toggle on + off, empty + populated. Shoot both.

### Mobile is flat rows, not a pill

`.is-phone .setting-item` has `padding: 1em 0` + top-border only: no radius, no background, no
box-shadow (catalog §8.2, Adjudication B). Don't design for a card or pill. The rows are flat,
full-width, border-separated, identical in character to desktop, just with adjusted spacing and
column layout.

---

## 3. The verification loop (CLAUDE.md "3 · Done" UI gate)

**Render → deploy → screenshot → read the PNG → judge against the native equivalent → iterate.**
A passing build, `deno test`, or a `data-testid` grep is **not** UI verification and must never be
reported as "verified" for a UI change on its own.

**Drive the real event path, not injected state.** Setting state directly (`setVersionStatus`, an
`eval` that mutates a field) renders the component but skips the wiring that fires it in production
(event listener → `new Notice`, etc.). Dispatch the actual event and screenshot that; a state-injection
screenshot does not verify the trigger.

Procedure:

1. **Build:** `deno task build:plugin` (writes to `plugin-dist/`).
2. **Deploy to local vaults** per `docs/ops/dev-setup.md` §5 (a vault's `.obsidian/plugins/geode/`
   points at `plugin-dist/`, then reload the plugin in Obsidian).
3. **Desktop screenshot:** use the desktop mechanic in **§9** (spec skeleton, run+inspect, gotchas).
   Write or run an E2E spec that drives the surface into the desired state, captures a PNG, and
   commit it so the gate is durable.
4. **Phone screenshot:** wrap the `geode-phone-e2e` skill (`.claude/skills/geode-phone-e2e/SKILL.md`).
   Same surface, on the real Android device. Before the shot, clear transient overlays:
   `document.querySelectorAll('.notice').forEach(n=>n.remove())`.
5. **Read the PNG**: this is the actual verification. Judge spacing, hierarchy, typography against
   the equivalent native Obsidian surface. Fix, rebuild, repeat. **A phone shot is judged on its own
   for fit**, not only against the mockup: the approved mockup can already carry the flaw. Check every
   control is inside the screen, no label wrapped word by word, no touch target under 40px. **Phone
   shots go to the main checkout's `tmp/review/<issue>/`** (from a worktree:
   `"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/tmp/review/<issue>/"`),
   `test/e2e/screenshots/` is gitignored, so a shot that lives only there never reaches the owner.
6. **Phone specs for a modal call `expectFits(modal)`** (`test/e2e/helpers/fit.ts`) in every state
   (idle + populated/selected): it fails on a control past the modal's bounds or a sideways scroll,
   which a screenshot comparison to a flawed mockup passes.
7. **Assert on the debug-pane log ring buffer** (`getRecentLog`): no `[error]` lines after reconcile.
   This is a deterministic oracle that screenshots miss (it caught the mobile reconcile crash).
8. **Delegate the loop to pi** (Paseo setup). Give pi the exact device/connection commands and let it
   own the whole cycle (build → deploy → screenshot → read PNG → iterate). Verify pi's result by
   reading the final PNG.

Both platforms, both states. Done when the PNG passes visual judgment and the log ring is clean.

---

## 3.5 Review & grading (optional `impeccable` skill)

`impeccable` is an optional external skill, not part of this repo: install it on your own machine, or
skip this section and grade with the checklist and the catalog directly. When you have it, run its flow
(`craft` / `critique` / `polish`). It already provides the screenshot-iterate loop, Nielsen 0-40 scoring,
state coverage, and P0-P3 severity: do not rebuild that. Obsidian is Electron (a real DOM/CSS
renderer), so impeccable's browser-based inspection applies directly. Supply this framing so it grades
for host-fidelity, not web-originality:

- **Target:** an Obsidian plugin surface rendered in the Obsidian desktop app (Electron). Capture by
  screenshotting the open Obsidian window (geode Playwright fixture): don't start a dev server or scan
  for HTML source files (the DOM is built in TS at runtime; use the screenshot + live DOM).
- **Invert the north-star:** success = indistinguishable from Obsidian's native UI, NOT original.
  Impeccable's AI-slop / originality check flips: reward native blend, flag anything that sticks out
  (invented components, custom colors, non-native spacing, "personality"). Don't penalize a lack of
  personality; that's correct here.
- **Reference = Obsidian's own surfaces** + `reference/native-css-catalog.md`. Passable-vs-good
  tie-breaker = the blend test: beside a native surface, can you tell which one the plugin drew?
- **Skip origination**: no palette / mock / brand register; the plugin inherits the theme.
- **Keep everything else**: Nielsen scoring, all states, severity, and the spacing / hierarchy /
  typography / contrast / consistency judgment.

---

## 4. Mobile / Capacitor spine

**Desktop-green is NOT mobile-verified.** These five runtime facts make on-device verification
mandatory for adapter/sync/state-persistence/UI changes:

1. **Adapter method binding:** `FakeVault`'s adapter methods are arrow functions (lexically bound),
   so calling `adapter.list` unbound (dropping `this`) passes every desktop/unit test but crashes
   on Android's real `CapacitorAdapter`. Any adapter/sync change is device-gated.
2. **Capacitor filesystem:** a temp-file+rename "atomic write" starved the single-threaded native
   FS bridge and regressed on-device sync. State-persistence changes are device-gated.
3. **Mobile HTTP:** Android `requestUrl` fails on binary POST and drops headers ("IOException Stream
   closed"); use `fetch` on `Platform.isMobile`. Desktop still uses `requestUrl`: `fetch` is
   CORS-blocked in the Electron renderer.
4. **Notice spam:** clear transient `.notice` overlays before an on-device screenshot:
   `document.querySelectorAll('.notice').forEach(n=>n.remove())`.
5. **Settings-tab on mobile:** open with `app.setting.open()` + `openTabById(...)` (no leading
   `.close()`); prefer in-page `eval` reads/clicks over Playwright locators for settings DOM.

---

## 5. Commands

**`check [target]`**: native-fidelity static review. Run the pre-render checklist against the
target files. For generic Obsidian rules (sentence case, accessibility, no `:has`, etc.), defer to
the `obsidian` skill. Done when every checklist item is addressed or consciously waived with a
catalog citation.

**`critique [target]`**: UX review against the native Obsidian surface. Screenshot the target
alongside the equivalent native surface (e.g. Geode settings next to Obsidian core settings) and
diff spacing, typography, hierarchy. Done when the surface is indistinguishable from its native
peers.

**`screenshot [target]`**: drive the verification loop. Build, deploy, capture desktop and phone
screenshots, clear notices, read the PNGs, assert on the log ring, iterate. Done when both
platforms, both states pass visual judgment and the log is clean.

**`adapt [target]`**: fix mobile/Capacitor issues. Apply the five runtime facts, verify on-device
with `geode-phone-e2e`. Done when the phone screenshot matches the desktop screenshot in intent and
the log ring is clean on-device.

---

## 6. Native-fidelity anti-patterns (Geode-specific)

These are beyond the `obsidian` lint rules: they require design judgment against the catalog.

- **Hand-rolled indented sub-settings**: `margin-left` / `padding-left` / `border-left` on a
  `.setting-item` subclass is non-native. Obsidian has zero sub-setting nesting (Adjudication A).
  Prefer a `.setHeading()` sub-section or collapsible group with flat, full-width rows.
- **Designing for a mobile "pill"**: adding `border-radius`, `background-color`, or `box-shadow`
  to mobile setting rows invents a card that doesn't exist (Adjudication B). Mobile rows are flat.
- **Overriding native `.setting-item` padding with a shorthand**: e.g. `padding: 0.5em 0` zeroes
  horizontal padding inherited from the ancestor. Set only `padding-top`/`padding-bottom`, or
  restore the container's horizontal inset.
- **Inventing animation timings**: hardcoding `200ms ease` instead of using `--anim-duration-*`
  and `--anim-motion-*` variables (catalog §7).
- **Reporting a green test or `data-testid` grep as "UI verified"**: only a read PNG counts (the
  CLAUDE.md "3 · Done" UI gate).
- **Judging a phone shot only against the mockup**: the mockup can carry the same flaw; judge fit on
  its own (clipped controls, labels wrapped word by word, thin touch targets).
- **Relocating a surface but only re-pointing `data-testid`s**: E2E specs also navigate to the old
  location; update their open path (the command / `openX()` call), not just the testids.

---

## 7. Canonical Geode artifacts to copy

The proven patterns to copy:

- **`plugin/ui/config-modal.ts`** → `buildSection()`: heading + chevron + fields, built once.
  **`plugin/ui/collapsible-section.ts`** is the reference implementation for section collapse.
- **`plugin/ui/plugin-sync-list.ts`**: obsidian-free pure list logic, unit-tested. Models the
  extract-logic convention: logic lives in a testable module, the obsidian-importing file is a
  thin shell.
- **`plugin/manifest/styles.css`** → `.geode-subsetting*` + `.geode-plugin-sync-*`: the CSS
  classes for indent and collapse. **Note:** the `.geode-subsetting` `border-left` is the known
  non-native bit to reconsider: prefer a `.setHeading()` sub-section / collapsible per
  Adjudication A.
- **`test/e2e/scenarios/config-to-sync-plugins.spec.ts`** (+ `.phone.spec.ts`): desktop and
  on-device screenshot specs, both states, notice-clearing. The reference E2E pattern.

---

## 8. Reference

**`reference/native-css-catalog.md`** is the living ground truth for every native class, variable,
and animation value. It is mined from Obsidian's real `app.css` with line numbers for verification.
Every claim in this skill traces back to a section in the catalog. When in doubt, read the catalog
section: it has the CSS, the line numbers, and the adjudication.

---

## 9. Desktop screenshot mechanic

The concrete desktop render→screenshot loop (kept in this one skill so there is ONE UI door). A
reference spec is `test/e2e/scenarios/logs-section-fields.spec.ts`.
**Commit the spec you write so the gate is durable.**

### Fixed facts
- **Deno:** `deno`. Runner: `node node_modules/@playwright/test/cli.js`
  (NEVER `npx`: the `.bin` runner double-loads: "did not expect test()").
- E2E installs the plugin from **`plugin-dist/`**, so `deno task build:plugin` FIRST, or the shot
  is stale code.
- Screenshots land in **`test/e2e/screenshots/<spec>/<project>/`** via `shotPath()` from
  `test/e2e/helpers/shots.ts`: outside Playwright's `outputDir`, so a run never wipes earlier
  shots (#487). Never write shots to `test-results/`.
- A shot is evidence only if it is newer than the last code change and rebuild and shows the intended
  state; report each PNG with its time. Never commit a shot known to be stale.
- Check "fits on one line" by measuring row height against line height in the spec, not by reading a
  tall screenshot: vision misreads wraps and crops.

### Spec skeleton
```ts
import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

test("<gate> screenshot", async () => {
  test.slow();
  const server = await startServer();
  const device = await server.mintToken("<name>");
  const o = await launchObsidian({ geodeSettings: {
    serverUrl: server.url, vaultId: server.vaultId, deviceId: device.deviceId,
    deviceToken: device.token, salt: server.salt, debugLogging: true,
  }, unlockPassphrase: "<pass>" });
  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    // ...drive the surface into the state you want via o.eval(`...`)...
    await o.eval(`app.setting?.close?.(); return true;`); // settings modal covers a full-window shot
    await o.win.keyboard.press("Escape").catch(() => {});
    const el = o.win.locator('.workspace-leaf-content[data-type="geode-debug"]');
    await el.screenshot({ path: shotPath("<name>.png") }).catch(async () => { await o.win.screenshot({ path: shotPath("<name>.png") }); });
  } finally { await o.close(); await server.stop?.(); }
});
```

### Run + inspect
`node node_modules/@playwright/test/cli.js test test/e2e/scenarios/<file>.spec.ts --config=test/e2e/playwright.config.ts --project=default --reporter=line`
Then **Read the PNG** and judge it: this is the actual verification, not the green test. Also dump
the DOM text of the surface so the assertion is concrete.

### Gotchas (why a shot fails)
- **Settings modal covers everything**: dismiss it (above) before a full-window shot; symptom is the
  surface peeking out at the right edge behind the modal.
- The debug pane is a **background right-sidebar leaf**: a Playwright click can't reach its buttons;
  `revealLeaf(leaf)` or eval-click in the renderer.
- Use `__dirname` for paths (not `import.meta.dirname`, undefined in this runner).
- The fixture exposes `{ app, win, eval, pluginSettings, close, ... }`: `win` is the Playwright Page
  (`win.screenshot`, `win.locator`); there is no `.screenshot()` on the fixture root.
