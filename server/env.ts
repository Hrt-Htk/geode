/** Read a boolean env knob: true only for the exact value "1". */
export function envFlag(key: string): boolean {
  try {
    return Deno.env.get(key) === "1";
  } catch {
    return false; // --allow-env not granted
  }
}

/** Read an integer env knob: undefined when unset, unparseable, or not permitted. */
export function envNum(key: string): number | undefined {
  try {
    const raw = Deno.env.get(key);
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined; // --allow-env not granted
  }
}
