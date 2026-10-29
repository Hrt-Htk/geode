// #615: the link a rename chain inside one debounce writes: the middle names never
// reach the server, so the marker names the file's final name and the final note links
// past them. Pure bookkeeping around `pendingRenameTarget` and the local rows.

import { assertEquals } from "@std/assert";
import { hashPathHex } from "../../../core/hash.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import {
  type CollapsedChain,
  collapseRenameChain,
  forgetChain,
  isRenameClose,
  isUnwritten,
  linkChainTo,
  noteSource,
  rememberChain,
} from "../../../plugin/sync/rename-chain.ts";
import type { StateDB } from "../../../plugin/plumbing/state.ts";

const KEYS = new Uint8Array(32);

/** A local row for `path`, live and committed unless told otherwise. */
function track(state: StateDB, path: string, opts: { lastSeen?: number; deleted?: boolean } = {}) {
  state.upsertLocalFile({
    path,
    path_hash: hashPathHex(KEYS, path),
    size: 1,
    mtime: 1,
    plaintext_hash: "h",
    last_seen_version: opts.lastSeen ?? 1,
    deleted: opts.deleted,
  });
}

function deps(
  state: StateDB,
  pending: Record<string, string>,
  chains: Map<string, CollapsedChain> = new Map(),
  markers: Record<string, string> = {},
) {
  return {
    state,
    pendingRenameTarget: (path: string) => pending[path],
    markerSource: (path: string) => markers[path],
    collapsedChains: chains,
  };
}

Deno.test("rename-chain - no hop leaves the destination alone", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  track(state, "y.md");
  assertEquals(collapseRenameChain("x.md", "y.md", deps(state, {}, chains)), "y.md");
  assertEquals(chains.size, 0, "nothing was skipped");
});

Deno.test("rename-chain - X -> Y -> Z collapses to X -> Z and remembers Y", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  // Nothing is on the server at y.md: its note never landed.
  assertEquals(
    collapseRenameChain("x.md", "y.md", deps(state, { "y.md": "z.md" }, chains)),
    "z.md",
  );
  assertEquals([...chains], [["y.md", { from: "x.md", to: "z.md" }]]);
  assertEquals(noteSource("z.md", "y.md", chains), "x.md", "the final note links back to X");
  assertEquals(
    noteSource("z.md", "other.md", chains),
    "other.md",
    "an unrelated source is untouched",
  );
  assertEquals(
    noteSource("w.md", "y.md", chains),
    "y.md",
    "the link only applies to its own chain",
  );

  forgetChain(chains, "z.md");
  assertEquals(chains.size, 0, "the chain is done once its final note is settled");
});

Deno.test("rename-chain - a three-hop chain follows every hop", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  const to = collapseRenameChain(
    "x.md",
    "y.md",
    deps(state, { "y.md": "z.md", "z.md": "w.md" }, chains),
  );
  assertEquals(to, "w.md");
  assertEquals(noteSource("w.md", "z.md", chains), "x.md");
  forgetChain(chains, "w.md");
  assertEquals(chains.size, 0);
});

Deno.test("rename-chain - a middle name whose own note landed keeps its per-hop link", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  track(state, "y.md");
  assertEquals(
    collapseRenameChain("x.md", "y.md", deps(state, { "y.md": "z.md" }, chains)),
    "y.md",
  );
  assertEquals(chains.size, 0);
});

Deno.test("rename-chain - a round trip (X -> Y -> X) writes no link at all", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  track(state, "x.md");
  assertEquals(
    collapseRenameChain("x.md", "y.md", deps(state, { "y.md": "x.md" }, chains)),
    "x.md",
    "the file never left this name",
  );
  assertEquals(chains.size, 0);
});

Deno.test("rename-chain - a ping-pong chain lands on the name it comes back to", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  const to = collapseRenameChain(
    "x.md",
    "y.md",
    deps(state, { "y.md": "z.md", "z.md": "y.md" }, chains),
  );
  assertEquals(to, "y.md", "the file ends up on the revisited name");
  assertEquals(chains.get("y.md"), { from: "x.md", to: "y.md" });
  assertEquals(chains.get("z.md"), { from: "x.md", to: "y.md" }, "the hop's own source is linked");
  assertEquals(noteSource("y.md", "z.md", chains), "x.md");
});

Deno.test("rename-chain - a chain that loops back to its start stays a round trip", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  // x -> y -> z -> x: nothing is left behind, so the marker closes x as a tombstone.
  assertEquals(
    collapseRenameChain("x.md", "y.md", deps(state, { "y.md": "z.md", "z.md": "x.md" }, chains)),
    "x.md",
  );
  assertEquals(chains.size, 0);
});

