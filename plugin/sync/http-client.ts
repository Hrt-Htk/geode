import { HeadRecord, VersionRecord } from "../../core/protocol.ts";
import { log } from "../plumbing/log.ts";
import { httpBase } from "../plumbing/scheme.ts";
import { toArrayBuffer } from "../plumbing/bytes.ts";
import { retryBusy } from "../plumbing/retry.ts";

export interface TransportHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}
export interface TransportHttpResponse {
  status: number;
  ok: boolean;
  text(): string | Promise<string>;
  arrayBuffer(): ArrayBuffer | Promise<ArrayBuffer>;
}
export type TransportHttpFn = (req: TransportHttpRequest) => Promise<TransportHttpResponse>;

// Platform HTTP injectable: requestUrl on desktop, fetch on mobile (#133).
let transportHttp: TransportHttpFn = async ({ url, method, headers, body }) => {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? toArrayBuffer(body) : undefined,
  });
  return {
    status: res.status,
    ok: res.ok,
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer(),
  };
};

export function setTransportHttp(fn: TransportHttpFn): void {
  transportHttp = fn;
}

const BLOB_RETRY_MAX = 3;
const BLOB_RETRY_BASE_MS = 100;

export class HttpClient {
  private serverUrl: string;
  private blobBaseUrl: string;
  constructor(
    serverUrl: string,
    private vaultId: string,
    private deviceToken: string,
  ) {
    this.serverUrl = serverUrl;
    this.blobBaseUrl = `${httpBase(serverUrl)}/blobs`;
  }

  async getBlob(hash: string): Promise<Uint8Array> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= BLOB_RETRY_MAX; attempt++) {
      try {
        const res = await transportHttp({
          url: `${this.blobBaseUrl}/${hash}`,
          method: "GET",
          headers: { Authorization: `Bearer ${this.deviceToken}` },
        });
        // 4xx are terminal (auth/not-found: retrying won't help); 5xx and
        // network errors fall through to the retry in the catch below.
        if (!res.ok) throw new Error(`blob GET ${hash}: ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Terminal on any 4xx (auth/not-found); retry only 5xx + network errors.
        if (/: 4\d\d$/.test(lastError.message)) throw lastError;
        if (attempt < BLOB_RETRY_MAX) {
          const delay = BLOB_RETRY_BASE_MS * 2 ** attempt;
          log.debug("blob retry", { hash, attempt, delay });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError!;
  }

  async putBlob(hash: string, body: Uint8Array): Promise<void> {
    // #680: a 503 is the server's busy budget, so retry it before giving up.
    const res = await retryBusy(() =>
      transportHttp({
        url: `${this.blobBaseUrl}/${hash}`,
        method: "POST",
        body,
        headers: {
          Authorization: `Bearer ${this.deviceToken}`,
          "Content-Type": "application/octet-stream",
        },
      })
    );
    if (!res.ok && res.status !== 304) throw new Error(`blob PUT ${hash}: ${res.status}`);
  }

  async headBlob(hash: string): Promise<boolean> {
    const res = await transportHttp({
      url: `${this.blobBaseUrl}/${hash}`,
      method: "HEAD",
      headers: { Authorization: `Bearer ${this.deviceToken}` },
    });
    return res.ok;
  }

  async *getHeads(afterSeq: number): AsyncGenerator<HeadRecord> {
    const res = await transportHttp({
      url: `${httpBase(this.serverUrl)}/vaults/${this.vaultId}/heads?after_seq=${afterSeq}`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.deviceToken}` },
    });
    if (!res.ok) throw new Error(`heads GET: ${res.status}`);
    for (const line of (await res.text()).trim().split("\n")) {
      if (line) yield JSON.parse(line) as HeadRecord;
    }
  }

  // `upTo` omitted = newest page; the server pages a chain at 100 rows.
  async getVersionChain(pathHash: string, upTo?: number): Promise<VersionRecord[]> {
    const qs = upTo === undefined ? "" : `?up_to=${upTo}`;
    const res = await transportHttp({
      url: `${httpBase(this.serverUrl)}/vaults/${this.vaultId}/versions/${pathHash}${qs}`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.deviceToken}` },
    });
    if (!res.ok) throw new Error(`versions GET: ${res.status}`);
    return JSON.parse(await res.text()) as VersionRecord[];
  }
}
