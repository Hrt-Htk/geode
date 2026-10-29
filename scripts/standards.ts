// Scripted coding standards (#377), zero-violation with a shrink-only baseline.
// Each check yields `file:rule` keys. A key over its baseline count fails; a
// key under it also fails until `--update` lowers the baseline, so the
// baseline only ever shrinks. A missing baseline means zero allowed
// violations, and `--update` refuses to write any baseline that records a
// violation: a new rule lands clean or with a hand-written, shrink-only
// baseline.
//
// Usage: `deno run -A scripts/standards.ts [--update]`
// Needs `deno task build:plugin` first (tsc reads plugin/_generated).

import { parse as parseJsonc } from "jsr:@std/jsonc@^1";
import { relative } from "jsr:@std/path@^1";
import { firstCssSyntaxError } from "./css-syntax.ts";

export const BASELINE = "scripts/standards-baseline.json";
export type Counts = Record<string, number>;

// Test names describe behavior (#648): kebab-case, no issue numbers (cite the
// issue in a comment), and `gateN-` only where docs/testing/step-gates.md cites
// that spec as gate N's evidence.
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEST_FILE = /^(.*?)(?:\.(?:phone|hybrid))?\.(?:test|spec)\.ts$/;
const STRAY_PREFIX = /^(?:issue|gate)-/;
const GATE_PREFIX = /^gate(\d+)-/;
const STEP_GATES = 11;

export function testNameViolations(paths: string[], gateDoc: string): string[] {
  const keys: string[] = [];
  for (const path of paths) {
    const base = TEST_FILE.exec(path.slice(path.lastIndexOf("/") + 1))?.[1];
    if (base === undefined) continue;
    if (!KEBAB_CASE.test(base)) keys.push(`${path}:kebab-case`);
    const gate = GATE_PREFIX.exec(base);
    const gateNumber = gate === null ? 0 : Number(gate[1]);
    const evidence = gateNumber >= 1 && gateNumber <= STEP_GATES && gateDoc.includes(base);
    const issueNumber = /(?:^|-)(?:issue\d+|gate\d+)-/.test(base) &&
      (gate === null || gateNumber > STEP_GATES);
    if (STRAY_PREFIX.test(base) || issueNumber) keys.push(`${path}:issue-number`);
    else if (gate !== null && !evidence) keys.push(`${path}:gate-not-evidence`);
  }
  return keys;
}

