// #615: a rename chain made inside one debounce (X → Y → Z): the file is renamed again
// before Y's note can land, so nothing is ever written at Y. The chain collapses into
// one link: the marker names the file's final name, the final note links past Y, or
// the history walk dead-ends there. A middle name whose own note did land keeps its
// per-hop link.
// #629: a chain whose final name is deleted before it opens (X → Y, then delete Y)
// has no note to link to and no name to close: the rename is cancelled and the file is
// one plain delete of the name it started from.

import type { StateDB } from "../plumbing/state.ts";
import { log } from "../plumbing/log.ts";

/** A middle name a collapsed chain skipped over, and the link it wrote instead. */
export interface CollapsedChain {
  /** the name the chain started from */
  from: string;
  /** the file's final name */
  to: string;
}

type RenameChainDeps = {
  state: StateDB;
  /** A rename-away of this path this device is closing (queued, or still in the event
   * debounce). */
  pendingRenameTarget: (path: string) => string | undefined;
  /** The name a queued rename marker for this path came from. */
  markerSource?: (path: string) => string | undefined;
  /** Middle names of the chains collapsed so far; owned by the commit queue. */
  collapsedChains?: Map<string, CollapsedChain>;
  /** #629: a plain delete of this path superseded the note a rename wrote here, so it
   * is that rename closing its own new name (an older generation's delete is not one). */
  ownClose?: (path: string) => boolean;
};

/** Names per chain. A longer chain of renames is a loop, not a file. */
const MAX_CHAIN_HOPS = 8;

/** The name holds nothing on the server for this file yet, so a link pointing at it
 * dead-ends, and a marker there would close a generation that is not this file's. A
 * carried row (`last_seen_version` 0) has no version of its own yet either. */
export function isUnwritten(path: string, state: StateDB): boolean {
  const row = state.getLocalFile(path);
  return !row || row.deleted || row.last_seen_version === 0;
}

/** #629: the queued delete is a rename closing its own new name only when it superseded
 * that rename's note: it then carries the note's source. Another generation's delete of
 * the same name carries none, and a rename's marker is never a close. */
export function isRenameClose(op: {
  kind: string;
  renamedTo?: string;
  renamedFrom?: string;
}): boolean {
  return op.kind === "delete" && op.renamedTo === undefined && op.renamedFrom !== undefined;
}

/** Remember a hop of a chain that never wrote a row at `middle`. A live entry wins: its
 * chain's own note is still on its way and needs the link it was recorded for. */
export function rememberChain(
  chains: Map<string, CollapsedChain> | undefined,
  middle: string,
  from: string,
  to: string,
): void {
  if (chains && !chains.has(middle)) chains.set(middle, { from, to });
}

/** The name the file ends up at, or null when it never gets there: the chain's final
 * name was deleted before it opened, so there is no note to link from and no name to
 * close: the file is one delete of the name the chain started from. The middle names
 * are remembered so the final note can link past them; the caller writes that link
 * with the returned name. */
export function collapseRenameChain(
  from: string,
  renamedTo: string,
  deps: RenameChainDeps,
): string | null {
  let to = renamedTo;
  const skipped: string[] = [];
  const seen = new Set([renamedTo]);
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    // A hop still queued is what the file did; a remembered collapse only stands in for
    // one that is gone (a requeued marker's retry).
    const known = deps.collapsedChains?.get(to);
    const next = deps.pendingRenameTarget(to) ??
      (known?.from === from ? known.to : undefined);
    if (next === undefined || !isUnwritten(to, deps.state)) break;
    // Renamed away and back to the name this marker closes: the file never left it.
    if (next === from) return from;
    skipped.push(to);
    if (seen.has(next)) {
      // Ping-pong: the chain comes back to a name it already passed through, so that is
      // where the file ends up.
      to = next;
      break;
    }
    seen.add(next);
    to = next;
  }
  // #629: the rename's own close deleted the name the file ends up at before it opened,
  // so its marker would point into an empty name and strand the history behind it.
  if (isUnwritten(to, deps.state) && deps.ownClose?.(to) === true) {
    forgetChain(deps.collapsedChains, to);
    log.info("cancelled a rename deleted before it opened", { from, to });
    return null;
  }
  if (skipped.length === 0) return renamedTo;
  for (const middle of skipped) rememberChain(deps.collapsedChains, middle, from, to);
  log.info("collapsed a rename chain", { from, skipped, to });
  return to;
}

/** The name a note links to: past the middle names a collapsed chain skipped over. A
 * round trip (X → Y → X) names its own path, which means "no link". */
export function noteSource(
  path: string,
  renamedFrom: string,
  chains: Map<string, CollapsedChain> | undefined,
): string | null {
  const chain = chains?.get(renamedFrom);
  if (chain?.to !== path) return renamedFrom;
  return chain.from === path ? null : chain.from;
}

/** A note's source, resolved backwards through the middle names whose note never landed:
 * each is read off the chain map or off its own queued marker. */
export function linkChainTo(
  notePath: string,
  renamedFrom: string,
  deps: RenameChainDeps,
): string {
  let start = renamedFrom;
  const middles: string[] = [];
  const seen = new Set([renamedFrom]);
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    // A remembered middle only belongs to this note when it ended on the note's name.
    const chain = deps.collapsedChains?.get(start);
    const from = (chain?.to === notePath ? chain.from : undefined) ?? deps.markerSource?.(start);
    if (from === undefined || seen.has(from) || !isUnwritten(start, deps.state)) break;
    middles.push(start);
    seen.add(from);
    start = from;
  }
  if (middles.length === 0) return renamedFrom;
  // A round trip lands back on the note's own name: it carries no link at all.
  const roundTrip = start === notePath;
  for (const middle of middles) {
    rememberChain(deps.collapsedChains, middle, roundTrip ? notePath : start, notePath);
  }
  log.info("linked a note past a rename chain", { from: start, skipped: middles, to: notePath });
  return roundTrip ? renamedFrom : start;
}

/** The chain's final note is settled: nothing links through its middle names any more. */
export function forgetChain(chains: Map<string, CollapsedChain> | undefined, path: string): void {
  for (const [middle, chain] of chains ?? []) {
    if (chain.to === path) chains?.delete(middle);
  }
}
