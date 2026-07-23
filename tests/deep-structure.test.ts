import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
} from "../src/index.js";

type DeepTypes = {
  Deep: { value: number };
};

function createDeepTree(depth: number, leafValue: number) {
  const root = {
    id: "node-0",
    type: "Deep" as const,
    attrs: { value: 0 },
    children: [] as unknown[],
  };
  let current = root;
  for (let index = 1; index <= depth; index += 1) {
    const child = {
      id: `node-${index}`,
      type: "Deep" as const,
      attrs: { value: index === depth ? leafValue : index },
      children: [] as unknown[],
    };
    current.children.push(child);
    current = child;
  }
  return createDocument<DeepTypes>({ root } as never);
}

test("deep leaf changes diff and apply without recursive structural traversal", () => {
  const depth = 10_000;
  const base = createDeepTree(depth, 1);
  const target = createDeepTree(depth, 2);

  const patch = diffTrees(base, target);
  assert.equal(patch.ops.length, 1);
  assert.equal(patch.ops[0]?.kind, "setAttr");

  const result = applyPatch(base, patch);
  assert.equal(result.status, "applied");
  assert.equal(
    result.tree.nodes.get(`node-${depth}`)?.attrs.value,
    2,
  );
});
