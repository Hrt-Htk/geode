# Obsidian Native CSS Catalog

Source: `app.css` as bundled in the Obsidian desktop app. Obsidian version: not recorded (the
excerpts came from an `app.css` of ~18,986 lines; line numbers drift with the app version, so
re-check one before trusting it). Every rule below carries the line number in `app.css` for
verification.

---

## 1. CSS Variable Foundations

All variables are defined in the `body` block (line 1999) with theme overrides in `.theme-light` (line 2746) and `.theme-dark` (line 2791). Mobile overrides in `.is-mobile` (line 16792) and `.is-phone` (line 16874).

### 1.1 Animation / Motion Variables

```css
/* Line 2001 */
--anim-duration-none: 0;
--anim-duration-superfast: 70ms;
--anim-duration-fast: 140ms;
--anim-duration-moderate: 300ms;
--anim-duration-slow: 560ms;
--anim-motion-smooth: cubic-bezier(0.45, 0.05, 0.55, 0.95);
--anim-motion-delay: cubic-bezier(0.65, 0.05, 0.36, 1);
--anim-motion-jumpy: cubic-bezier(0.68, -0.55, 0.27, 1.55);
--anim-motion-swing: cubic-bezier(0, 0.55, 0.45, 1);
```

### 1.2 Color Ramps

**`.theme-light`** (line 2746):
```css
--color-red-rgb: 233, 49, 71;        --color-red: #e93147;
--color-orange-rgb: 236, 117, 0;     --color-orange: #ec7500;
--color-yellow-rgb: 224, 172, 0;     --color-yellow: #e0ac00;
--color-green-rgb: 8, 185, 78;       --color-green: #08b94e;
--color-cyan-rgb: 0, 191, 188;       --color-cyan: #00bfbc;
--color-blue-rgb: 8, 109, 221;       --color-blue: #086ddd;
--color-purple-rgb: 120, 82, 238;    --color-purple: #7852ee;
--color-pink-rgb: 213, 57, 132;      --color-pink: #d53984;
```

**`.theme-dark`** (line 2791):
```css
--color-red-rgb: 251, 70, 76;        --color-red: #fb464c;
--color-orange-rgb: 233, 151, 63;    --color-orange: #e9973f;
--color-yellow-rgb: 224, 222, 113;   --color-yellow: #e0de71;
--color-green-rgb: 68, 207, 110;     --color-green: #44cf6e;
--color-cyan-rgb: 83, 223, 221;      --color-cyan: #53dfdd;
--color-blue-rgb: 2, 122, 255;       --color-blue: #027aff;
--color-purple-rgb: 168, 130, 255;   --color-purple: #a882ff;
--color-pink-rgb: 250, 153, 205;     --color-pink: #fa99cd;
```

### 1.3 Base Color Scale

| Variable | Light | Dark |
|---|---|---|
| `--color-base-00` | `#ffffff` | `#1e1e1e` |
| `--color-base-05` | `#fcfcfc` | `#212121` |
| `--color-base-10` | `#fafafa` | `#242424` |
| `--color-base-20` | `#f6f6f6` | `#262626` |
| `--color-base-25` | `#e3e3e3` | `#2a2a2a` |
| `--color-base-30` | `#e0e0e0` | `#363636` |
| `--color-base-35` | `#d4d4d4` | `#3f3f3f` |
| `--color-base-40` | `#bdbdbd` | `#555555` |
| `--color-base-50` | `#ababab` | `#666666` |
| `--color-base-60` | `#707070` | `#999999` |
| `--color-base-70` | `#5c5c5c` | `#b3b3b3` |
| `--color-base-100` | `#222222` | `#dadada` |

### 1.4 Mono RGB

| Variable | Light | Dark |
|---|---|---|
| `--mono-rgb-0` | `255, 255, 255` | `0, 0, 0` |
| `--mono-rgb-100` | `0, 0, 0` | `255, 255, 255` |

### 1.5 Accent

```css
/* Line 2670 */
--accent-h: 258;
--accent-s: 88%;
--accent-l: 66%;
```

```css
/* Line 2773 (light) / 2820 (dark) */
--color-accent-hsl: var(--accent-h), var(--accent-s), var(--accent-l);
--color-accent: hsl(var(--accent-h), var(--accent-s), var(--accent-l));
```

**Light accent variants** (line 2775-2776):
```css
--color-accent-1: hsl(calc(var(--accent-h) - 1), calc(var(--accent-s) * 1.01), calc(var(--accent-l) * 1.075));
--color-accent-2: hsl(calc(var(--accent-h) - 3), calc(var(--accent-s) * 1.02), calc(var(--accent-l) * 1.15));
```

**Dark accent variants** (line 2822-2823):
```css
--color-accent-1: hsl(calc(var(--accent-h) - 3), calc(var(--accent-s) * 1.02), calc(var(--accent-l) * 1.15));
--color-accent-2: hsl(calc(var(--accent-h) - 5), calc(var(--accent-s) * 1.05), calc(var(--accent-l) * 1.29));
```

### 1.6 Semantic Text

```css
/* Line 2650 */
--text-normal: var(--color-base-100);
--text-muted: var(--color-base-70);
--text-faint: var(--color-base-50);
--text-on-accent: white;
--text-on-accent-inverted: black;
--text-error: var(--color-red);
--text-warning: var(--color-orange);
--text-success: var(--color-green);
--text-selection: hsla(var(--color-accent-hsl), 0.2);
--text-accent: var(--color-accent);
--text-accent-hover: var(--color-accent-2);
```

**Dark overrides** (line 2824-2825):
```css
--text-accent: var(--color-accent-1);
--text-selection: hsla(var(--interactive-accent-hsl), 0.33);
```

### 1.7 Backgrounds

```css
/* Line 2704 */
--background-primary: var(--color-base-00);
--background-primary-alt: var(--color-base-10);
--background-secondary: var(--color-base-20);
--background-modifier-hover: rgba(var(--mono-rgb-100), 0.067);
--background-modifier-active-hover: hsla(var(--interactive-accent-hsl), 0.1);
--background-modifier-border: var(--color-base-30);
--background-modifier-border-hover: var(--color-base-35);
--background-modifier-border-focus: var(--color-base-40);
--background-modifier-error-rgb: var(--color-red-rgb);
--background-modifier-error: var(--color-red);
--background-modifier-error-hover: var(--color-red);
--background-modifier-success-rgb: var(--color-green-rgb);
--background-modifier-success: var(--color-green);
--background-modifier-message: rgba(0, 0, 0, 0.9);
```

**Dark overrides** (line 2832-2833):
```css
--background-modifier-box-shadow: rgba(0, 0, 0, 0.3);
--background-modifier-cover: rgba(10, 10, 10, 0.4);
--background-modifier-hover: rgba(var(--mono-rgb-100), 0.15);
```

### 1.8 Interactive

