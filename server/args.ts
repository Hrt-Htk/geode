// Server argv parsing, extracted so the refusal paths are testable without starting a
// server (#680 L-4). The admin token is env-only: argv is world-readable in
// /proc/<pid>/cmdline, and silently skipping the old flag left the process with no
// admin credential at all.
export interface ServerArgs {
  dataDir: string;
  port: number;
  host: string;
  adminToken: string | null;
}

export type ParsedArgs = { ok: true; args: ServerArgs } | { ok: false; message: string };

const FLAGS = new Set(["--data-dir", "--port", "--host"]);

export function parseArgs(argv: string[], adminToken: string | null): ParsedArgs {
  const args: ServerArgs = { dataDir: "./data", port: 8080, host: "0.0.0.0", adminToken };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag.startsWith("--admin-token")) {
      return {
        ok: false,
        message: `${flag} is gone: set GEODE_ADMIN_TOKEN (argv is world-readable in /proc)`,
      };
    }
    if (!FLAGS.has(flag)) return { ok: false, message: `unknown argument: ${flag}` };
    const value = argv[++i];
    if (value === undefined) return { ok: false, message: `missing value for ${flag}` };
    if (flag === "--data-dir") args.dataDir = value;
    else if (flag === "--port") {
      if (!/^\d+$/.test(value) || Number(value) > 65535) {
        return { ok: false, message: `invalid --port: ${value} (0 to 65535)` };
      }
      args.port = Number(value);
    } else args.host = value;
  }
  return { ok: true, args };
}
