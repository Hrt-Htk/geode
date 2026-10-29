import type { Page } from "@playwright/test";
import type { Evaluatable, SyncDevice } from "./device-abstraction";

function isDevice(x: Page | SyncDevice): x is SyncDevice {
  return typeof (x as SyncDevice).eval === "function";
}

export async function waitForStatusBar(
  target: Page | SyncDevice,
  expectedText: string,
  timeoutMs = 30_000,
): Promise<string> {
  return await poll(
    () => readGeodeStatusBar(target),
    (text) => text.includes(expectedText),
    timeoutMs,
    `status bar text containing "${expectedText}"`,
  );
}

export async function waitForStatusBarAny(
  target: Page | SyncDevice,
  expectedTexts: string[],
  timeoutMs = 30_000,
): Promise<string> {
  return await poll(
    () => readGeodeStatusBar(target),
    (text) => expectedTexts.some((t) => text.includes(t)),
    timeoutMs,
    `status bar text containing one of [${expectedTexts.join(", ")}]`,
  );
}

/** #420: wait out the ~1 s post-ack green hold so driven states aren't masked.
 * No-op when nothing has acked yet (lastAckAt 0). */
export async function waitAckHoldExpired(
  target: Page | SyncDevice,
  timeoutMs = 5_000,
): Promise<void> {
  const read = (): Promise<number> =>
    isDevice(target)
      ? target.eval<number>(`Date.now() - (app.plugins.plugins.geode.statusBar.lastAckAt || 0)`)
      : target.evaluate<number>(
        `Date.now() - (app.plugins.plugins.geode.statusBar.lastAckAt || 0)`,
      );
  await poll(read, (ageMs) => ageMs >= 1_000, timeoutMs, "ack green-hold to expire");
}

export async function waitForFileInExplorer(
  target: Page | SyncDevice,
  vaultPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  if (isDevice(target)) {
    await poll(
      async () => await target.fileExists(vaultPath),
      (exists) => exists === true,
      timeoutMs,
      `file exists "${vaultPath}"`,
    );
    return;
  }
  await poll(
    async () => {
      return (await countExplorerEntriesByPath(target, vaultPath)) > 0;
    },
    Boolean,
    timeoutMs,
    `file explorer entry for "${vaultPath}"`,
  );
}

export async function waitForFileMissingInExplorer(
  target: Page | SyncDevice,
  vaultPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  if (isDevice(target)) {
    await poll(
      async () => await target.fileExists(vaultPath),
      (exists) => exists === false,
      timeoutMs,
      `file missing "${vaultPath}"`,
    );
    return;
  }
  await poll(
    async () => {
      return (await countExplorerEntriesByPath(target, vaultPath)) > 0;
    },
    (exists) => !exists,
    timeoutMs,
    `file explorer entry removal for "${vaultPath}"`,
  );
}

export async function waitForConvergence(
  A: Evaluatable,
  B: Evaluatable,
  vaultPath: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  return await poll(
    async () => {
      const [aExists, bExists] = await Promise.all([
        A.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(vaultPath)})`),
        B.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(vaultPath)})`),
      ]);
      if (!aExists && !bExists) return null;
      if (!aExists || !bExists) return undefined;

      const [aContent, bContent] = await Promise.all([
        A.eval<string>(`await app.vault.adapter.read(${JSON.stringify(vaultPath)})`),
        B.eval<string>(`await app.vault.adapter.read(${JSON.stringify(vaultPath)})`),
      ]);
      return aContent === bContent ? aContent : undefined;
    },
    (value) => value !== undefined,
    timeoutMs,
    `convergence for "${vaultPath}"`,
  );
}

/**
 * Wait until BOTH devices have `vaultPath` present with exactly `expected` content.
 * Unlike waitForConvergence, this never accepts a transient "both absent" state as converged: use it
 * when a file is expected to (re)appear (e.g. after a restore), where waitForConvergence would
 * short-circuit to null on the brief window before the write propagates.
 */
export async function waitForContent(
  A: Evaluatable,
  B: Evaluatable,
  vaultPath: string,
  expected: string,
  timeoutMs = 60_000,
): Promise<void> {
  const read = (inst: Evaluatable) =>
    inst.eval<string | null>(
      `(await app.vault.adapter.exists(${
        JSON.stringify(vaultPath)
      })) ? await app.vault.adapter.read(${JSON.stringify(vaultPath)}) : null`,
    );
  await poll(
    async () => {
      const [a, b] = await Promise.all([read(A), read(B)]);
      return a === expected && b === expected ? true : undefined;
    },
    (value) => value !== undefined,
    timeoutMs,
    `content convergence for "${vaultPath}"`,
  );
}

async function poll<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await read();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

export async function readGeodeStatusBar(target: Page | SyncDevice): Promise<string> {
  if (isDevice(target)) {
    return target.eval<string>(`(() => {
      const el = document.querySelector('[data-testid="geode-statusbar"]');
      if (el) { const t = el.getAttribute("title"); if (t && t.includes("Geode")) return t; }
      const items = Array.from(document.querySelectorAll(".status-bar-item")).map((e) => e.textContent || "");
      return items.find((t) => t.includes("Geode")) ?? "";
    })()`);
  }
  /* Status bar uses icons; read the title attribute (tooltip) for state info. */
  const testidEl = target.locator('[data-testid="geode-statusbar"]');
  if ((await testidEl.count()) > 0) {
    const title = await testidEl.getAttribute("title");
    if (title?.includes("Geode")) return title;
  }
  /* Fallback: check text content for older plugin builds. */
  const texts = await target.locator(".status-bar-item").allTextContents();
  return texts.find((text: string) => text.includes("Geode")) ?? "";
}

async function countExplorerEntriesByPath(win: Page, vaultPath: string): Promise<number> {
  const normalizedVaultPath = vaultPath.replaceAll("\\", "/");
  return await win.locator(`.nav-file-title[data-path=${JSON.stringify(normalizedVaultPath)}]`)
    .count();
}
