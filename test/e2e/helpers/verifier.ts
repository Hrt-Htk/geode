import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// E2E requires Deno on PATH (or set DENO_BIN env var to the deno executable).
const DENO_BIN = process.env.DENO_BIN ?? "deno";

/**
 * Deno is required because core/crypto.ts imports via bare specifiers
 * (@noble/hashes/blake3) that only resolve through deno.json's import map.
 */
async function runDenoScript(script: string, args: string[]): Promise<string> {
  const scriptPath = path.join(process.cwd(), "test", "e2e", "helpers", script);
  const { stdout, stderr } = await execFileAsync(DENO_BIN, ["run", "-A", scriptPath, ...args]);
  const result = stdout.trim();
  if (!result) {
    throw new Error(`${script} produced no output. stderr: ${stderr}`);
  }
  return result;
}

/** A real passphrase verifier for the vault's stored params. */
export function computeVerifier(
  passphrase: string,
  saltB64: string,
  params: { ops: number; mem: number },
): Promise<string> {
  return runDenoScript("compute-verifier.deno.ts", [
    passphrase,
    saltB64,
    String(params.ops),
    String(params.mem),
  ]);
}

/** The re-key auth key the plugin derives from the same unlocked keys (#675). */
export function computeAuthKeyHex(
  passphrase: string,
  saltB64: string,
  params: { ops: number; mem: number },
): Promise<string> {
  return runDenoScript("compute-auth-key.deno.ts", [
    passphrase,
    saltB64,
    String(params.ops),
    String(params.mem),
  ]);
}
