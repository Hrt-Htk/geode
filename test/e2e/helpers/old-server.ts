import { spawn } from "node:child_process";
import path from "node:path";

const DENO_BIN = process.env.DENO_BIN ?? "deno";

/**
 * An OLD Geode server (#625): it speaks one protocol behind this build, so a
 * current plugin is refused with a protocol mismatch: the "server is behind"
 * case. Runs `old-server.deno.ts` under Deno; it pins the historical reason text.
 */
export async function startOldServer(): Promise<{ url: string; stop: () => void }> {
  const scriptPath = path.join(process.cwd(), "test", "e2e", "helpers", "old-server.deno.ts");
  const child = spawn(DENO_BIN, ["run", "-A", scriptPath, "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("old-server did not start")), 30_000);
    child.stdout.on("data", (data: Buffer) => {
      const match = /old-server listening (\d+)/.exec(String(data));
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.stderr.on("data", () => {});
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      child.kill();
    },
  };
}