```css
/* Line 2658 (body) */
--interactive-normal: var(--color-base-00);
--interactive-hover: var(--color-base-10);
--interactive-accent-hsl: var(--color-accent-hsl);
--interactive-accent: var(--color-accent-1);
--interactive-accent-hover: var(--color-accent-2);
```

**Dark overrides** (line 2827-2830):
```css
--interactive-normal: var(--color-base-30);
--interactive-hover: var(--color-base-35);
--text-accent: var(--color-accent-1);
--interactive-accent: var(--color-accent);
--interactive-accent-hover: var(--color-accent-1);
```

**Mobile overrides** (line 16829-16830):
```css
--interactive-normal: var(--background-secondary);
--interactive-hover: var(--background-modifier-border);
```

### 1.9 Form Field Backgrounds

```css
/* Line 2656 (body) */
--background-modifier-form-field: var(--color-base-00);
--background-modifier-form-field-hover: var(--background-modifier-form-field);
```

**Dark override** (line 2826):
```css
--background-modifier-form-field: var(--color-base-25);
```

### 1.10 Sizing / Spacing

```css
/* Line 2531 */
--size-2-1: 2px;
--size-2-2: 4px;
--size-2-3: 6px;
--size-4-1: 4px;
--size-4-2: 8px;
--size-4-3: 12px;
--size-4-4: 16px;
--size-4-5: 20px;
--size-4-6: 24px;
--size-4-8: 32px;
--size-4-9: 36px;
--size-4-10: 40px;
--size-4-12: 48px;
--size-4-16: 64px;
--size-4-18: 72px;
```

### 1.11 Typography

```css
/* Line 2173 */
--font-smallest: 0.8em;
--font-smaller: 0.875em;
--font-small: 0.933em;
```

```css
/* Line 2179 */
--font-ui-smaller: 12px;
--font-ui-small: 13px;
--font-ui-medium: 15px;
--font-ui-large: 20px;
```

```css
/* Line 2185 */
--font-weight: var(--font-normal);
--font-thin: 100;
--font-extralight: 200;
--font-light: 300;
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
--font-extrabold: 800;
--font-black: 900;
```

```css
/* Line 2417 */
--line-height-normal: 1.5;
--line-height-tight: 1.3;
```

**Mobile overrides** (line 16799-16802):
```css
--font-ui-smaller: calc(var(--font-text-size) * 0.8);
--font-ui-small: calc(var(--font-text-size) * 0.937);
--font-ui-medium: var(--font-text-size);
--font-ui-large: calc(var(--font-text-size) * 1.2);
```

### 1.12 Radius

```css
/* Line 2519 */
--radius-s: 4px;
--radius-m: 8px;
--radius-l: 12px;
--radius-xl: 16px;
```

### 1.13 Shadows

**Light** (line 2783-2784):
```css
--shadow-s: 0px 1px 2px rgba(0, 0, 0, 0.028), 0px 3.4px 6.7px rgba(0, 0, 0, 0.042), 0px 15px 30px rgba(0, 0, 0, 0.07);
--shadow-l: 0px 1.8px 7.3px rgba(0, 0, 0, 0.071), 0px 6.3px 24.7px rgba(0, 0, 0, 0.112), 0px 30px 90px rgba(0, 0, 0, 0.2);
```

**Dark** (line 2835-2836):
```css
--shadow-s: 0px 1px 2px rgba(0, 0, 0, 0.121), 0px 3.4px 6.7px rgba(0, 0, 0, 0.179), 0px 15px 30px rgba(0, 0, 0, 0.3);
--shadow-l: 0px 1.8px 7.3px rgba(0, 0, 0, 0.071), 0px 6.3px 24.7px rgba(0, 0, 0, 0.112), 0px 30px 90px rgba(0, 0, 0, 0.2);
```

### 1.14 Input / Form Field

```css
/* Line 2229 */
--input-height: 30px;
--input-padding: var(--size-4-1) var(--size-4-2);
--input-radius: 5px;
--input-font-weight: var(--font-normal);
--input-border-width: 1px;
--input-border-width-focus: 2px;
--input-placeholder-color: var(--text-faint);
```

**Light input shadow** (line 2780):
```css
--input-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12), 0 2px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 1.5px 0 rgba(0, 0, 0, 0.03), 0 1px 2px 0 rgba(0, 0, 0, 0.04), 0 0 0 0 transparent;
--input-shadow-hover: inset 0 0 0 1px rgba(0, 0, 0, 0.17), 0 2px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 1.5px 0 rgba(0, 0, 0, 0.03), 0 1px 2px 0 rgba(0, 0, 0, 0.04), 0 0 0 0 transparent;
```

**Dark input shadow** (line 2833-2834):
```css
--input-shadow: inset 0 0.5px 0.5px 0.5px rgba(255, 255, 255, 0.09), 0 2px 4px 0 rgba(0, 0, 0, 0.15), 0 1px 1.5px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.2), 0 0 0 0 transparent;
--input-shadow-hover: inset 0 0.5px 1px 0.5px rgba(255, 255, 255, 0.16), 0 2px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 1.5px 0 rgba(0, 0, 0, 0.2), 0 1px 2px 0 rgba(0, 0, 0, 0.4), 0 0 0 0 transparent;
```

**Mobile overrides** (line 16816-16818):
```css
--input-height: 40px;
--input-shadow: none;
--input-shadow-hover: none;
--input-font-weight: var(--font-medium);
--input-border-width: 0px;
```

### 1.15 Toggle

```css
/* Line 2631 */
--toggle-border-width: 2px;
--toggle-width: 40px;
--toggle-radius: 18px;
--toggle-thumb-color: white;
--toggle-thumb-radius: 18px;
--toggle-thumb-height: 18px;
--toggle-thumb-width: 18px;
```

**Mobile overrides** (line 16838-16841):
```css
--toggle-width: 48px;
--toggle-radius: 26px;
--toggle-thumb-radius: 26px;
--toggle-thumb-height: 26px;
--toggle-thumb-width: 26px;
```

### 1.16 Icon

```css
/* Line 2196 */
--icon-size: var(--icon-m);
--icon-stroke: var(--icon-m-stroke-width);
--icon-xs: 14px;
--icon-s: 16px;
--icon-m: 18px;
--icon-l: 18px;
--icon-xl: 32px;
--icon-xs-stroke-width: 2px;
--icon-s-stroke-width: 2px;
--icon-m-stroke-width: 1.75px;
--icon-l-stroke-width: 1.75px;
--icon-xl-stroke-width: 1.25px;
--icon-color: var(--text-muted);
--icon-color-hover: var(--text-muted);
--icon-color-active: var(--text-accent);
--icon-color-focused: var(--text-normal);
--icon-opacity: 0.85;
--icon-opacity-hover: 1;
--icon-opacity-active: 1;
--clickable-icon-radius: var(--radius-s);
```

**Mobile overrides** (line 16805-16809):
```css
--icon-s: 18px;
--icon-m: 20px;
--icon-l: 24px;
--icon-opacity: 1;
--icon-opacity-hover: 0.65;
```

