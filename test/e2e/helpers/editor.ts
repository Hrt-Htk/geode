import type { Evaluatable } from "./device-abstraction";

export async function writeVaultFile(
  instance: Evaluatable,
  vaultPath: string,
  content: string,
): Promise<void> {
  await instance.eval(`
    const filePath = ${JSON.stringify(vaultPath)};
    const fileContent = ${JSON.stringify(content)};
    const parts = filePath.split("/");
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current = current ? current + "/" + part : part;
      if (!(await app.vault.adapter.exists(current))) {
        await app.vault.adapter.mkdir(current);
      }
    }
    await app.vault.adapter.write(filePath, fileContent);
    return true;
  `);
}

export async function readVaultFile(
  instance: Evaluatable,
  vaultPath: string,
): Promise<string> {
  return await instance.eval(`await app.vault.adapter.read(${JSON.stringify(vaultPath)})`);
}

/** Vault text, or "" when the path is absent: a poll must not throw before the file lands. */
export async function readVaultTextIfPresent(
  instance: Evaluatable,
  vaultPath: string,
): Promise<string> {
  return await instance.eval<string>(
    `(await app.vault.adapter.exists(${JSON.stringify(vaultPath)}))
      ? await app.vault.adapter.read(${JSON.stringify(vaultPath)})
      : ""`,
  );
}

/** The file the open editor shows, or null when its leaf has none (a vanished file). */
export async function activeEditorPath(instance: Evaluatable): Promise<string | null> {
  return await instance.eval<string | null>(
    `app.workspace.activeLeaf?.view?.file?.path ?? null`,
  );
}
