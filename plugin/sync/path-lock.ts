import type { StateDB } from "../plumbing/state.ts";

const locks = new WeakMap<StateDB, Map<string, Promise<void>>>();

/** How long a writer waits for a path another writer holds. A commit over a closed
 * socket stays pending until reconnect (the channel requeues it), so an unbounded wait
 * would let one path stall the version queue behind it (#630 review). */
const PATH_LOCK_TIMEOUT_MS = 5_000;

/**
 * One writer per path at a time. A conflict resolution writes the same file a commit
 * pushes; interleaved, the commit's ack records its hash with the other write's mtime,
 * and the reconciler's mtime fast path never re-reads the pair (#630).
 *
 * Resolves a release function once this writer owns `path`, or `null` when the current
 * holder still has it after `timeoutMs`: the caller must then defer to a later pass,
 * never drop the work silently.
 */
export async function acquirePathLock(
  state: StateDB,
  path: string,
  timeoutMs = PATH_LOCK_TIMEOUT_MS,
): Promise<(() => void) | null> {
  let queue = locks.get(state);
  if (!queue) locks.set(state, queue = new Map<string, Promise<void>>());
  const prior = queue.get(path) ?? Promise.resolve();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const turn = prior.then(() => held);
  queue.set(path, turn);

  const won = await Promise.race([
    prior.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
  if (!won) {
    // Withdraw, but leave `turn` in the queue: a later writer must still wait for the
    // holder that timed us out.
    release();
    return null;
  }
  return () => {
    release();
    if (queue.get(path) === turn) queue.delete(path);
  };
}
