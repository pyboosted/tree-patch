import {
  applyPatch,
  createDocument,
  createResolutionSession,
  diffTrees,
} from "../dist/index.js";

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

const wideBase = wideTree(100_000, 1);
const wideTarget = wideTree(100_000, 2);
const reorderBase = wideTree(10_000, 1);
const reorderTarget = wideTree(10_000, 1, true);
const thresholdBase = deepTree(5_000, 0);
const thresholdTarget = deepTree(5_000, 1);
const bagTree = (offset) => createDocument({
  root: {
    id: "bag",
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

const rows = [];
rows.push(measure("diff: 100k siblings, one attr", () =>
  diffTrees(wideBase, wideTarget).ops.length));
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

console.table(rows);
