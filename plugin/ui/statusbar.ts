import { Menu, Platform, setIcon } from "obsidian";
import { type VersionStatus } from "../sync/version-state.ts";
import { COLOR_CLASSES, type IconInput, type IconState, resolveIcon } from "./statusbar-icon.ts";
import { formatError, log } from "../plumbing/log.ts";
import { buildStatusMenu, type StatusMenuItem } from "./status-menu.ts";
import { pickViewActionsIndex } from "./view-actions.ts";
import { nextOfflineSince } from "./sync-banner.ts";
import type { MassDeleteHold } from "../sync/mass-delete-hold.ts";

type PluginInstance = {
  getPendingCount: () => number;
  getConflictCount: () => number;
  isUnlocked: boolean | (() => boolean);
  isConfigured: () => boolean;
  getPausedAt: () => number;
  pauseSync: () => Promise<void>;
  resumeSync: () => Promise<void>;
  openTrashModal: () => void;
  openActivityModal: () => void;
  openConflictsModal: () => void;
  openDevicesView: () => void;
  openSettingsTab: () => void;
  /** #601: the settings row and the menu entry open the same review window. */
  openMassDeleteReview: () => void;
};

export class StatusBar {
  private statusEl: HTMLElement | null;
  private mobileEl: HTMLButtonElement | null = null;
  private mobileObserver: MutationObserver | null = null;
  private listeners = new Set<() => void>();

  private readonly isMobile = Platform.isMobile;
  private lastSyncTime = 0;
  // #420: outbound commit acks only; drives the green hold.
  private lastAckAt = 0;
  private state: string = "disconnected";
  private pendingCount = 0;
  private dirtyCount = 0;
  private conflictCount = 0;
  private syncingProgress: { current: number; total: number } | null = null;
  private reconnectDelay = 0;
  private offlineSince = 0;
  private lastAttemptAt = 0;
  private droppedCount = 0;
  private pausedAt = 0;
  private massDeleteHold: MassDeleteHold | null = null;
  private maxRetries = 0;
  private versionStatus: VersionStatus = { kind: "ok" };
  // #523: persist the icon span across renders: a fresh SVG restarts the CSS spin at 0°.
  private desktopIcon: string | null = null;
  private desktopIconEl: HTMLElement | null = null;
  private mobileIcon: string | null = null;
  private mobileIconEl: HTMLElement | null = null;

  constructor(private plugin: PluginInstance) {
    const host = plugin as unknown as { addStatusBarItem: () => HTMLElement };
    this.statusEl = host.addStatusBarItem();
    if (this.statusEl) {
      this.statusEl.addEventListener("click", (evt) => this.openMenu(evt));
      this.statusEl.addClass("geode-statusbar-clickable");
      this.statusEl.dataset.testid = "geode-statusbar";
    }

    if (this.isMobile) {
      this.setupMobileStatus();
    }

    this.render();
  }

  private setupMobileStatus() {
    // Native-style button matching .view-actions children
    this.mobileEl = document.createElement("button");
    this.mobileEl.className = "clickable-icon view-action geode-mobile-status";
    this.mobileEl.dataset.testid = "geode-mobile-status";
    this.mobileEl.setAttribute("aria-label", "Geode sync status");
    this.mobileEl.addEventListener("click", (evt) => this.openMenu(evt));

    // Pick a .view-actions container to host the mobile status button. Phones expose a raised
    // container; tablets render .view-actions without mod-raised, so we fall back to any visible
    // container (#309) rather than requiring mod-raised.
    const findActiveContainer = (): HTMLElement | null => {
      const containers = [...document.querySelectorAll<HTMLElement>(".view-actions")];
      const idx = pickViewActionsIndex(
        containers.map((c) => ({
          raised: c.classList.contains("mod-raised"),
          visible: c.offsetParent !== null,
        })),
      );
      return idx >= 0 ? containers[idx] : null;
    };

    const tryInject = () => {
      if (!this.mobileEl) return;
      const container = findActiveContainer();
      if (!container) return;

      // Already a child of the active container: no-op.
      if (this.mobileEl.parentElement === container) return;

      // Insert before the last button (⋮ more options)
      const lastChild = container.lastElementChild;
      if (lastChild) {
        container.insertBefore(this.mobileEl, lastChild);
      } else {
        container.appendChild(this.mobileEl);
      }
    };

    tryInject();

    this.mobileObserver = new MutationObserver(() => tryInject());
    this.mobileObserver.observe(document.body, { childList: true, subtree: true });
  }

  updateState(state: string): void {
    this.state = state;
    this.offlineSince = nextOfflineSince(this.offlineSince, state, Date.now());
    this.render();
  }

  updateLastSync(): void {
    this.lastSyncTime = Date.now();
    this.render();
  }

  /** #420: outbound commit ack: stamps the green-hold clock (not the tooltip). */
  updateLastAck(): void {
    this.lastAckAt = Date.now();
    this.render();
  }

  getIconInput(): IconInput {
    return {
      unlocked: this.getUnlocked(),
      versionStatus: this.versionStatus,
      conflictCount: this.conflictCount,
      state: this.state,
      pendingCount: this.pendingCount,
      dirtyCount: this.dirtyCount,
      lastSyncTime: this.lastSyncTime,
      lastAckAt: this.lastAckAt,
      syncingProgress: this.syncingProgress,
      reconnectDelay: this.reconnectDelay,
      offlineSince: this.offlineSince,
      lastAttemptAt: this.lastAttemptAt,
      droppedCount: this.droppedCount,
      pausedAt: this.pausedAt,
      massDeleteHold: this.massDeleteHold,
      now: Date.now(),
      maxRetries: this.maxRetries,
    };
  }

  setPausedAt(ts: number): void {
    this.pausedAt = ts;
    this.render();
  }

