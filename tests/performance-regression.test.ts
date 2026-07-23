import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  createEditor,
  createResolutionSession,
  diffTrees,
} from "../src/index.js";
import { getPathHash } from "../src/core/hash.js";

type PerfTypes = {
  Root: { version: number };
  Leaf: Record<string, number>;
  Deep: { value: number };
  Bag: Record<string, number>;
};

function createWideTree(size: number, version: number, reverse = false) {
  const ids = Array.from({ length: size }, (_, index) => `leaf-${index}`);
  if (reverse) {
    ids.reverse();
  }
  return createDocument<PerfTypes>({
    root: {
      id: "root",
      type: "Root",
      attrs: { version },
      children: ids.map((id) => ({
        id,
        type: "Leaf",
        attrs: {},
        children: [],
      })),
    },
  });
}

function createChangedChain(size: number, delta: number) {
  const root = {
    id: "deep-0",
    type: "Deep" as const,
    attrs: { value: delta },
    children: [] as unknown[],
  };
  let current = root;
  for (let index = 1; index < size; index += 1) {
    const child = {
      id: `deep-${index}`,
      type: "Deep" as const,
      attrs: { value: index + delta },
      children: [] as unknown[],
    };
    current.children.push(child);
    current = child;
  }
  return createDocument<PerfTypes>({ root } as never);
}

test("wide attribute-only diffs do not scan sibling arrays per node", () => {
  const base = createWideTree(10_000, 1);
  const target = createWideTree(10_000, 2);
  const patch = diffTrees(base, target);

  assert.equal(patch.ops.length, 1);
  assert.equal(patch.ops[0]?.kind, "setAttr");
});

test("large reverse reorders diff and apply through linked sibling planning", () => {
  const base = createWideTree(5_000, 1);
  const target = createWideTree(5_000, 1, true);
  const patch = diffTrees(base, target);
  const result = applyPatch(base, patch);

  assert.equal(result.status, "applied");
  assert.equal(result.materialized.children[0]?.id, "leaf-4999");
  assert.equal(result.materialized.children.at(-1)?.id, "leaf-0");
});

test("subtree ratio thresholds reuse one bottom-up statistics pass", () => {
  const base = createChangedChain(2_000, 0);
  const target = createChangedChain(2_000, 1);
  const patch = diffTrees(base, target, {
    replaceSubtreeWhen: {
      subtreeChangeRatioGte: 0.5,
    },
  });
  const result = applyPatch(base, patch);

  assert.equal(patch.ops[0]?.kind, "replaceSubtree");
  assert.equal(result.status, "applied");
  assert.equal(result.tree.nodes.get("deep-1999")?.attrs.value, 2_000);
});

test("path hash cache hits grow one mutable inner map instead of cloning it", () => {
  const attrs = Object.fromEntries(
    Array.from({ length: 3_000 }, (_, index) => [`key-${index}`, index]),
  );
  const tree = createDocument<PerfTypes>({
    root: {
      id: "root",
      type: "Leaf",
      attrs,
      children: [],
    },
  });

  for (let index = 0; index < 3_000; index += 1) {
    getPathHash(tree, "root", `/key-${index}`);
  }
  assert.equal(tree.cache.pathHashByNodeId.get("root")?.size, 3_000);
});

test("batched resolution decisions defer replay until state is observed", () => {
  const makeBagTree = (offset: number) =>
    createDocument<PerfTypes>({
      root: {
        id: "root",
        type: "Bag",
        attrs: Object.fromEntries(
          Array.from({ length: 1_000 }, (_, index) => [
            `key-${index}`,
            index + offset,
          ]),
        ),
        children: [],
      },
    });
  const oldBase = makeBagTree(0);
  const patch = diffTrees(oldBase, makeBagTree(1));
  const session = createResolutionSession(oldBase, makeBagTree(2), patch);

  assert.equal(session.conflicts.length, 1_000);
  for (const conflict of session.conflicts) {
    session.takeBase(conflict.opId);
  }
  const result = session.build();
  assert.equal(result.status, "resolved");
  assert.equal(result.appliedOpIds.length, 0);
});

test("field-heavy patches copy an attribute container once per execution session", () => {
  const makeBagTree = (offset: number) =>
    createDocument<PerfTypes>({
      root: {
        id: "root",
        type: "Bag",
        attrs: Object.fromEntries(
          Array.from({ length: 2_000 }, (_, index) => [
            `key-${index}`,
            index + offset,
          ]),
        ),
        children: [],
      },
    });
  const base = makeBagTree(0);
  const patch = diffTrees(base, makeBagTree(1));
  const result = applyPatch(base, patch);

  assert.equal(patch.ops.length, 2_000);
  assert.equal(result.status, "applied");
  assert.equal(result.tree.nodes.get("root")?.attrs["key-1999"], 2_000);
  assert.equal(base.nodes.get("root")?.attrs["key-1999"], 1_999);
});

test("repeated deep edits stop invalidation at an already-dirty ancestor", () => {
  const size = 2_000;
  const base = createChangedChain(size, 0);
  const patch = diffTrees(base, createChangedChain(size, 1));
  const result = applyPatch(base, patch);

  assert.equal(patch.ops.length, size);
  assert.equal(result.status, "applied");
  assert.equal(result.tree.nodes.get(`deep-${size - 1}`)?.attrs.value, size);
});

test("sibling insertions and removals share one linked order per parent", () => {
  const empty = createWideTree(0, 1);
  const populated = createWideTree(2_000, 1);
  const inserted = applyPatch(empty, diffTrees(empty, populated));
  assert.equal(inserted.status, "applied");
  assert.equal(inserted.tree.nodes.get("root")?.childIds.length, 2_000);

  const removalPatch = diffTrees(inserted.tree, empty);
  const removed = applyPatch(inserted.tree, removalPatch);
  assert.equal(removalPatch.ops.length, 2_000);
  assert.equal(removed.status, "applied");
  assert.deepEqual(removed.tree.nodes.get("root")?.childIds, []);
});

test("editor move sequences retain sibling planning state until build", () => {
  const size = 2_000;
  const source = createWideTree(size, 1);
  const editor = createEditor(source, { patchId: "editor-reverse" });
  for (let index = 0; index < size; index += 1) {
    editor.node(`leaf-${index}`, "Leaf").move("root", { atStart: true });
  }

  const patch = editor.build();
  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  assert.equal(result.tree.nodes.get("root")?.childIds[0], `leaf-${size - 1}`);
  assert.equal(result.tree.nodes.get("root")?.childIds.at(-1), "leaf-0");
});