### 1.17 Modal

```css
/* Line 2453 */
--modal-background: var(--background-primary);
--modal-width: 90vw;
--modal-height: 85vh;
--modal-max-width: 1100px;
--modal-max-height: 1000px;
--modal-max-width-narrow: 800px;
--modal-border-width: var(--border-width);
--modal-border-color: var(--color-base-40, var(--background-modifier-border-focus));
--modal-radius: var(--radius-l);
--modal-community-sidebar-width: 280px;
```

### 1.18 Menu

```css
/* Line 2438 */
--menu-padding: var(--size-2-3);
--menu-shadow: var(--shadow-s);
--menu-radius: var(--radius-m);
--menu-background: var(--background-secondary);
--menu-border-color: var(--background-modifier-border-hover);
--menu-border-width: 1px;
--menu-backdrop-filter: none;
```

### 1.19 Status Bar

```css
/* Line 2563 */
--status-bar-background: var(--background-secondary);
--status-bar-border-color: var(--divider-color);
--status-bar-border-width: 1px 0 0 1px;
--status-bar-font-size: var(--font-ui-smaller);
--status-bar-text-color: var(--text-muted);
--status-bar-position: fixed;
--status-bar-radius: var(--radius-m) 0 0 0;
```

### 1.20 Z-Index Layers

```css
/* Line 2222 */
--layer-cover: 5;
--layer-sidedock: 10;
--layer-status-bar: 15;
--layer-popover: 30;
--layer-slides: 45;
--layer-modal: 50;
--layer-notice: 60;
--layer-menu: 65;
--layer-tooltip: 70;
--layer-dragged-item: 80;
```

### 1.21 Border Width

```css
/* Line 2066 */
--border-width: 1px;
```

**Phone override** (line 16875):
```css
--border-width: 0.5pt;
```

---

## 2. Settings Surface

### 2.1 `.setting-item`

```css
/* Line 4606 */
.setting-item {
  display: flex;
  align-items: center;
  padding: 0.75em 0;
  border-top: 1px solid var(--background-modifier-border);
  row-gap: var(--size-4-3);
}
```

**Key structural rules:**
```css
/* Line 4614 */
.setting-item + div > .setting-item-heading,
.setting-item + .setting-item-heading {
  margin-top: 0.75em;
}
/* Line 4618 */
.setting-item:first-child {
  padding-top: 0;
  border-top: none;
}
/* Line 4622 */
.setting-item > *:first-child {
  margin-inline-end: var(--size-4-4);
}
/* Line 4625 */
.setting-item > *:last-child {
  margin-inline-end: 0;
}
```

**CTA variant** (line 4647):
```css
.setting-item.mod-cta {
  justify-content: center;
}
```

**Container query: narrow layout** (line 4629):
```css
@container (max-width: 340px) {
  .setting-item:not(.mod-toggle):not(.mod-list-item) {
    flex-direction: column;
  }
  .setting-item:not(.mod-toggle):not(.mod-list-item) .setting-item-info {
    margin-inline-end: 0;
    align-self: flex-start;
  }
  .setting-item:not(.mod-toggle):not(.mod-list-item) .setting-item-control {
    width: 100%;
    justify-content: flex-start;
  }
  .setting-item:not(.mod-toggle):not(.mod-list-item) .setting-item-control button:not(.clickable-icon),
  .setting-item:not(.mod-toggle):not(.mod-list-item) .setting-item-control input,
  .setting-item:not(.mod-toggle):not(.mod-list-item) .setting-item-control select {
    width: 100%;
    max-width: 100%;
  }
}
```

### 2.2 `.setting-item-heading`

```css
/* Line 4650 */
.setting-item-heading {
  font-weight: var(--font-semibold);
  border-top: none;
}
/* Line 4654 */
.setting-item-heading .setting-item-info {
  flex-grow: 0;
  margin-inline-end: 0;
}
/* Line 4658 */
.setting-item-heading .setting-item-description {
  font-weight: var(--font-normal);
}
```

### 2.3 `.setting-item-info`

```css
/* Line 4661 */
.setting-item-info {
  flex: 1 1 auto;
  min-width: 0;
}
```

### 2.4 `.setting-item-name`

```css
/* Line 4686 */
.setting-item-name {
  color: var(--text-normal);
  font-size: var(--font-ui-medium);
  line-height: var(--line-height-tight);
  text-overflow: ellipsis;
  overflow: hidden;
}
```

### 2.5 `.setting-item-description`

```css
/* Line 4665 */
.setting-item-description {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
  padding-top: var(--size-4-1);
  line-height: var(--line-height-tight);
}
/* Line 4671 */
.setting-item-description:empty {
  display: none;
}
/* Line 4674 */
.setting-item-description code {
  font-family: var(--font-monospace);
  font-size: var(--font-smaller);
  border-radius: var(--radius-s);
  padding: 0 3px 2px 3px;
  position: relative;
  bottom: 1px;
}
/* Line 4682 */
.setting-item-description ul {
  margin: var(--size-4-1) 0;
  padding-inline-start: var(--size-4-6);
}
```

### 2.6 `.setting-item-control`

```css
/* Line 4693 */
.setting-item-control {
  flex: 1 1 auto;
  text-align: end;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--size-4-2);
}
/* Line 4701 */
.setting-item-control.mod-vertical {
  flex-direction: column;
}
/* Line 4704 */
.setting-item-control.mod-vertical > *:not(:last-child) {
  margin-bottom: 10px;
  margin-inline-end: 0;
}
/* Line 4708 */
.setting-item-control.mod-hotkey {
  padding-top: 0;
  cursor: default;
}
/* Line 4720 */
.setting-item-control select {
  width: inherit;
  max-width: 400px;
}
```

### 2.7 ADJUDICATION QUESTION A: Native Sub-Setting Nesting

**Answer: Obsidian does NOT have any native sub-setting indentation, nesting, or subordinate row styling.**

Evidence:
- The only `.mod-*` variants on `.setting-item` are: `.mod-cta` (center-justify, line 4647), `.mod-toggle` (used only in `:not()` selectors for container queries, line 4629), `.mod-list-item` (same, line 4629), `.mod-slider`, `.mod-search-setting`, and `.mod-change-language`: all context-specific, none for nesting.
- No rule anywhere in `app.css` applies `margin-left`, `padding-left`, `margin-inline-start`, `padding-inline-start`, or `border-left` to any `.setting-item` subclass.
- The **only** grouping mechanism Obsidian provides is `.setting-item-heading` (line 4650), which is a flat, full-width row with `font-weight: var(--font-semibold)` and `border-top: none`. Settings below a heading are indistinguishable from any other setting row.
- The `margin-top: 0.75em` on `.setting-item + .setting-item-heading` (line 4614) creates visual separation between sections, not hierarchy.

**Conclusion:** Any hand-rolled indented "sub-setting" pattern in Geode is an invention, not native Obsidian behavior. The native pattern is: heading row → flat children.

