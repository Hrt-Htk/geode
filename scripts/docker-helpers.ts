// Plumbing shared by the Docker scripts (`scripts/docker-smoke.ts`,
// `scripts/host-update-test.ts`): run a command and read both streams, fail loudly on a
// non-zero exit, wait for a condition, and find a free loopback port.

export type Result = { code: number; out: string; text: string };

/** Exit code, stdout, and both streams together, for a command that may fail. */
export async function exec(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<Result> {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    env: { ...Deno.env.toObject(), ...env },
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(result.stdout).trim();
  const text = `${out}\n${new TextDecoder().decode(result.stderr)}`.trim();
  return { code: result.code, out, text };
}

/** Run a command and fail loudly with both streams on a non-zero exit. */
export async function sh(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<string> {
  const { code, out, text } = await exec(args, env, cwd);
  if (code !== 0) throw new Error(`failed: ${args.join(" ")}\n${text}`);
  return out;
}

/** The whole failure, not just its top layer: `fetch failed` alone says nothing. */
export function chain(e: unknown, depth = 0): string {
  if (!(e instanceof Error) || depth > 5) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  return `${e.name}: ${e.message}${cause === undefined ? "" : ` <- ${chain(cause, depth + 1)}`}`;
}

export async function waitFor(check: () => Promise<boolean>, what: string, ms = 90_000) {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      // Swallowed so the wait retries, but never silently: a timeout has to say why.
      last = chain(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last failure: ${last})` : ""}`);
}

export function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Docker writes as root and the server as 1993, so both directions need a chown. */
export function chownTree(image: string, path: string, owner: string): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    `${path}:/target`,
    "--entrypoint",
    "chown",
    image,
    "-R",
    owner,
    "/target",
  ];
}
