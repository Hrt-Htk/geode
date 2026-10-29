// CSS syntax check (#489): parse with postcss and report the first error's
// line + message. Braces inside comments/strings are handled by the parser.

import postcss from "postcss";

export type CssSyntaxError = { line: number; message: string };

export function firstCssSyntaxError(css: string): CssSyntaxError | null {
  try {
    postcss.parse(css);
    return null;
  } catch (e) {
    const err = e as { line?: number; message: string };
    // postcss prefixes "<css input>:L:C: ": the line is already returned.
    return { line: err.line ?? 0, message: err.message.replace(/^<css input>:\d+:\d+: /, "") };
  }
}
