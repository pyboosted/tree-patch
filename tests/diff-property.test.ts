import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
  type AnyMaterializedNode,
  type JsonValue,
  type TreeDocument,
} from "../src/index.js";

type PropertyTypes = {
  X: Record<string, JsonValue>;
};

function createBaseDocument(): TreeDocument<PropertyTypes> {
  return {
    root: {
      id: "root",
      type: "X",
      attrs: {
        title: "base",
        nested: { stable: true },
      },
      children: Array.from({ length: 5 }, (_, childIndex) => ({
        id: `child-${childIndex}`,
        type: "X" as const,
        attrs: {
          value: childIndex,
          optional: "present",
        },
        children: Array.from({ length: 2 }, (_, grandchildIndex) => ({
          id: `grandchild-${childIndex}-${grandchildIndex}`,
          type: "X" as const,
          attrs: {
            value: grandchildIndex,
          },
          children: [],
        })),
      })),
    },
  };
}

function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffle<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex]!, values[index]!];
  }
}

function stripState(node: AnyMaterializedNode<PropertyTypes>): unknown {
  return {
    id: node.id,
    type: node.type,
    attrs: node.attrs,
    children: node.children.map(stripState),
  };
}

test("deterministic mixed transforms preserve diff/apply round trips", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = createRandom(seed);
    const targetDocument = structuredClone(createBaseDocument());
    const root = targetDocument.root;
    const nodes = [
      root,
      ...root.children,
      ...root.children.flatMap((child) => child.children),
    ];

    for (const node of nodes) {
      const choice = random();
      if (choice < 0.2) {
        node.attrs.value = Math.floor(random() * 10);
      } else if (choice < 0.35) {
        node.attrs.added = `seed-${seed}`;
      } else if (choice < 0.45) {
        delete node.attrs.optional;
      }
    }

    shuffle(root.children, random);

    if (random() < 0.5) {
      const sourceParent =
        root.children[Math.floor(random() * root.children.length)];
      const targetParent =
        root.children[Math.floor(random() * root.children.length)];
      const moved = sourceParent?.children.pop();
      if (moved && targetParent) {
        targetParent.children.unshift(moved);
      }
    }

    if (random() < 0.5) {
      const parent = root.children[Math.floor(random() * root.children.length)];
      parent?.children.push({
        id: `inserted-${seed}`,
        type: "X",
        attrs: { value: seed },
        children: [],
      });
    }

    if (random() < 0.25 && root.children.length > 1) {
      root.children.splice(Math.floor(random() * root.children.length), 1);
    }

    const base = createDocument(createBaseDocument());
    const target = createDocument(targetDocument);
    const patch = diffTrees(base, target);
    const applied = applyPatch(base, patch, { includeHidden: false });

    assert.equal(applied.status, "applied", `seed ${seed}`);
    if (applied.status === "applied") {
      assert.deepEqual(
        stripState(applied.materialized),
        targetDocument.root,
        `seed ${seed}`,
      );
    }
  }
});
