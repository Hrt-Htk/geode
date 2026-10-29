import type { Page } from "@playwright/test";
import path from "node:path";
import type { ObsidianInstance } from "../fixtures/obsidian";
import type { PhoneInstance } from "../fixtures/phone-obsidian";
import { shotPath } from "./shots";

export type Evaluatable = { eval: <T>(jsExpr: string) => Promise<T> };

export abstract class SyncDevice {
  /** The app window, for DOM assertions a spec cannot make through `eval` (#638 fit checks). */
  abstract get win(): Page;
  abstract eval<T>(js: string): Promise<T>;
  abstract readVaultFile(filePath: string): Promise<string>;
  abstract listVaultDir(dirPath: string): Promise<string[]>;
  abstract fileExists(filePath: string): Promise<boolean>;
  abstract screenshot(label: string): Promise<void>;
  abstract consoleErrors(): Promise<string[]>;
  abstract close(): Promise<void>;
  abstract readonly vaultDir: string | null;
}

export class DesktopDevice extends SyncDevice {
  readonly vaultDir: string;

  constructor(private instance: ObsidianInstance) {
    super();
    this.vaultDir = instance.vaultDir;
  }

  get win(): Page {
    return this.instance.win;
  }

  eval<T>(js: string): Promise<T> {
    return this.instance.eval(js);
  }

  async readVaultFile(filePath: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return readFile(path.join(this.vaultDir, ...filePath.split("/")), "utf8");
  }

  async listVaultDir(dirPath: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const parts = dirPath ? dirPath.split("/") : [];
    return readdir(path.join(this.vaultDir, ...parts));
  }

  fileExists(filePath: string): Promise<boolean> {
    return this.instance.eval<boolean>(
      `await app.vault.adapter.exists(${JSON.stringify(filePath)})`,
    );
  }

  async screenshot(label: string): Promise<void> {
    await this.instance.win.screenshot({ path: shotPath(label) });
  }

  consoleErrors(): Promise<string[]> {
    return Promise.resolve(this.instance.consoleErrors());
  }

  close(): Promise<void> {
    return this.instance.close();
  }
}

export class PhoneDevice extends SyncDevice {
  readonly vaultDir: null = null;

  constructor(private phone: PhoneInstance) {
    super();
  }

  /** A getter: `relaunch()` swaps the attached WebView. */
  get win(): Page {
    return this.phone.win;
  }

  eval<T>(js: string): Promise<T> {
    return this.phone.eval(js);
  }

  readVaultFile(filePath: string): Promise<string> {
    return this.phone.eval<string>(
      `await app.vault.adapter.read(${JSON.stringify(filePath)})`,
    );
  }

  async listVaultDir(dirPath: string): Promise<string[]> {
    const dir = dirPath || "/";
    const files = await this.phone.eval<string[]>(
      `(await app.vault.adapter.list(${JSON.stringify(dir)})).files`,
    );
    return files.map((f: string) => f.split("/").pop()!);
  }

  fileExists(filePath: string): Promise<boolean> {
    return this.phone.eval<boolean>(
      `await app.vault.adapter.exists(${JSON.stringify(filePath)})`,
    );
  }

  async screenshot(label: string): Promise<void> {
    await this.phone.screenshot(shotPath(label));
  }

  consoleErrors(): Promise<string[]> {
    return this.phone.consoleErrors();
  }

  close(): Promise<void> {
    return this.phone.close();
  }

  /** `am force-stop md.obsidian` mid-operation (no graceful close). */
  forceStop(): Promise<void> {
    return this.phone.forceStop();
  }

  /** force-stop + relaunch + re-attach; the device keeps working through eval/screenshot after. */
  async relaunch(): Promise<void> {
    this.phone = await this.phone.relaunch();
  }
}