---

## 3. Menus & Submenus

### 3.1 `.menu` Container

```css
/* Line 7667 */
.menu {
  -webkit-app-region: no-drag;
  display: flex;
  flex-direction: column;
  border: var(--menu-border-width) solid var(--menu-border-color);
  background-color: var(--menu-background);
  backdrop-filter: var(--menu-backdrop-filter);
  padding: 0;
  border-radius: var(--menu-radius);
  box-shadow: var(--menu-shadow);
  max-height: 100%;
  position: fixed;
  z-index: var(--layer-menu);
  user-select: none;
}
```

### 3.2 `.menu-scroll`

```css
/* Line 7685 */
.menu-scroll {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: var(--menu-padding);
}
```

### 3.3 `.menu-item`

```css
/* Line 7714 */
.menu-item {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-2);
  cursor: var(--cursor);
  font-size: var(--font-ui-small);
  border-radius: var(--radius-s);
  white-space: nowrap;
}
```

**Variants:**
```css
/* Line 7724 */
.menu-item.is-warning:not(.is-disabled) {
  color: var(--text-error);
}
/* Line 7730 */
.menu-item.is-label {
  cursor: default;
  font-size: var(--font-ui-medium);
  color: var(--text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
/* Line 7738 */
.menu-item.is-disabled {
  cursor: default;
  color: var(--text-faint);
}
/* Line 7742 */
.menu-item.selected:not(.is-label):not(.is-disabled) {
  background-color: var(--background-modifier-hover);
}
```

### 3.4 `.menu-item-icon`

```css
/* Line 7745 */
.menu-item-icon {
  flex: 0 1 auto;
  display: flex;
  color: var(--text-muted);
}
/* Line 7750 */
.menu-item.is-warning .menu-item-icon {
  color: var(--text-error);
}
/* Line 7753 */
.menu-item.is-disabled .menu-item-icon {
  color: var(--text-faint);
}
/* Line 7756 */
.menu-item-icon .mod-submenu {
  color: var(--text-faint);
}
```

### 3.5 `.menu-item-title`

```css
/* Line 7759 */
.menu-item-title {
  flex: 1 0 0;
}
```

### 3.6 `.menu-item-desc`

```css
/* Line 7709 */
.menu-item-desc {
  padding-top: var(--size-4-1);
  color: var(--text-faint);
  font-size: 0.8em;
}
```

### 3.7 `.menu-separator`

```css
/* Line 7694 */
.menu-separator {
  height: 0;
  margin: var(--size-2-3) calc(var(--size-2-3) * -1);
  border-bottom: 1px solid var(--background-modifier-border);
}
/* Line 7699 */
.menu-separator:last-child,
.menu-separator:first-child {
  display: none;
}
/* Line 7703 */
.menu-separator + .menu-separator {
  display: none;
}
/* Line 7706 */
.menu-separator + .menu-item.is-label {
  padding-bottom: var(--size-4-1);
}
```

### 3.8 Submenu Handling

Obsidian does not have a CSS-native submenu system in `app.css`. The only submenu-related rule is the icon color override (line 7756):
```css
.menu-item-icon .mod-submenu {
  color: var(--text-faint);
}
```

Submenu positioning/reveal is handled by JavaScript (not CSS `@keyframes` or `transition`). The menu uses `position: fixed` and `z-index: var(--layer-menu)` (line 7667).

---

## 4. Modals

### 4.1 `.modal-container`

```css
/* Line 7778 */
.modal-container {
  display: flex;
  align-items: center;
  justify-content: center;
  position: absolute;
  top: 0;
  bottom: 0;
  inset-inline-start: 0;
  width: 100%;
  z-index: var(--layer-modal);
}
/* Line 7789 */
.modal-container.mod-dim .modal {
  box-shadow: var(--shadow-l);
}
```

### 4.2 `.modal-bg`

```css
/* Line 7804 */
.modal-bg {
  position: absolute;
  top: 0;
  inset-inline-start: 0;
  width: 100%;
  height: 100%;
  background-color: var(--background-modifier-cover);
}
```

### 4.3 `.modal`

```css
/* Line 7812 */
.modal {
  --checkbox-size: var(--font-ui-medium);
  background-color: var(--modal-background);
  border-radius: var(--modal-radius);
  border: var(--modal-border-width) solid var(--modal-border-color);
  padding: var(--size-4-4);
  position: relative;
  min-height: 100px;
  width: var(--dialog-width);
  max-width: var(--dialog-max-width);
  max-height: var(--dialog-max-height);
  display: flex;
  flex-direction: column;
  overflow: auto;
}
```

**Sidebar layout variant** (line 7827):
```css
.modal.mod-sidebar-layout {
  padding: 0;
  width: var(--modal-width);
  height: var(--modal-height);
  max-width: var(--modal-max-width);
  max-height: var(--modal-max-height);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
```

**Scrollable content variant** (line 7840):
```css
.modal.mod-scrollable-content {
  padding: 0;
  overflow: hidden;
}
.modal.mod-scrollable-content .modal-title {
  padding: var(--size-4-4) var(--size-4-4) 0 var(--size-4-4);
}
.modal.mod-scrollable-content .modal-content {
  padding: 0 var(--size-4-4) var(--size-4-4) var(--size-4-4);
  overflow: auto;
}
.modal.mod-scrollable-content .modal-button-container {
  margin-top: 0;
  border-top: var(--border-width) solid var(--background-modifier-border);
  padding: var(--size-4-4);
}
```

**Narrow variant** (line 7856):
```css
.modal.mod-narrow {
  max-width: var(--modal-max-width-narrow);
}
```

### 4.4 `.modal-close-button`

```css
/* Line 7871 */
.modal-close-button {
  transition: opacity 0.15s ease-in-out;
  cursor: var(--cursor);
  position: absolute;
  top: var(--size-2-3);
  inset-inline-end: var(--size-2-3);
  font-size: 24px;
  line-height: 20px;
  height: 24px;
  width: 24px;
  padding: 0 var(--size-2-2);
  border-radius: var(--radius-s);
  color: var(--text-muted);
}
@media (hover: hover) {
  .modal-close-button:hover {
    background-color: var(--background-modifier-hover);
    color: var(--text-normal);
  }
}
/* Line 7894 */
.modal-close-button:before {
  font-family: Inter, sans-serif;
  content: '\D7';
  font-weight: 300;
}
```

### 4.5 `.modal-header`

```css
/* Line 7899 */
.modal-header {
  margin-bottom: 0.75em;
}
/* Line 7903 */
.mod-sidebar-layout .modal-header {
  display: none;
}
```

### 4.6 `.modal-title`

```css
/* Line 7905 */
.modal-title {
  font-size: var(--font-ui-large);
  margin-left: auto;
  margin-right: auto;
  font-weight: var(--font-semibold);
  text-align: start;
  line-height: var(--line-height-tight);
}
/* Line 7913 */
.modal-title:empty {
  display: none;
}
```

