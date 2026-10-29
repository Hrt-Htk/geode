import { serverHost } from "../../../plugin/ui/server-host.ts";
import { assertEquals } from "@std/assert";

Deno.test("server-host - host with port", () => {
  assertEquals(serverHost("https://sync.example.org:8080"), "sync.example.org:8080");
});

Deno.test("server-host - bare IP host", () => {
  assertEquals(serverHost("http://192.0.2.10"), "192.0.2.10");
});

Deno.test("server-host - trailing path stripped", () => {
  assertEquals(serverHost("https://example.org/geode"), "example.org");
});

Deno.test("server-host - malformed url falls back to the raw input", () => {
  assertEquals(serverHost("not a url"), "not a url");
});

Deno.test("server-host - schemeless host with port is returned verbatim", () => {
  assertEquals(serverHost("localhost:8099"), "localhost:8099");
  assertEquals(serverHost("server.local:8099"), "server.local:8099");
  assertEquals(serverHost("127.0.0.1:8099"), "127.0.0.1:8099");
});

Deno.test("server-host - empty string", () => {
  assertEquals(serverHost(""), "");
});
