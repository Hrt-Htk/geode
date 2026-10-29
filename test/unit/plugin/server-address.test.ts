import { assertEquals } from "@std/assert";
import {
  reconnectNotice,
  type ServerAddressCheck,
  serverAddressCheckMessage,
  serverAddressError,
  serverCheckStatusToKind,
  validateServerUrl,
} from "../../../plugin/plumbing/server-address.ts";
import {
  checkServerVault,
  type HttpFn,
  setHttpImpl,
} from "../../../plugin/plumbing/provisioning-client.ts";

// The platform http helper is module state shared with other test files, so
// every injection is restored to a fetch-based implementation afterwards.
const fetchHttp: HttpFn = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body });
  return { status: res.status, text: await res.text() };
};

async function withHttp(impl: HttpFn, run: () => Promise<void>): Promise<void> {
  setHttpImpl(impl);
  try {
    await run();
  } finally {
    setHttpImpl(fetchHttp);
  }
}

Deno.test("server-address - validateServerUrl accepts http and https, rejects empty and non-urls", () => {
  assertEquals(validateServerUrl(""), "empty");
  assertEquals(validateServerUrl("   "), "empty");
  assertEquals(validateServerUrl("http://localhost:8099"), "ok");
  assertEquals(validateServerUrl("https://sync.example.org"), "ok");
  assertEquals(validateServerUrl("https://sync.example.org/"), "ok");
  assertEquals(validateServerUrl("localhost:8099"), "not-a-url");
  assertEquals(validateServerUrl("ftp://sync.example.org"), "not-a-url");
  assertEquals(validateServerUrl("not a url"), "not-a-url");
});

Deno.test("server-address - copy strings (plain, no dashes)", () => {
  assertEquals(serverAddressError("empty"), "Enter a server URL.");
  assertEquals(
    serverAddressError("not-a-url"),
    "Enter a full server URL, e.g. https://sync.example.org",
  );
  assertEquals(
    serverAddressCheckMessage("unreachable", "https://sync.example.org"),
    "Couldn't reach https://sync.example.org. Your previous address is kept.",
  );
  assertEquals(
    serverAddressCheckMessage("no-vault", "http://127.0.0.1:8099"),
    "No Geode vault at http://127.0.0.1:8099. Your previous address is kept.",
  );
  assertEquals(
    serverAddressCheckMessage("device-unknown", "https://sync.example.org"),
    "This device is not recognised. Rejoin the vault. Your previous address is kept.",
  );
  assertEquals(
    serverAddressCheckMessage("vault-mismatch", "https://sync.example.org"),
    "This device's token is for a different vault. Your previous address is kept.",
  );
  assertEquals(
    reconnectNotice("https://sync.example.org"),
    "Reconnecting to https://sync.example.org…",
  );
});

Deno.test(
  "server-address - status to check kind: 401 revoked device, 403 other vault, 404 no vault, 5xx unreachable",
  () => {
    assertEquals(serverCheckStatusToKind(200), "ok");
    assertEquals(serverCheckStatusToKind(204), "ok");
    assertEquals(serverCheckStatusToKind(401), "device-unknown");
    assertEquals(serverCheckStatusToKind(403), "vault-mismatch");
    assertEquals(serverCheckStatusToKind(404), "no-vault");
    // Any other 4xx stays the wrong-address answer.
    assertEquals(serverCheckStatusToKind(400), "no-vault");
    assertEquals(serverCheckStatusToKind(500), "unreachable");
    assertEquals(serverCheckStatusToKind(503), "unreachable");
  },
);

Deno.test("server-address - checkServerVault checks an explicit scheme verbatim", async () => {
  await withHttp(
    ({ url }) => {
      assertEquals(url, "http://server.local:8099/vaults/v1/trash");
      return Promise.resolve({ status: 200, text: "" });
    },
    async () => {
      assertEquals(await checkServerVault("http://server.local:8099", "v1", "tok"), "ok");
    },
  );
});

Deno.test("server-address - checkServerVault maps a network failure to unreachable", async () => {
  await withHttp(
    () => {
      throw new Error("connection refused");
    },
    async () => {
      assertEquals(await checkServerVault("127.0.0.1:1", "v1", "tok"), "unreachable");
    },
  );
});

Deno.test("server-address - checkServerVault hits the device-authed trash endpoint and maps statuses", async () => {
  const cases: Array<[number, ServerAddressCheck]> = [
    [200, "ok"],
    [401, "device-unknown"],
    [403, "vault-mismatch"],
    [404, "no-vault"],
    [500, "unreachable"],
  ];
  for (const [status, kind] of cases) {
    await withHttp(
      ({ url, headers }) => {
        assertEquals(url, "http://127.0.0.1:8099/vaults/v1/trash");
        assertEquals(headers.Authorization, "Bearer tok");
        return Promise.resolve({ status, text: "" });
      },
      async () => {
        assertEquals(await checkServerVault("127.0.0.1:8099", "v1", "tok"), kind);
      },
    );
  }
});