### 4.7 `.modal-content`

```css
/* Line 7916 */
.modal-content {
  flex: 1 1 auto;
  font-size: var(--font-ui-medium);
}
```

### 4.8 `.modal-button-container`

```css
/* Line 7920 */
.modal-button-container {
  margin-top: 1.5em;
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
  flex-wrap: wrap;
  font-size: var(--font-ui-medium);
}
```

### 4.9 `.modal-sidebar`

```css
/* Line 7859 */
.modal-sidebar {
  --background-modifier-form-field: var(--background-primary);
  background-color: var(--background-secondary);
  flex: 1 1 var(--modal-community-sidebar-width);
  min-width: var(--modal-community-sidebar-width);
  padding: var(--size-4-3) 0 0 0;
  display: flex;
  flex-direction: column;
}
```

### 4.10 `.prompt` (Quick Switcher / Command Palette)

```css
/* Line 8426 */
.prompt {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-l);
  background-color: var(--background-primary);
  box-shadow: var(--shadow-l);
  border: var(--prompt-border-width) solid var(--prompt-border-color);
  z-index: 1;
  position: absolute;
  top: 80px;
  width: var(--prompt-width);
  max-width: var(--prompt-max-width);
  max-height: var(--prompt-max-height);
  overflow: hidden;
}
```

**Prompt input** (line 8446):
```css
input.prompt-input {
  width: 100%;
  padding: var(--size-4-6);
  padding-inline-end: var(--size-4-12);
  background-color: var(--background-primary);
  font-size: var(--font-ui-medium);
  border: none;
  height: var(--prompt-input-height);
  border-radius: 0;
  border-bottom: 1px solid var(--background-secondary);
}
```

**Prompt results** (line 8466):
```css
.prompt-results {
  list-style: none;
  margin: 0;
  padding: var(--size-4-3);
  overflow-y: auto;
}
```

**Prompt instructions** (line 8472):
```css
.prompt-instructions {
  border-top: 1px solid var(--background-secondary);
  user-select: none;
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
  padding: var(--size-4-2);
  text-align: center;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--size-4-3);
}
```

### 4.11 Modal Open/Close Animation

**No CSS animation for modal open/close exists in `app.css`.** The `.modal-close-button` has a `transition: opacity 0.15s ease-in-out` (line 7871), but the modal container and modal itself have no CSS transitions or `@keyframes`. Modal appearance/disappearance is handled entirely by JavaScript (likely toggling `display` or `opacity` via class).

---

## 5. Status Bar

### 5.1 `.status-bar`

```css
/* Line 5203 */
.status-bar {
  position: var(--status-bar-position);
  width: auto;
  bottom: 0;
  right: 0;
  border-radius: var(--status-bar-radius);
  border-style: solid;
  border-width: var(--status-bar-border-width);
  border-color: var(--status-bar-border-color);
  background-color: var(--status-bar-background);
  color: var(--status-bar-text-color);
  display: flex;
  font-size: var(--status-bar-font-size);
  justify-content: flex-end;
  min-height: 18px;
  padding: var(--size-4-1);
  gap: var(--size-4-1);
  user-select: none;
  z-index: var(--layer-status-bar);
  font-variant-numeric: tabular-nums;
}
```

### 5.2 `.status-bar-item`

```css
/* Line 5227 */
.status-bar-item {
  border-radius: var(--radius-s);
  display: inline-flex;
  align-items: center;
  padding: 3px var(--size-2-2);
  line-height: 1;
}
/* Line 5234 */
.status-bar-item.mod-clickable {
  cursor: var(--cursor);
}
@media (hover: hover) {
  .status-bar-item.mod-clickable:hover {
    background-color: var(--background-modifier-hover);
    color: var(--text-normal);
  }
}
/* Line 5243 */
.status-bar-item.plugin-editor-status,
.status-bar-item.plugin-sync {
  padding: 0 var(--size-2-2);
}
/* Line 5253 */
.status-bar-item:empty {
  display: none;
}
```

### 5.3 `.status-bar-item-icon`

```css
/* Line 5256 */
.status-bar-item-icon {
  vertical-align: middle;
  display: flex;
  align-items: center;
}
```

### 5.4 `.status-bar-item-segment`

```css
/* Line 5261 */
.status-bar-item-segment {
  margin-inline-end: var(--size-4-2);
}
/* Line 5264 */
.status-bar-item-segment:last-child {
  margin-inline-end: 0;
}
```

### 5.5 Mobile

```css
/* Line 17701 */
.is-mobile .status-bar {
  display: none;
}
```

---

## 6. Buttons / Toggles / Inputs

### 6.1 `button` (Base)

```css
/* Line 6295 */
button {
  --text-color: var(--text-normal);
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-color);
  font-size: var(--font-ui-small);
  border-radius: var(--button-radius);
  border: 0;
  padding: var(--size-4-1) var(--size-4-3);
  height: var(--input-height);
  font-weight: var(--input-font-weight);
  cursor: var(--cursor);
  font-family: inherit;
  outline: none;
  user-select: none;
  white-space: nowrap;
}
/* Line 6314 */
button:not(.clickable-icon) {
  color: var(--text-color);
  background-color: var(--interactive-normal);
  box-shadow: var(--input-shadow);
}
@media (hover: hover) {
  button:hover {
    background-color: var(--interactive-hover);
    box-shadow: var(--input-shadow-hover);
  }
}
/* Line 6329 */
button:focus-visible {
  box-shadow: 0 0 0 3px var(--background-modifier-border-focus);
}
/* Line 6332 */
button[disabled],
button[aria-disabled="true"],
button[disabled="true"] {
  cursor: not-allowed;
  opacity: 0.7;
}
```

### 6.2 `button.mod-cta`

```css
/* Line 6365 */
button.mod-cta {
  background-color: var(--interactive-accent);
  --text-color: var(--text-on-accent);
}
@media (hover: hover) {
  button.mod-cta:hover {
    background-color: var(--interactive-accent-hover);
  }
}
/* Line 6377 */
button.mod-cta:focus-visible {
  box-shadow: 0 0 0 3px var(--background-modifier-border-focus);
}
```

### 6.3 `button.mod-warning`

```css
/* Line 6389 */
button.mod-warning {
  background-color: var(--background-modifier-error);
  --text-color: var(--text-on-accent);
}
```

### 6.4 `button.mod-loading`

```css
/* Line 6338 */
button.mod-loading {
  color: transparent;
  position: relative;
  white-space: nowrap;
  overflow: hidden;
  pointer-events: none;
}
/* Line 6345 */
button.mod-loading::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  top: 0; left: 0; right: 0; bottom: 0;
  margin: auto;
  border: 2px solid transparent;
  border-top-color: var(--text-color);
  border-radius: 50%;
  animation: spin 1s ease infinite;
}
```

### 6.5 `.clickable-icon`

