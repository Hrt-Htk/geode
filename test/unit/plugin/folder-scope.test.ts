import { assertEquals } from "@std/assert";
import {
  buildFolderTree,
  type FolderNode,
  folderSummary,
  nodeSync,
  turnOff,
  turnOn,
} from "../../../plugin/ui/folder-scope.ts";

const TREE_PATHS = [
  "Attachments/scan.pdf",
  "Projects/Geode/plan.md",
  "Projects/Old/notes.md",
  "Projects/top.md",
  "Scratch/draft.md",
  "root.md",
];

function tree(): FolderNode[] {
  return buildFolderTree(TREE_PATHS);
}

function findOpt(nodes: FolderNode[], path: string): FolderNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = findOpt(n.folders, path);
    if (hit) return hit;
  }
  return null;
}

function find(nodes: FolderNode[], path: string): FolderNode {
  const hit = findOpt(nodes, path);
  if (!hit) throw new Error(`no node ${path}`);
  return hit;
}

Deno.test("folder-scope - buildFolderTree derives nested folders, ignores root files", () => {
  const t = tree();
  assertEquals(t.map((n) => n.path), ["Attachments", "Projects", "Scratch"]);
  const projects = find(t, "Projects");
  assertEquals(projects.folders.map((n) => n.path), ["Projects/Geode", "Projects/Old"]);
  assertEquals(projects.folders[0].name, "Geode");
});

Deno.test("folder-scope - buildFolderTree ignores the vault root entry (mobile lists the root)", () => {
  const t = buildFolderTree(["/", "a/note.md"]);
  assertEquals(t.map((n) => n.path), ["a"]);
});

Deno.test("folder-scope - nodeSync: on by default, off when excluded", () => {
  const t = tree();
  assertEquals(nodeSync([], [], find(t, "Projects")), "on");
  assertEquals(nodeSync(["Projects/"], [], find(t, "Projects")), "off");
  assertEquals(nodeSync(["Projects/"], [], find(t, "Projects/Geode")), "off");
  assertEquals(nodeSync(["Projects/"], [], find(t, "Scratch")), "on");
});

Deno.test("folder-scope - included exception: child on inside off parent makes ancestors partial", () => {
  const t = tree();
  const { excluded, included } = turnOn(["Projects/"], [], "Projects/Geode");
  assertEquals(excluded, ["Projects/"]);
  assertEquals(included, ["Projects/Geode/"]);
  assertEquals(nodeSync(excluded, included, find(t, "Projects")), "partial");
  assertEquals(nodeSync(excluded, included, find(t, "Projects/Geode")), "on");
  assertEquals(nodeSync(excluded, included, find(t, "Projects/Old")), "off");
});

Deno.test("folder-scope - siblings stay off after turning a child on", () => {
  const t = tree();
  const { excluded, included } = turnOn(["Projects/", "Scratch/"], [], "Projects/Geode");
  assertEquals(excluded.includes("Scratch/"), true, "unrelated exclusion untouched");
  assertEquals(included, ["Projects/Geode/"]);
  assertEquals(nodeSync(excluded, included, find(t, "Projects/Old")), "off");
});

Deno.test("folder-scope - turnOff a parent drops deeper entries (subsumed)", () => {
  const t = tree();
  const on = turnOn(["Projects/"], [], "Projects/Geode");
  const off = turnOff(on.excluded, on.included, "Projects");
  assertEquals(off.excluded, ["Projects/"]);
  assertEquals(off.included, []);
  assertEquals(nodeSync(off.excluded, off.included, find(t, "Projects/Geode")), "off");
});

Deno.test("folder-scope - turnOn already-on folder is a no-op", () => {
  const on = turnOn([], [], "Projects");
  assertEquals(on.excluded, []);
  assertEquals(on.included, []);
});

Deno.test("folder-scope - turnOn a parent clears the inclusion of a child", () => {
  const on = turnOn(["Projects/"], [], "Projects/Geode");
  const all = turnOn(on.excluded, on.included, "Projects");
  assertEquals(all.excluded, []);
  assertEquals(all.included, []);
  const t = tree();
  assertEquals(nodeSync(all.excluded, all.included, find(t, "Projects")), "on");
});

Deno.test("folder-scope - folderSummary lists off folders and partials with their on children", () => {
  const t = tree();
  assertEquals(folderSummary([], [], t), { off: [], partials: [] });
  const { excluded, included } = turnOn(["Projects/", "Scratch/"], [], "Projects/Geode");
  const { off, partials } = folderSummary(excluded, included, t);
  assertEquals(off, ["Scratch/"]);
  assertEquals(partials, [{ path: "Projects/", on: ["Geode/"] }]);
});

Deno.test("folder-scope - the rejoin backup folder is not a switchable folder", () => {
  // #701: it never syncs, so the Manage tree must not offer it.
  const t = buildFolderTree([
    "notes/a.md",
    "Geode backup/2026.10.29 11.00.00/offline.md",
    "Geode backup/2026.10.29 11.00.00/notes/b.md",
  ]);
  assertEquals(t.map((n) => n.path), ["notes"]);
});
