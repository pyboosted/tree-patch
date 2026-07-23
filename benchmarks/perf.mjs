import {
  applyPatch,
  createDocument,
  createResolutionSession,
  diffTrees,
} from "../dist/index.js";
import { getNodeHash } from "../dist/core/hash.js";

function measure(name, run) {
  const started = performance.now();
  const result = run();
  return {
    benchmark: name,
    milliseconds: Number((performance.now() - started).toFixed(1)),
    result,
  };
}

function wideTree(size, version, reverse = false) {
  const ids = Array.from({ length: size }, (_, index) => `leaf-${index}`);
  if (reverse) {
    ids.reverse();
  }
  return createDocument({
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

function deepTree(size, delta) {
  const root = {
    id: "deep-0",
    type: "Deep",
    attrs: { value: delta },
    children: [],
  };
  let current = root;
  for (let index = 1; index < size; index += 1) {
    const child = {
      id: `deep-${index}`,
      type: "Deep",
      attrs: { value: index + delta },
      children: [],
    };
    current.children.push(child);
    current = child;
  }
  return createDocument({ root });
}

function emptyTree() {
  return createDocument({
    root: {
      id: "root",
      type: "Root",
      attrs: { version: 1 },
      children: [],
    },
  });
}

const wideBase = wideTree(100_000, 1);
const wideTarget = wideTree(100_000, 2);
const reorderBase = wideTree(10_000, 1);
const reorderTarget = wideTree(10_000, 1, true);
const thresholdBase = deepTree(5_000, 0);
const thresholdTarget = deepTree(5_000, 1);
const bagTree = (offset, size = 1_000) => createDocument({
  root: {
    id: "bag",
    type: "Bag",
    attrs: Object.fromEntries(
      Array.from({ length: size }, (_, index) => [
        `key-${index}`,
        index + offset,
      ]),
    ),
    children: [],
  },
});
const largeBagBase = bagTree(0, 4_000);
const largeBagTarget = bagTree(1, 4_000);
const insertionBase = emptyTree();
const insertionTarget = wideTree(8_000, 1);
const deepApplyBase = deepTree(4_000, 0);
const deepApplyTarget = deepTree(4_000, 1);
const largeValueTree = createDocument({
  revision: "external",
  root: {
    id: "large-value",
    type: "Bag",
    attrs: {
      values: Array.from({ length: 100_000 }, (_, index) => index),
    },
    children: [],
  },
});

const rows = [];
let widePatch;
rows.push(measure("diff: 100k siblings, one attr", () => {
  widePatch = diffTrees(wideBase, wideTarget);
  return widePatch.ops.length;
}));
rows.push(measure("apply: sparse attr in 100k tree", () =>
  applyPatch(wideBase, widePatch).status));
const reorderPatch = diffTrees(reorderBase, reorderTarget);
rows.push(measure("apply: reverse 10k siblings", () =>
  applyPatch(reorderBase, reorderPatch).status));
rows.push(measure("diff: 5k chain ratio threshold", () =>
  diffTrees(thresholdBase, thresholdTarget, {
    replaceSubtreeWhen: { subtreeChangeRatioGte: 0.5 },
  }).ops.length));
const resolutionOldBase = bagTree(0);
const resolutionPatch = diffTrees(resolutionOldBase, bagTree(1));
const resolution = createResolutionSession(
  resolutionOldBase,
  bagTree(2),
  resolutionPatch,
);
rows.push(measure("resolution: take base for 1k ops", () => {
  for (const conflict of resolution.conflicts) {
    resolution.takeBase(conflict.opId);
  }
  return resolution.build().status;
}));
const largeBagPatch = diffTrees(largeBagBase, largeBagTarget);
rows.push(measure("apply: 4k fields on one node", () =>
  applyPatch(largeBagBase, largeBagPatch).status));
const insertionPatch = diffTrees(insertionBase, insertionTarget);
rows.push(measure("apply: insert 8k siblings", () =>
  applyPatch(insertionBase, insertionPatch).status));
const deepApplyPatch = diffTrees(deepApplyBase, deepApplyTarget);
rows.push(measure("apply: update 4k-node chain", () =>
  applyPatch(deepApplyBase, deepApplyPatch).status));
rows.push(measure("hash: 100k primitive values", () =>
  getNodeHash(largeValueTree, "large-value").length));

console.table(rows);