Deno.test("rename-chain - a live chain entry is never overwritten", () => {
  const chains = new Map<string, CollapsedChain>([["y.md", { from: "x.md", to: "z.md" }]]);
  rememberChain(chains, "y.md", "p.md", "q.md");
  assertEquals(
    chains.get("y.md"),
    { from: "x.md", to: "z.md" },
    "the first chain's note still needs it",
  );
});

Deno.test("rename-chain - a note skips the middle names whose own note never landed", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>([["y.md", { from: "x.md", to: "z.md" }]]);
  assertEquals(
    linkChainTo("z.md", "y.md", deps(state, {}, chains)),
    "x.md",
    "read off the chain map",
  );
  // No map entry: the middle's own marker (still queued) names where it came from.
  assertEquals(
    linkChainTo("q.md", "m.md", deps(openStateDB(), {}, new Map(), { "m.md": "p.md" })),
    "p.md",
  );
  // A middle name with a committed row of its own keeps its per-hop link.
  const own = openStateDB();
  track(own, "m.md");
  assertEquals(linkChainTo("q.md", "m.md", deps(own, {}, new Map(), { "m.md": "p.md" })), "m.md");
});

Deno.test("rename-chain - a fresh hop beats a live chain entry for the same middle", () => {
  const state = openStateDB();
  // Chain A (x -> y -> z) collapsed but its note has not settled; now chain B renames the
  // same x -> y again and continues to q. The live queue is what this marker must follow.
  const chains = new Map<string, CollapsedChain>([["y.md", { from: "x.md", to: "z.md" }]]);
  const to = collapseRenameChain("x.md", "y.md", deps(state, { "y.md": "q.md" }, chains));
  assertEquals(to, "q.md", "the fresh hop wins over the remembered end");
  assertEquals(chains.get("y.md"), { from: "x.md", to: "z.md" }, "the live entry is kept");
});

Deno.test("rename-chain - a chain entry for another note never links this one", () => {
  const state = openStateDB();
  // Chain A (x -> y -> z) is still live; a different file now arrives at q through y.
  const chains = new Map<string, CollapsedChain>([["y.md", { from: "x.md", to: "z.md" }]]);
  assertEquals(
    linkChainTo("q.md", "y.md", deps(state, {}, chains, { "y.md": "p.md" })),
    "p.md",
    "the stale entry belongs to another note",
  );
});

Deno.test("rename-chain - a note that comes back to its own name carries no link", () => {
  const state = openStateDB();
  const chains = new Map<string, CollapsedChain>();
  assertEquals(linkChainTo("x.md", "y.md", deps(state, {}, chains, { "y.md": "x.md" })), "y.md");
  assertEquals(noteSource("x.md", "y.md", chains), null, "the round trip writes no note link");
});

Deno.test("rename-chain - the unwritten test covers a carried row", () => {
  const state = openStateDB();
  assertEquals(isUnwritten("missing.md", state), true);
  track(state, "carried.md", { lastSeen: 0 });
  assertEquals(isUnwritten("carried.md", state), true, "a carried row has no version of its own");
  track(state, "live.md");
  assertEquals(isUnwritten("live.md", state), false);
  track(state, "closed.md", { deleted: true });
  assertEquals(isUnwritten("closed.md", state), true);
});

Deno.test("rename-chain - only the rename's own close cancels a chain (#629)", () => {
  const state = openStateDB();
  // The delete a rename's note became carries its source: it is the rename's own close.
  assertEquals(isRenameClose({ kind: "delete", renamedFrom: "x.md" }), true);
  // Another generation's delete of the same name carries nothing: not this rename's.
  assertEquals(isRenameClose({ kind: "delete" }), false);
  // A rename's marker is a close of a *different* name, never of its destination.
  assertEquals(isRenameClose({ kind: "delete", renamedTo: "y.md", renamedFrom: "x.md" }), false);
  // A note (or a plain commit) is not a close either.
  assertEquals(isRenameClose({ kind: "commit", renamedFrom: "x.md" }), false);
  // And the chain only cancels when the delete is that close.
  const chains = new Map<string, CollapsedChain>();
  const ownClose = (path: string, close: boolean) =>
    collapseRenameChain("x.md", path, { ...deps(state, {}, chains), ownClose: () => close });
  assertEquals(ownClose("y.md", false), "y.md", "another delete of the name keeps the link");
  assertEquals(ownClose("y.md", true), null, "the rename's own close cancels it");
});
