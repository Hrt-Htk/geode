// The per-connection receive queue: buffers frames the connection loop has not
// consumed yet, hands one out per recv(), and closes 1011 when the peer overruns the
// queue caps. Own module so ws.ts stays the relay loop within the <=300 LOC tripwire.
import { MAX_QUEUE_BYTES, MAX_QUEUE_MESSAGES } from "./ws-types.ts";

export interface FrameReceiver {
  recv: () => Promise<string | null>;
  isClosed: () => boolean;
  detach: () => void;
}

export function makeReceiver(ws: WebSocket): FrameReceiver {
  const queue: string[] = [];
  let queueBytes = 0;
  let waiter: ((s: string | null) => void) | null = null;
  let closed = false;

  const onMsg = (e: MessageEvent) => {
    const data = typeof e.data === "string" ? e.data : "";
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(data);
    } else if (queue.length >= MAX_QUEUE_MESSAGES || queueBytes + data.length > MAX_QUEUE_BYTES) {
      // Receive queue overflow: the peer is producing faster than we can
      // apply. Close 1011: client reconnects and replays from last_seen_seq.
      ws.close(1011, "queue overflow");
    } else {
      queue.push(data);
      queueBytes += data.length;
    }
  };
  const onClose = () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  };
  ws.addEventListener("message", onMsg);
  ws.addEventListener("close", onClose);

  return {
    recv: () => {
      if (queue.length > 0) {
        const data = queue.shift()!;
        queueBytes -= data.length;
        return Promise.resolve(data);
      }
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    isClosed: () => closed,
    detach: () => {
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
    },
  };
}
