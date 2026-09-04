import {
  applyPatch,
  createDocument,
  createResolutionSession,
  diffTrees,
  preparePatch,
  validatePatch,
} from "../dist/index.js";
import { getNodeHash } from "../dist/core/hash.js";
import { cloneJsonValue } from "../dist/schema/adapters.js";
import { compileTreeSchema } from "../dist/schema/schema.js";

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

// Derived revisions (and the hash caches behind them) are computed lazily, so
// publish each tree once here; the rows below measure diff/apply, not the
// first full-tree hash.
const publish = (tree) => (tree.revision, tree);
const wideBase = publish(wideTree(100_000, 1));
const wideTarget = publish(wideTree(100_000, 2));
const reorderBase = publish(wideTree(10_000, 1));
const reorderTarget = publish(wideTree(10_000, 1, true));
const thresholdBase = publish(deepTree(5_000, 0));
const thresholdTarget = publish(deepTree(5_000, 1));
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
const largeBagBase = publish(bagTree(0, 4_000));
const largeBagTarget = publish(bagTree(1, 4_000));
const largeBagConflictBase = publish(bagTree(2, 4_000));
const insertionBase = publish(emptyTree());
const insertionTarget = publish(wideTree(8_000, 1));
const deepApplyBase = publish(deepTree(4_000, 0));
const deepApplyTarget = publish(deepTree(4_000, 1));
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
const largeJsonValue = Array.from({ length: 100_000 }, (_, index) => index);
const largeAtomicSchema = {
  types: {
    Bag: {
      atomicPaths: Array.from(
        { length: 10_000 },
        (_, index) => [`key-${index}`],
      ),
    },
  },
};

const rows = [];
let widePatch;
rows.push(measure("diff: 100k siblings, one attr", () => {
  widePatch = diffTrees(wideBase, wideTarget);
  return widePatch.ops.length;
}));
rows.push(measure("apply: sparse attr in 100k tree", () =>
  applyPatch(wideBase, widePatch).status));
rows.push(measure("apply: leaf attr in 100k tree", () =>
  applyPatch(wideBase, {
    format: "tree-patch/v1",
    patchId: "wide-leaf",
    ops: [{
      kind: "setAttr",
      opId: "set-leaf-value",
      nodeId: "leaf-50000",
      path: "/value",
      value: 1,
    }],
  }).status));
rows.push(measure("materialize: sparse attr in 100k tree", () =>
  applyPatch(wideBase, widePatch).materialized.id));
let reorderPatch;
rows.push(measure("diff: reverse 10k siblings", () => {
  reorderPatch = diffTrees(reorderBase, reorderTarget);
  return reorderPatch.ops.length;
}));
rows.push(measure("encode: reverse 10k patch bytes", () =>
  JSON.stringify(reorderPatch).length));
rows.push(measure("apply: reverse 10k siblings", () =>
  applyPatch(reorderBase, reorderPatch).status));
rows.push(measure("diff: 5k chain ratio threshold", () =>
  diffTrees(thresholdBase, thresholdTarget, {
    replaceSubtreeWhen: { subtreeChangeRatioGte: 0.5 },
  }).ops.length));
const resolutionOldBase = publish(bagTree(0));
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
const preparedLargeBagPatch = preparePatch(largeBagPatch);
rows.push(measure("validate: raw 4k-op envelope", () =>
  validatePatch(largeBagConflictBase, largeBagPatch).status));
rows.push(measure("validate: prepared 4k-op envelope", () =>
  validatePatch(largeBagConflictBase, preparedLargeBagPatch).status));
rows.push(measure("apply: 4k fields on one node", () =>
  applyPatch(largeBagBase, largeBagPatch).status));
const insertionPatch = diffTrees(insertionBase, insertionTarget);
rows.push(measure("apply: insert 8k siblings", () =>
  applyPatch(insertionBase, insertionPatch).status));
const deepApplyPatch = diffTrees(deepApplyBase, deepApplyTarget);
rows.push(measure("apply: update 4k-node chain", () =>
  applyPatch(deepApplyBase, deepApplyPatch).status));
rows.push(measure("apply: cold external 100k-value tree", () =>
  applyPatch(largeValueTree, {
    format: "tree-patch/v1",
    patchId: "cold-external",
    ops: [{
      kind: "setAttr",
      opId: "set-marker",
      nodeId: "large-value",
      path: "/marker",
      value: true,
    }],
  }).status));
rows.push(measure("hash: 100k primitive values", () =>
  getNodeHash(largeValueTree, "large-value").length));
rows.push(measure("clone: 100k primitive values", () =>
  cloneJsonValue(largeJsonValue).length));
rows.push(measure("schema: compile 10k atomic paths", () =>
  compileTreeSchema(largeAtomicSchema).types.size));

console.table(rows);
