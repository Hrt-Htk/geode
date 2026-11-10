import type { Evaluatable } from "./device-abstraction";

/** #54: the resync surfaces read and seeded through the page, shared by the desktop and
 * on-device specs so both assert on the same DOM and the same files. */

export function statusRowText(o: Evaluatable): Promise<string> {
  return o.eval<string>(`
    (() => {
      const row = document.querySelector('[data-testid="geode-settings-sync-status"]');
      return row?.querySelector(".setting-item-description")?.textContent?.trim() ?? "";
    })()
  `);
}

export function resyncButtonText(o: Evaluatable): Promise<string> {
  return o.eval<string>(`
    (() => {
      const btn = document.querySelector('[data-testid="geode-settings-resync"]');
      return btn?.textContent?.trim() ?? "";
    })()
  `);
}

/** Every notice currently on screen (the run's own notice is the transient one). */
export function noticeTexts(o: Evaluatable): Promise<string[]> {
  return o.eval<string[]>(`
    [...document.querySelectorAll(".notice")].map((n) => n.textContent?.trim() ?? "")
  `);
}

export function confirmOpen(o: Evaluatable): Promise<boolean> {
  return o.eval<boolean>(`!!document.querySelector(".geode-confirm-modal")`);
}

export function trackedCount(o: Evaluatable): Promise<number> {
  return o.eval<number>(`
    (() => {
      const state = app.plugins.plugins.geode.syncManager?.state;
      return state ? [...state.getAllLocalFiles().values()].filter((r) => !r.deleted).length : 0;
    })()
  `);
}

/** Unique bytes per file, so nothing dedupes away: the rebuild has real work to do.
 * `largeBytes` adds one big blob, which keeps a desktop rebuild busy long enough to shoot. */
export async function seedResyncFiles(
  o: Evaluatable,
  opts: { notes: number; largeBytes?: number },
): Promise<void> {
  await o.eval(`
    const files = [];
    for (let index = 0; index < ${opts.notes}; index++) {
      files.push({ path: "notes/note-" + String(index).padStart(4, "0") + ".md", size: 700 + index });
    }
    for (const [index, file] of files.entries()) {
      let state = 7919 + index * 104729;
      const bytes = new Uint8Array(file.size);
      for (let i = 0; i < bytes.length; i++) {
        state = (state * 1103515245 + 12345) % 2147483648;
        bytes[i] = state & 0xff;
      }
      if (!(await app.vault.adapter.exists("notes"))) await app.vault.createFolder("notes");
      await app.vault.createBinary(file.path, bytes.buffer);
    }
    const commits = files.map((file) => ({ path: file.path, kind: "commit" }));
    const largeBytes = ${opts.largeBytes ?? 0};
    if (largeBytes > 0) {
      const large = new Uint8Array(largeBytes);
      for (let offset = 0; offset < large.length; offset += 65536) {
        crypto.getRandomValues(large.subarray(offset, offset + 65536));
      }
      if (!(await app.vault.adapter.exists("media"))) await app.vault.createFolder("media");
      await app.vault.createBinary("media/large.bin", large.buffer);
      commits.push({ path: "media/large.bin", kind: "commit" });
    }
    await app.plugins.plugins.geode.syncManager.handlePendingOps(commits);
    return true;
  `);
}
