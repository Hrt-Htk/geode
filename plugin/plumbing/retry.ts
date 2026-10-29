// #680 - the server answers 503 `server busy` with `retry-after: 1` when its in-flight
// body budget is full. The budget refills as reads finish, so a retry is the right
// answer; every other non-2xx is terminal (auth, not-found, storage full, conflict).
//
// The budget has to outlast the second the server advertises, or a busy window just
// aborts the re-key one round later. Neither plugin transport exposes response headers
// (`HttpResp` and `TransportHttpResponse` carry status and body only), so `retry-after`
// is not read here; the budget is sized instead. Five attempts at 200 ms doubling backoff
// wait 3 s in total, three times the advertised second, and that is the worst case.
const RETRY_MAX = 5;
const RETRY_BASE_MS = 200;

export async function retryBusy<T extends { status: number }>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1;; attempt++) {
    const res = await send();
    if (res.status !== 503 || attempt >= RETRY_MAX) return res;
    await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
  }
}
