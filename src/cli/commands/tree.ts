import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeStderr,
  writeStdout,
} from "@myceliumhq/toolkit";
import type { TriliumClient } from "../../client.js";
import { resolveClientHandle } from "../config.js";
import { unwrapCli } from "../etapi.js";

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 6;
// Bounds total node fetches on a wide/deep subtree -- a runaway "print my
// whole vault" invocation stops here with a note in the output rather than
// making an unbounded number of ETAPI calls.
const MAX_NODES = 500;

type Node = { noteId: string; title: string; childNoteIds: string[] };

async function fetchNodeOrThrow(client: TriliumClient, noteId: string): Promise<Node> {
  const note = await unwrapCli(client.GET("/notes/{noteId}", { params: { path: { noteId } } }));
  return {
    noteId: note.noteId ?? noteId,
    title: note.title ?? "",
    childNoteIds: note.childNoteIds ?? [],
  };
}

// Descendant lookups swallow errors (a note deleted mid-tree-walk just
// prints as "(unavailable)") -- only fetchNodeOrThrow (used for the root)
// must surface a failure as a real exit 3/4, not print an unavailable leaf
// and exit 0.
async function fetchNode(client: TriliumClient, noteId: string): Promise<Node | undefined> {
  try {
    return await fetchNodeOrThrow(client, noteId);
  } catch {
    return undefined;
  }
}

type OkNode = { kind: "ok"; noteId: string; title: string; children: TreeNode[] };
type TreeNode = OkNode | { kind: "unavailable"; id: string };

type Budget = { visited: number; truncated: boolean };
type Pending = { parent: OkNode; id: string };

// Builds the whole (bounded) subtree one depth level at a time, fetching
// every node at a level -- across every branch, not just one parent's
// direct children -- in a single concurrent batch. This both bounds the
// number of round trips to one per depth level (rather than one per
// branch) and guarantees every node the batch already paid to fetch ends
// up in the returned tree: nothing gets silently dropped once truncation
// kicks in, unlike a print-as-you-go walk that stops on a shared flag
// mid-batch.
async function buildTree(
  client: TriliumClient,
  rootId: string,
  depth: number,
  budget: Budget,
): Promise<TreeNode> {
  const root = await fetchNodeOrThrow(client, rootId);
  budget.visited = 1;
  const rootNode: OkNode = { kind: "ok", noteId: root.noteId, title: root.title, children: [] };

  let frontier: Pending[] = root.childNoteIds.map((id) => ({ parent: rootNode, id }));

  for (let level = 1; level <= depth && frontier.length > 0 && !budget.truncated; level++) {
    const remaining = MAX_NODES - budget.visited;
    if (remaining <= 0) {
      budget.truncated = true;
      break;
    }
    const toFetch = frontier.slice(0, remaining);
    if (toFetch.length < frontier.length) budget.truncated = true;

    const fetched = await Promise.all(toFetch.map((p) => fetchNode(client, p.id)));
    budget.visited += fetched.length;

    const nextFrontier: Pending[] = [];
    toFetch.forEach(({ parent, id }, i) => {
      const node = fetched[i];
      if (!node) {
        parent.children.push({ kind: "unavailable", id });
        return;
      }
      const child: OkNode = { kind: "ok", noteId: node.noteId, title: node.title, children: [] };
      parent.children.push(child);
      for (const childId of node.childNoteIds) {
        nextFrontier.push({ parent: child, id: childId });
      }
    });
    frontier = nextFrontier;
  }

  return rootNode;
}

function printTree(node: TreeNode, indent: string): void {
  if (node.kind === "unavailable") {
    writeStdout(`${indent}${node.id} (unavailable)`);
    return;
  }
  writeStdout(`${indent}${node.title} [${node.noteId}]`);
  for (const child of node.children) {
    printTree(child, `${indent}  `);
  }
}

export function registerTree(program: Command): void {
  addSubcommand(program, "tree <noteId>")
    .summary("Indented subtree outline with ids.")
    .description(
      "Indented outline of a note's subtree, ids inline for follow-up commands. " +
        `Depth defaults to ${DEFAULT_DEPTH}, capped at ${MAX_DEPTH}.`,
    )
    .option("--depth <n>", `Subtree depth to descend, 1-${MAX_DEPTH}.`, String(DEFAULT_DEPTH))
    .addHelpText("after", "\nExample: tri tree root --depth 3")
    .action(async (rootId: string, options: { depth: string }) => {
      const depth = parseBoundedInt(options.depth, { min: 1, max: MAX_DEPTH, flag: "--depth" });

      const { client } = resolveClientHandle();
      const budget: Budget = { visited: 0, truncated: false };
      const tree = await buildTree(client, rootId, depth, budget);
      printTree(tree, "");

      if (budget.truncated) {
        writeStderr(
          `truncated at ${MAX_NODES} nodes -- narrow with a deeper starting noteId or lower --depth`,
        );
      }
    });
}