```css
/* Line 7032 */
.clickable-icon {
  -webkit-app-region: no-drag;
  background-color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--size-2-2) var(--size-2-3);
  cursor: var(--cursor);
  border-radius: var(--clickable-icon-radius);
  color: var(--icon-color);
  opacity: var(--icon-opacity);
  transition: opacity var(--anim-duration-fast) ease-in-out;
  height: auto;
}
@media (hover: hover) {
  .clickable-icon:hover {
    box-shadow: none;
    opacity: var(--icon-opacity-hover);
    color: var(--icon-color-hover);
    background-color: var(--background-modifier-hover);
  }
  .clickable-icon:active {
    opacity: var(--icon-opacity-hover);
    color: var(--icon-color-focused);
    background-color: var(--background-modifier-hover);
  }
}
/* Line 7060 */
.clickable-icon.is-active {
  opacity: var(--icon-opacity-hover);
  color: var(--icon-color-active);
  background-color: var(--background-modifier-active-hover);
}
/* Line 7086 */
.clickable-icon.mod-warning {
  color: var(--text-error);
}
/* Line 7076 */
.clickable-icon[aria-disabled='true'] {
  background-color: unset;
  color: var(--text-muted);
  opacity: 0.4;
}
```

**In setting-item-control** (line 7092):
```css
.setting-item-control .clickable-icon {
  padding: var(--size-2-2);
}
```

### 6.6 `.checkbox-container` (Native Toggle)

```css
/* Line 8786 */
.checkbox-container {
  -webkit-app-region: no-drag;
  cursor: var(--cursor);
  background-color: var(--background-modifier-border-hover);
  border-radius: var(--toggle-radius);
  display: inline-block;
  flex-shrink: 0;
  height: calc(var(--toggle-thumb-height) + var(--toggle-border-width) * 2);
  position: relative;
  user-select: none;
  width: var(--toggle-width);
  box-shadow: inset 0 4px 10px rgba(0, 0, 0, 0.07), inset 0 0 1px rgba(0, 0, 0, 0.21);
  transition: box-shadow 0.15s ease-in-out, outline 0.15s ease-in-out, border 0.15s ease-in-out, opacity 0.15s ease-in-out;
  outline: 0 solid var(--background-modifier-border-focus);
}
/* Line 8814 */
.checkbox-container.is-enabled {
  background-color: var(--interactive-accent);
}
/* Line 8817 */
.checkbox-container.is-enabled:after {
  transform: translate3d(calc(var(--toggle-width) - var(--toggle-thumb-width) - var(--toggle-border-width)), 0, 0);
}
/* Line 8833 */
.checkbox-container:after {
  pointer-events: none;
  content: '';
  display: block;
  position: absolute;
  background-color: var(--toggle-thumb-color);
  width: var(--toggle-thumb-width);
  height: var(--toggle-thumb-height);
  margin: var(--toggle-border-width) 0 0 0;
  border-radius: var(--toggle-thumb-radius);
  transition: transform 0.15s ease-in-out, width 0.1s ease-in-out, left 0.1s ease-in-out;
  left: 0;
  transform: translate3d(var(--toggle-border-width), 0, 0);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
/* Line 8848 */
.checkbox-container:active:after {
  width: calc(var(--toggle-thumb-width) + var(--toggle-border-width));
}
/* Line 8806 */
.checkbox-container:focus-within {
  outline: var(--toggle-border-width) solid var(--background-modifier-border-focus);
}
```

**Small variant** (line 8851):
```css
.checkbox-container.mod-small {
  width: var(--toggle-s-width);
  height: calc(var(--toggle-s-thumb-height) + var(--toggle-s-border-width) * 2);
}
```

### 6.7 Text `input`

```css
/* Line 7228 */
input[type='text'],
input[type='search'],
input[type='email'],
input[type='password'],
input[type='number'] {
  -webkit-app-region: no-drag;
  background: var(--background-modifier-form-field);
  border: var(--input-border-width) solid var(--background-modifier-border);
  color: var(--text-normal);
  font-family: inherit;
  padding: var(--input-padding);
  font-size: var(--font-ui-small);
  border-radius: var(--input-radius);
  outline: none;
}
@media (hover: hover) {
  input[type='text']:hover {
    background-color: var(--background-modifier-form-field-hover);
    border-color: var(--background-modifier-border-hover);
    transition: box-shadow var(--anim-duration-fast) ease-in-out, border var(--anim-duration-fast) ease-in-out;
  }
}
input[type='text']:focus {
  border-color: var(--background-modifier-border-focus);
  transition: box-shadow 0.15s ease-in-out, border 0.15s ease-in-out;
}
input[type='text']:focus-visible {
  box-shadow: 0 0 0 var(--input-border-width-focus) var(--background-modifier-border-focus);
}
input[type='text']::placeholder {
  color: var(--input-placeholder-color);
}
```

### 6.8 `.dropdown`

```css
/* Line 6710 */
.dropdown {
  -webkit-app-region: no-drag;
  height: var(--input-height);
  font-size: var(--font-ui-small);
  font-family: inherit;
  font-weight: var(--input-font-weight);
  color: var(--text-normal);
  line-height: var(--line-height-tight);
  max-width: 100%;
  box-sizing: border-box;
  margin: 0;
  border: 0;
  box-shadow: var(--input-shadow);
  border-radius: var(--input-radius);
  -webkit-appearance: none;
  appearance: none;
  background-color: var(--dropdown-background);
  padding: var(--dropdown-padding);
  background-repeat: no-repeat, repeat;
  background-position: var(--dropdown-background-position);
  background-size: var(--dropdown-background-size);
  background-blend-mode: hard-light;
}
@media (hover: hover) {
  .dropdown:hover {
    box-shadow: var(--input-shadow-hover);
    background-color: var(--dropdown-background-hover);
  }
}
/* Line 6752 */
.dropdown:focus {
  box-shadow: 0 0 0px 3px var(--background-modifier-border-focus);
  outline: none;
}
```

### 6.9 `input[type='range']` (Slider)

```css
/* Line 7403 */
input[type='range'] {
  width: 100px;
  -webkit-appearance: none;
  background-color: var(--slider-track-background);
  border-radius: var(--slider-track-height);
  height: var(--slider-track-height);
  padding: 0;
  outline: none;
}
/* Line 7416 */
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  height: var(--slider-thumb-height);
  width: var(--slider-thumb-width);
  border-radius: var(--slider-thumb-radius);
  cursor: default;
  background: #FFF;
  border: var(--slider-thumb-border-width) solid var(--slider-thumb-border-color);
  position: relative;
  top: var(--slider-thumb-y);
  transition: all 0.1s linear;
  box-shadow: 0 1px 1px 0px rgba(0, 0, 0, 0.05), 0 2px 2px 0px rgba(0, 0, 0, 0.1);
}
```

---

## 7. Animation / Motion

### 7.1 Duration Variables

