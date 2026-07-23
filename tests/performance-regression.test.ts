import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
} from "../src/index.js";
import { getPathHash } from "../src/core/hash.js";

type PerfTypes = {
  Root: { version: number };
  Leaf: Record<string, number>;
  Deep: { value: number };
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
