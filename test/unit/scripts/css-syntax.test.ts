// Unit tests for the CSS syntax check (#489): broken styles.css must fail
// `deno task standards`; braces inside comments/strings must not.

import { assertEquals } from "@std/assert";
import { firstCssSyntaxError } from "../../../scripts/css-syntax.ts";

Deno.test("valid CSS parses clean", () => {
  assertEquals(firstCssSyntaxError(".a { color: red; }"), null);
});

Deno.test("missing closing brace fails with the error line", () => {
  const err = firstCssSyntaxError(".a {\n  color: red;\n");
  assertEquals(err, { line: 1, message: "Unclosed block" });
});

Deno.test("unterminated comment fails", () => {
  const err = firstCssSyntaxError("/* oops\n.a { color: red; }");
  assertEquals(err, { line: 1, message: "Unclosed comment" });
});

Deno.test("braces inside a comment do not fail", () => {
  assertEquals(firstCssSyntaxError("/* { } } */\n.a { color: red; }"), null);
});

Deno.test("braces inside a string do not fail", () => {
  assertEquals(firstCssSyntaxError('.a { content: "} {"; }'), null);
});
