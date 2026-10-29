// A WebSocket stand-in for the VaultHub tests: records what the hub sends and lets a
// test deliver a message or a close event.
type MessageListener = (e: { data: string }) => void;

export interface FakeSocket {
  ws: WebSocket;
  sent: string[];
  receive: (data: string) => void;
  triggerClose: () => void;
}

export function makeFakeSocket(): FakeSocket {
  const sent: string[] = [];
  let msgListener: MessageListener | null = null;
  let closeListener: (() => void) | null = null;
  const ws = {
    send: (data: string) => sent.push(data),
    close: () => {},
    bufferedAmount: 0,
    addEventListener: (evt: string, fn: unknown) => {
      if (evt === "message") msgListener = fn as MessageListener;
      if (evt === "close") closeListener = fn as () => void;
    },
    removeEventListener: () => {},
  } as unknown as WebSocket;
  return {
    ws,
    sent,
    receive: (data: string) => msgListener?.({ data }),
    triggerClose: () => closeListener?.(),
  };
}