```css
/* Line 2001 */
--anim-duration-none: 0;
--anim-duration-superfast: 70ms;
--anim-duration-fast: 140ms;
--anim-duration-moderate: 300ms;
--anim-duration-slow: 560ms;
```

### 7.2 Easing Curves

```css
/* Line 2008 */
--anim-motion-smooth: cubic-bezier(0.45, 0.05, 0.55, 0.95);
--anim-motion-delay: cubic-bezier(0.65, 0.05, 0.36, 1);
--anim-motion-jumpy: cubic-bezier(0.68, -0.55, 0.27, 1.55);
--anim-motion-swing: cubic-bezier(0, 0.55, 0.45, 1);
```

### 7.3 Named `@keyframes`

| Name | Line | Purpose |
|---|---|---|
| `node-inserted` | 3059 | PDF.js: outline color flash |
| `blink` | 3209 | CodeMirror cursor blink |
| `sk-cubeGridScaleDelay` | 4010 | PDF.js loading animation |
| `multi-select-highlight` | 8154 | Duplicate multi-select warning flash |
| `increase` | 8402 | Progress bar expand |
| `decrease` | 8412 | Progress bar shrink |
| `pop-down` | 8967 | Tree item pop-in animation (scale + opacity) |
| `pop-right` | 8985 | Tree item pop-in animation (scale + opacity, horizontal) |
| `rotation` | 9549 | PDF find results rotation |
| `hmd-file-uploading-ani` | 12032 | File upload animation |
| `progress-bar` | 14609 | Progress bar sweep |
| `spin` | 15007 | Loading spinner rotation |

### 7.4 Common Transition Patterns

- **Clickable icons**: `transition: opacity var(--anim-duration-fast) ease-in-out` (line 7032)
- **Modal close button**: `transition: opacity 0.15s ease-in-out` (line 7871)
- **Checkbox container**: `transition: box-shadow 0.15s ease-in-out, outline 0.15s ease-in-out, border 0.15s ease-in-out, opacity 0.15s ease-in-out` (line 8786)
- **Checkbox thumb**: `transition: transform 0.15s ease-in-out, width 0.1s ease-in-out, left 0.1s ease-in-out` (line 8833)
- **Input hover**: `transition: box-shadow var(--anim-duration-fast) ease-in-out, border var(--anim-duration-fast) ease-in-out` (line 7247)
- **Input focus**: `transition: box-shadow 0.15s ease-in-out, border 0.15s ease-in-out` (line 7264)
- **Slider thumb**: `transition: all 0.1s linear` (line 7416)
- **Highlight flash**: `transition: color 0.25s ease, background-color 0.25s ease` (line 3073)

---

## 8. Mobile (`.is-mobile` / `.is-phone`)

### 8.1 Mobile Variable Overrides

```css
/* Line 16792 */
.is-mobile {
  --ribbon-width: 58px;
  --view-header-height: 50px;
  --bases-header-height: 50px;
  --mobile-toolbar-height: 40px;
  --system-status-background: var(--background-primary);
  --caret-color: var(--text-accent);
  --font-ui-smaller: calc(var(--font-text-size) * 0.8);
  --font-ui-small: calc(var(--font-text-size) * 0.937);
  --font-ui-medium: var(--font-text-size);
  --font-ui-large: calc(var(--font-text-size) * 1.2);
  --icon-s: 18px;
  --icon-m: 20px;
  --icon-l: 24px;
  --icon-opacity: 1;
  --icon-opacity-hover: 0.65;
  --input-height: 40px;
  --input-shadow: none;
  --input-shadow-hover: none;
  --input-font-weight: var(--font-medium);
  --input-border-width: 0px;
  --interactive-normal: var(--background-secondary);
  --interactive-hover: var(--background-modifier-border);
  --mobile-sidebar-width: 88vw;
  --mobile-sidebar-width-pinned: 320px;
  --mobile-sidebar-min-width: 320px;
  --mobile-sidebar-max-width: 500px;
  --mobile-sidebar-background: var(--background-primary);
  --mobile-sidebar-radius: var(--radius-xl);
  --nav-item-padding: var(--size-2-3) var(--size-4-2) var(--size-2-3) var(--size-4-6);
  --nav-item-color: var(--text-normal);
  --prompt-input-height: 48px;
  --search-clear-button-size: 16px;
  --search-icon-size: 20px;
  --settings-home-background: var(--background-secondary);
  --slider-thumb-border-width: 0.5px;
  --slider-thumb-height: 24px;
  --slider-thumb-width: 24px;
  --slider-thumb-y: -9px;
  --slider-track-height: 6px;
  --swatch-shadow: none;
  --swatch-height: 40px;
  --swatch-width: 40px;
  --swatch-radius: 40px;
  --toggle-width: 48px;
  --toggle-radius: 26px;
  --toggle-thumb-radius: 26px;
  --toggle-thumb-height: 26px;
  --toggle-thumb-width: 26px;
  --file-margins: var(--size-4-2) var(--size-4-6);
  --background-modifier-cover: rgba(0, 0, 0, 0.25);
  --background-modifier-form-field: var(--interactive-normal);
  --background-modifier-form-field-hover: var(--interactive-hover);
  --keyboard-background: var(--background-primary);
  --checkbox-size: 17px;
  --cursor: pointer;
}
```

**Dark mobile** (line 16849):
```css
.is-mobile.theme-dark {
  --color-base-00: #000;
  --color-base-10: #111;
  --color-base-20: #1e1e1e;
  --tag-background: hsla(var(--interactive-accent-hsl), 0.2);
  --search-result-background: var(--background-secondary);
  --background-modifier-form-field: var(--background-modifier-border);
  --background-modifier-cover: rgba(0, 0, 0, 0.5);
  --background-modifier-hover: rgba(var(--mono-rgb-100), 0.15);
  --settings-home-background: var(--background-primary);
  --mobile-sidebar-background: var(--background-secondary);
  --background-modifier-message: var(--background-secondary);
  --interactive-normal: var(--background-modifier-border);
  --interactive-hover: var(--background-modifier-border-hover);
}
```

**Phone-specific** (line 16874):
```css
.is-phone {
  --border-width: 0.5pt;
  --divider-width: 0.5pt;
  --tab-outline-width: 0.5pt;
  --modal-header-height: 44px;
  --modal-community-sidebar-width: 100%;
  --metadata-label-width: 7.5em;
  --nav-item-size: var(--font-ui-medium);
}
```

### 8.2 Mobile Settings (`.is-phone .setting-item`)