  /** #601: the held mass delete (null once it is decided). */
  setMassDeleteHold(hold: MassDeleteHold | null): void {
    this.massDeleteHold = hold;
    this.render();
  }

  /** Resume restarts from a clean slate: a stale offline window must not flash the #339 banner. */
  clearOffline(): void {
    this.offlineSince = 0;
    this.lastAttemptAt = 0;
    this.render();
  }

  /** Every live consumer (settings row, activity footer); returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  updatePending(count: number): void {
    this.pendingCount = count;
    this.render();
  }

  updateDropped(count: number): void {
    this.droppedCount = count;
    this.render();
  }

  updateRetries(count: number): void {
    this.maxRetries = count;
    this.render();
  }

  updateDirty(count: number): void {
    this.dirtyCount = count;
    this.render();
  }

  updateConflicts(count: number): void {
    this.conflictCount = count;
    this.render();
  }

  updateSyncingProgress(current: number, total: number): void {
    this.syncingProgress = { current, total };
    this.render();
  }

  clearSyncingProgress(): void {
    this.syncingProgress = null;
    this.render();
  }

  updateReconnectDelay(delayMs: number): void {
    this.reconnectDelay = delayMs;
    this.lastAttemptAt = Date.now();
    this.render();
  }

  setVersionStatus(status: VersionStatus): void {
    this.versionStatus = status;
    this.render();
  }

  tick(): void {
    this.render();
  }

  private render(): void {
    const input = this.getIconInput();
    const iconState = resolveIcon(input);
    if (this.statusEl) {
      this.renderDesktop(this.statusEl, iconState);
    }
    if (this.mobileEl) {
      this.renderMobile(this.mobileEl, iconState);
    }
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (error) {
        log.warn("status listener failed", { error: formatError(error) });
      }
    });
  }

  /** Render into the desktop status bar element (has DOMPulator methods). */
  private renderDesktop(el: HTMLElement, state: IconState): void {
    for (const cls of COLOR_CLASSES) el.removeClass(cls);

    if (this.desktopIcon !== state.icon) {
      this.desktopIconEl?.remove();
      const iconEl = el.createSpan();
      setIcon(iconEl, state.icon);
      this.desktopIconEl = iconEl;
      this.desktopIcon = state.icon;
    }

    el.addClass(state.color);

    // #523: touch the spin class only on change (re-adding restarts the animation).
    const hasSpin = el.hasClass("geode-statusbar-spin");
    const spin = state.spin === true;
    if (hasSpin && !spin) el.removeClass("geode-statusbar-spin");
    else if (!hasSpin && spin) el.addClass("geode-statusbar-spin");

    el.title = state.tooltip;
  }

  /** Render into the mobile button element (standard DOM, no DOMPulator). */
  private renderMobile(el: HTMLButtonElement, state: IconState): void {
    for (const cls of COLOR_CLASSES) el.classList.remove(cls);

    if (this.mobileIcon !== state.icon) {
      this.mobileIconEl?.remove();
      const iconEl = document.createElement("span");
      setIcon(iconEl, state.icon);
      el.appendChild(iconEl);
      this.mobileIconEl = iconEl;
      this.mobileIcon = state.icon;
    }

    el.classList.add(state.color);

    // #523: touch the spin class only on change (re-adding restarts the animation).
    const hasSpin = el.classList.contains("geode-statusbar-spin");
    const spin = state.spin === true;
    if (hasSpin && !spin) el.classList.remove("geode-statusbar-spin");
    else if (!hasSpin && spin) el.classList.add("geode-statusbar-spin");

    // Accessibility: update aria-label with current state
    el.setAttribute("aria-label", state.tooltip);
  }

  /** #430: the status icon opens a native Menu, not the debug pane. Desktop anchors at the
   *  pointer; on phones Obsidian renders the menu as a bottom sheet at the tapped position. */
  private openMenu(evt: MouseEvent): void {
    const menu = new Menu();
    for (
      const item of buildStatusMenu({
        unlocked: this.getUnlocked(),
        configured: this.plugin.isConfigured(),
        paused: this.plugin.getPausedAt() > 0,
        conflictCount: this.conflictCount,
        heldCount: this.massDeleteHold?.files.length ?? 0,
      })
    ) {
      if (item.separatorBefore) menu.addSeparator();
      menu.addItem((mi) => {
        mi.setTitle(item.label).setIcon(item.icon);
        mi.onClick(() => this.runItem(item));
      });
    }
    if (this.isMobile) {
      menu.showAtPosition({ x: evt.clientX ?? 0, y: evt.clientY ?? 0 });
    } else {
      menu.showAtMouseEvent(evt);
    }
  }

  private getUnlocked(): boolean {
    return typeof this.plugin.isUnlocked === "function"
      ? this.plugin.isUnlocked()
      : this.plugin.isUnlocked;
  }

  private runItem(item: StatusMenuItem): void {
    switch (item.id) {
      case "pause":
        if (item.action === "resume") void this.plugin.resumeSync();
        else void this.plugin.pauseSync();
        break;
      case "deleted":
        this.plugin.openTrashModal();
        break;
      case "activity":
        this.plugin.openActivityModal();
        break;
      case "conflicts":
        this.plugin.openConflictsModal();
        break;
      case "devices":
        this.plugin.openDevicesView();
        break;
      case "missing":
        this.plugin.openMassDeleteReview();
        break;
      case "settings":
        this.plugin.openSettingsTab();
        break;
    }
  }

  /** Disconnect the mobile observer and remove the mobile button from the DOM. */
  public dispose(): void {
    this.listeners.clear();
    this.mobileObserver?.disconnect();
    this.mobileObserver = null;
    this.mobileEl?.remove();
    this.mobileEl = null;
  }
}