export async function readBaseline(): Promise<Record<string, Counts>> {
  const raw = await Deno.readTextFile(BASELINE).catch(() => null);
  if (raw == null || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

if (import.meta.main) {
  const root = Deno.cwd();

  async function run(cmd: string, args: string[]): Promise<string> {
    const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
    return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  }

  const rel = (p: string) => relative(root, p.replace(/^file:\/\//, "")).replaceAll("\\", "/");

  async function* walkFiles(dir: string): AsyncGenerator<string> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) yield* walkFiles(p);
      else if (e.isFile && e.name.endsWith(".ts")) yield p;
    }
  }

  function tally(keys: string[]): Counts {
    const c: Counts = {};
    for (const k of keys) c[k] = (c[k] ?? 0) + 1;
    return c;
  }

  const checks: Record<string, () => Promise<string[]>> = {
    async lint() {
      // test/ is linted like code (#648). Two rules are test-only noise: tests
      // print to the runner's console (`log.test.ts` asserts on console itself),
      // and test doubles / browser `evaluate` snippets are untyped on purpose,
      // `window as any` inside a Playwright callback has no DOM type, and a
      // `vault as any` double is how a test pokes internals. `--rules-exclude`
      // replaces deno.json's list, so carry that list over from the config.
      const config = parseJsonc(await Deno.readTextFile("deno.json")) as {
        lint?: { rules?: { exclude?: string[] } };
      };
      const testRules = [
        ...(config.lint?.rules?.exclude ?? []),
        "no-console",
        "no-explicit-any",
      ].join(",");
      const lint = async (args: string[]) =>
        JSON.parse(await run(Deno.execPath(), ["lint", "--json", ...args])).diagnostics as Array<{
          filename: string;
          code: string;
        }>;
      const diagnostics = [
        ...await lint(["server/", "core/", "plugin/"]),
        ...await lint([`--rules-exclude=${testRules}`, "test/"]),
      ];
      return diagnostics.map((d) => `${rel(d.filename)}:${d.code}`);
    },
    async testNames() {
      const files: string[] = [];
      for await (const f of walkFiles("test")) files.push(f);
      return testNameViolations(files, await Deno.readTextFile("docs/testing/step-gates.md"));
    },
    async types() {
      const out = await run("node_modules/.bin/tsc", ["-p", "tsconfig.plugin.json"]);
      return [...out.matchAll(/^(\S+)\(\d+,\d+\): error (TS\d+)/gm)].map((m) => `${m[1]}:${m[2]}`);
    },
    async eslint() {
      const out = JSON.parse(
        await run("node_modules/.bin/eslint", ["-f", "json", "server", "core", "plugin"]),
      );
      return out.flatMap((f: { filePath: string; messages: { ruleId: string }[] }) =>
        f.messages.map((m) => `${rel(f.filePath)}:${m.ruleId}`)
      );
    },
    async exports() {
      const out = await run("node_modules/.bin/ts-unused-exports", [
        "tsconfig.lint.json",
        "--allowUnusedTypes",
        "--excludePathsFromReport=test/;scripts/;plugin/_generated;plugin/main.ts",
      ]);
      return [...out.matchAll(/^(\S+\.ts): (.+)$/gm)].flatMap((m) =>
        m[2].split(", ").map((name) => `${rel(m[1])}:${name}`)
      );
    },
    async css() {
      // Broken styles.css passed every gate until #431's rebase left braces
      // unclosed and the whole file silently unstyled.
      const file = "plugin/manifest/styles.css";
      const err = firstCssSyntaxError(await Deno.readTextFile(file));
      if (err) {
        console.error(`CSS syntax error in ${file}:${err.line}: ${err.message}`);
        return [`${file}:css-syntax`];
      }
      return [];
    },
    async testPorts() {
      // Random-number test ports collide between parallel test files (#402).
      const re = /port\b.*Math\.random|Math\.random.*port/i;
      const keys: string[] = [];
      for await (const f of walkFiles("test")) {
        for (const line of (await Deno.readTextFile(f)).split("\n")) {
          if (re.test(line)) keys.push(`${rel(f)}:random-port`);
        }
      }
      return keys;
    },
  };

  const hasBaseline = !!(await Deno.stat(BASELINE).catch(() => null));
  const baseline = await readBaseline();
  const current: Record<string, Counts> = {};
  const failures: string[] = [];

  for (const [name, check] of Object.entries(checks)) {
    current[name] = tally(await check());
    const base = baseline[name] ?? {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(current[name])])) {
      const now = current[name][key] ?? 0;
      const was = base[key] ?? 0;
      if (now > was) failures.push(`${name}: ${key} ${was} → ${now} (new violation)`);
      else if (now < was) {
        failures.push(`${name}: ${key} ${was} → ${now} (fixed: run with --update)`);
      }
    }
  }

  if (Deno.args.includes("--update")) {
    const grew = failures.filter((f) => f.endsWith("(new violation)"));
    if (grew.length) {
      console.error(`Refusing to record violations in the baseline:\n  ${grew.join("\n  ")}`);
      Deno.exit(1);
    }
    if (!hasBaseline) {
      // No baseline to shrink: a missing baseline already means zero allowed
      // violations, so a clean run leaves the file absent.
      console.log("Standards clean; no baseline file to update.");
      Deno.exit(0);
    }
    await Deno.writeTextFile(BASELINE, JSON.stringify(current, null, 2) + "\n");
    console.log(`Baseline updated: ${BASELINE}`);
    Deno.exit(0);
  }

  if (failures.length) {
    console.error(`Standards (#377) vs ${BASELINE}:\n  ${failures.join("\n  ")}`);
    Deno.exit(1);
  }
}