```css
/* Line 17449 */
.is-phone .setting-item {
  padding: 1em 0;
  border-width: var(--border-width) 0 0 0;
  gap: var(--size-4-1);
}
/* Line 17454 */
.is-phone .setting-item-name {
  font-weight: var(--font-medium);
}
/* Line 17457 */
.is-phone .setting-item-info {
  min-width: 0;
}
/* Line 17460 */
.is-phone .setting-item:not(.mod-toggle):not(.setting-item-heading):not(.mod-list-item) {
  flex-direction: column;
  align-items: flex-start;
}
/* Line 17464 */
.is-phone .setting-item:not(.mod-toggle):not(.setting-item-heading):not(.mod-list-item) .setting-item-control {
  margin-top: 12px;
  width: 100%;
}
/* Line 17473 */
.is-phone .setting-item-control select,
.is-phone .setting-item-control input,
.is-phone .setting-item-control button:not(.clickable-icon) {
  width: 100%;
  margin: 0;
}
/* Line 17479 */
.is-phone .setting-item-control button {
  padding: 10px;
}
/* Line 17482 */
.is-phone .setting-item-control select {
  max-width: 100%;
}
```

### 8.3 Mobile Menu

```css
/* Line 18058 */
.is-mobile.theme-light .menu {
  --interactive-normal: var(--background-primary);
}
/* Line 18061 */
.is-mobile .menu {
  --background-modifier-form-field: var(--interactive-normal);
  --dropdown-background: var(--interactive-normal);
  --input-height: 40px;
  border: none;
  max-width: 100%;
}
```

**Phone menu** (line 18091):
```css
.is-phone .menu {
  background-color: var(--background-secondary);
  min-width: unset;
  position: absolute;
  border-radius: var(--radius-l) var(--radius-l) 0 0;
  bottom: 0;
  left: var(--safe-area-inset-left);
  right: var(--safe-area-inset-right);
  margin: 0 auto;
  top: unset !important;
}
/* Line 18102 */
.is-phone .menu-scroll {
  max-height: 60vh;
  background-color: var(--background-secondary);
  padding-bottom: var(--safe-area-inset-bottom) !important;
}
```

**Phone menu grabber** (line 18077):
```css
.is-phone .menu-grabber {
  transition: width 0.15s var(--anim-motion-swing), background-color 0.3s var(--anim-motion-swing);
  height: var(--size-4-1);
  background: var(--text-faint);
  display: flex;
  width: 15%;
  border-radius: var(--radius-xl);
  margin: var(--size-4-2) auto var(--size-4-1);
  position: relative;
}
```

### 8.4 Mobile Modal

```css
/* Line 18156 */
.is-mobile .modal {
  border: none;
}
/* Line 18159 */
.is-mobile .modal-button-container {
  display: flex;
  flex-direction: column;
}
/* Line 18163 */
.is-mobile .mod-confirmation .modal-close-button {
  display: none;
}
/* Line 18166 */
.is-mobile button.mod-warning {
  background-color: var(--interactive-normal);
  font-weight: calc(var(--font-weight) + var(--bold-modifier));
  color: var(--text-error);
}
```

**Phone modal** (line 18171):
```css
.is-phone .modal,
.is-phone .prompt {
  border: none;
  width: 100vw;
  max-width: 100vw;
  min-width: unset;
  left: 0;
  right: 0;
}
/* Line 18180 */
.is-phone .modal {
  border-radius: var(--radius-m) var(--radius-m) 0 0;
  max-height: calc(100vh - var(--safe-area-inset-top));
  padding: 0 var(--safe-area-inset-right) 0 var(--safe-area-inset-left);
  bottom: 0;
}
/* Line 18219 */
.is-phone .modal-header {
  margin-bottom: 0;
  padding: var(--size-4-4) 0;
  position: relative;
  width: 100%;
}
/* Line 18225 */
.is-phone .modal-title {
  display: block;
  font-size: var(--font-ui-medium);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70vw;
}
```

### 8.5 Mobile Prompt

```css
/* Line 18397 */
.is-mobile .prompt {
  border: none;
}
.is-mobile .prompt {
  --prompt-top: calc(var(--safe-area-inset-top) + var(--header-height) + var(--size-4-2));
  top: var(--prompt-top);
  max-height: min(var(--prompt-max-height), calc(100vh - var(--prompt-top) - var(--safe-area-inset-bottom)));
}
```

**Phone prompt** (line 18432):
```css
.is-phone .prompt {
  margin: 0 auto;
  width: calc(100% - var(--safe-area-inset-left) - var(--safe-area-inset-right));
  border-radius: var(--radius-l) var(--radius-l) 0 0;
  min-width: unset;
  box-shadow: none;
  padding-bottom: var(--safe-area-inset-bottom);
  max-height: 100vh;
  height: calc(100vh - var(--prompt-top));
}
/* Line 18452 */
.is-phone .prompt-instructions {
  display: none;
}
```

### 8.6 Mobile Status Bar

```css
/* Line 17701 */
.is-mobile .status-bar {
  display: none;
}
```

### 8.7 ADJUDICATION QUESTION B: Mobile Setting-Item Card/Pill

**Answer: No. `.is-mobile .setting-item` (or `.is-phone .setting-item`) does NOT render as a rounded card/pill with horizontal padding, background, or border-radius.**

Evidence from `app.css` line 17449:
```css
.is-phone .setting-item {
  padding: 1em 0;
  border-width: var(--border-width) 0 0 0;
  gap: var(--size-4-1);
}
```

The mobile setting item:
- Has `padding: 1em 0` (vertical only, no horizontal padding)
- Has `border-width: var(--border-width) 0 0 0` (top border only, same as desktop's `border-top`)
- Has NO `border-radius`
- Has NO `background-color`
- Has NO `box-shadow`
- Has NO `margin` that would create card-like separation

The only mobile-specific changes are:
1. Padding changes from `0.75em 0` to `1em 0`
2. Border explicitly set to top-only (was already top-only via `border-top` on desktop)
3. Gap reduced from `var(--size-4-3)` to `var(--size-4-1)`
4. Non-toggle items stack vertically (`flex-direction: column`)
5. Controls go full-width

**Conclusion:** Any claim that Obsidian renders settings as rounded cards/pills on mobile is false. The mobile setting rows are flat, full-width, border-separated rows: identical in character to desktop, just with adjusted spacing and column layout.

---

## Summary of Sections

1. **CSS Variable Foundations**: Colors, typography, spacing, radius, shadows, interactive states, z-index layers, form fields, toggles, icons, modals, menus, status bar
2. **Settings Surface**: `.setting-item` class tree, heading variant, control layout, container query behavior, ADJUDICATION A
3. **Menus & Submenus**: `.menu` container, `.menu-item` variants, icons, separators, label items, submenu icon handling
4. **Modals**: `.modal-container`, `.modal-bg`, `.modal` variants, close button, header, title, content, button container, sidebar, `.prompt`
5. **Status Bar**: Container, items, icons, segments, clickable behavior, mobile hidden
6. **Buttons / Toggles / Inputs**: Base button, CTA, warning, loading, clickable-icon, checkbox-container (toggle), text input, dropdown, range slider
7. **Animation / Motion**: Duration variables, easing curves, named `@keyframes`, common transition patterns
8. **Mobile**: Variable overrides, settings, menus, modals, prompts, status bar, ADJUDICATION B
