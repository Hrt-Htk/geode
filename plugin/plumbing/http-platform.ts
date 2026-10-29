import { Platform, requestUrl } from "obsidian";
import { toArrayBuffer } from "./bytes.ts";
import { setHttpImpl } from "./provisioning-client.ts";
import { setTransportHttp } from "../sync/http-client.ts";

// #133: requestUrl on desktop, fetch on mobile (fetch is CORS-blocked in the
// Electron renderer; requestUrl's binary POST is broken on Android). The two
// injectables keep separate contracts: provisioning is string-bodied JSON with
// eager text, transport is binary blobs with lazy text/arrayBuffer access.
export function wirePlatformHttp(): void {
  setHttpImpl(async ({ url, method, headers, body }) => {
    const payload = body instanceof Uint8Array ? toArrayBuffer(body) : body;
    if (Platform.isMobile) {
      const res = await fetch(url, { method, headers, body: payload });
      return { status: res.status, text: await res.text() };
    }
    const res = await requestUrl({ url, method, headers, body: payload, throw: false });
    return { status: res.status, text: res.text };
  });

  setTransportHttp(async ({ url, method, headers, body }) => {
    const bodyBuffer = body ? toArrayBuffer(body) : undefined;
    if (Platform.isMobile) {
      const res = await fetch(url, { method, headers, body: bodyBuffer });
      return {
        status: res.status,
        ok: res.ok,
        text: () => res.text(),
        arrayBuffer: () => res.arrayBuffer(),
      };
    }
    const res = await requestUrl({
      url,
      method,
      headers,
      body: bodyBuffer,
      throw: false,
    });
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      text: () => res.text,
      arrayBuffer: () => res.arrayBuffer,
    };
  });
}
