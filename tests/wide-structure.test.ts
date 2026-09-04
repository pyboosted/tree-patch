import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
  patchBuilder,
  type TreeDocument,
} from "../src/index.js";
import { createCopyOnWriteMap } from "../src/core/cow.js";

type WideTypes = {
  Root: { version: number };
  Leaf: { value?: number };
};

function wideDocument(size: number, version: number): TreeDocument<WideTypes> {
  return {
    root: {
      id: "root",
      type: "Root",
      attrs: { version },
      children: Array.from({ length: size }, (_, index) => ({
        id: `leaf-${index}`,
        type: "Leaf",
        attrs: {},
        children: [],
      })),
    },
  };
}

// Regression: diff traversals used `stack.push(...childIds)`, which overflows
// the call stack on V8 for nodes with roughly 120k+ children. Bun's spread
// limit is higher, so this guards the loop form rather than reproducing the
// crash under `bun test`; `node` reproduces it against the old implementation.
test("threshold diff handles a node with 150k children", () => {
  const base = createDocument(wideDocument(150_000, 1));
  const target = createDocument(wideDocument(150_000, 2));
  const patch = diffTrees(base, target, {
    replaceSubtreeWhen: { subtreeChangeRatioGte: 0.5 },
  });
  assert.equal(patch.ops.length, 1);
  assert.equal(patch.ops[0]!.kind, "setAttr");
});

test("derived revision and hash caches are computed lazily", () => {
  const tree = createDocument(wideDocument(4, 1));
  assert.equal(tree.cache.subtreeHashById.size, 0);
  assert.equal(tree.cache.nodeHashById.size, 0);

  const applied = applyPatch(tree, {
    format: "tree-patch/v1",
    patchId: "lazy",
    ops: [{
      kind: "setAttr",
      opId: "set",
      nodeId: "leaf-1",
      path: "/value",
      value: 1,
    }],
  });
  assert.equal(applied.status, "applied");
  // No baseRevision to compare against: the source revision is not derived yet.
  assert.equal(tree.cache.subtreeHashById.size, 0);
  assert.equal(applied.revision.status, "unknown");

  assert.match(tree.revision!, /^tree:h3:/);
  assert.equal(applied.revision.sourceRevision, tree.revision);
  assert.equal(tree.cache.subtreeHashById.size, 5);
  assert.deepEqual(
    JSON.parse(JSON.stringify(applied.revision)),
    { status: "unknown", sourceRevision: tree.revision },
  );

  const matched = applyPatch(tree, {
    format: "tree-patch/v1",
    patchId: "lazy-2",
    baseRevision: tree.revision,
    ops: [],
  });
  assert.equal(matched.status, "applied");
  assert.equal(matched.revision.status, "match");
  assert.equal(matched.revision.sourceRevision, tree.revision);
});

test("patchBuilder resolves the source revision at build time", () => {
  const tree = createDocument(wideDocument(2, 1));
  const builder = patchBuilder({ source: tree, patchId: "from-source" });
  assert.equal(tree.cache.subtreeHashById.size, 0);
  const patch = builder.hideNode("leaf-0").build();
  assert.equal(patch.baseRevision, tree.revision);

  const explicit = patchBuilder({ source: tree, patchId: "explicit", baseRevision: "rev-x" })
    .hideNode("leaf-0")
    .build();
  assert.equal(explicit.baseRevision, "rev-x");

  const cleared = patchBuilder({ source: tree, patchId: "cleared" })
    .baseRevision(undefined)
    .hideNode("leaf-0")
    .build();
  assert.equal(cleared.baseRevision, undefined);
});

test("diff still visits descendants of removed or changed base nodes", () => {
  const base = createDocument({
    root: {
      id: "root",
      type: "Root",
      attrs: { version: 1 },
      children: [
        {
          id: "group",
          type: "Leaf",
          attrs: {},
          children: [
            { id: "moved", type: "Leaf", attrs: { value: 1 }, children: [] },
            { id: "retyped", type: "Leaf", attrs: {}, children: [] },
          ],
        },
        { id: "keep", type: "Leaf", attrs: {}, children: [] },
      ],
    },
  });
  const target = createDocument({
    root: {
      id: "root",
      type: "Root",
      attrs: { version: 1 },
      children: [
        { id: "keep", type: "Leaf", attrs: {}, children: [] },
        { id: "moved", type: "Leaf", attrs: { value: 2 }, children: [] },
        { id: "retyped", type: "Root", attrs: { version: 0 }, children: [] },
      ],
    },
  });
  const patch = diffTrees(base, target);
  const kinds = patch.ops.map((op) => `${op.kind}:${"nodeId" in op ? op.nodeId : ""}`);
  assert.ok(kinds.includes("setAttr:moved"), kinds.join(", "));
  assert.ok(kinds.includes("moveNode:moved"), kinds.join(", "));
  assert.ok(kinds.includes("replaceSubtree:retyped"), kinds.join(", "));
  // Source-backed nodes are hidden rather than removed by diffTrees.
  assert.ok(kinds.includes("hideNode:group"), kinds.join(", "));
  const applied = applyPatch(base, patch, { includeHidden: false });
  assert.equal(applied.status, "applied");
  type Shape = { id: string; type: string; attrs: unknown; children: Shape[] };
  const shape = (node: { id: string; type: string; attrs: unknown; children: readonly unknown[] }): Shape => ({
    id: node.id,
    type: String(node.type),
    attrs: node.attrs,
    children: node.children.map((child) => shape(child as Shape)),
  });
  const expected = applyPatch(target, { format: "tree-patch/v1", patchId: "noop", ops: [] });
  assert.equal(expected.status, "applied");
  assert.deepEqual(shape(applied.materialized), shape(expected.materialized));
});

test("copy-on-write map distinguishes stored undefined from absence", () => {
  const map = createCopyOnWriteMap<string, number | undefined>(new Map([["a", 1]]));
  map.set("a", undefined);
  assert.equal(map.get("a"), undefined);
  assert.equal(map.has("a"), true);
  map.delete("a");
  assert.equal(map.has("a"), false);
  map.set("b", 2);
  assert.equal(map.get("b"), 2);
});
