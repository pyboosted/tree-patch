import assert from "node:assert/strict";
import test from "node:test";

import { createDocument } from "../src/index.js";
import { getNodeHash, getPathHash, getSubtreeHash } from "../src/core/hash.js";

type HashTypes = {
  Page: {};
  Hero: {
    title: string;
    image: {
      url: string;
    };
  };
  Widget: {
    blob: {
      version: number;
      nested: {
        featured: boolean;
      };
    };
  };
};

function createHashSource() {
  return {
    root: {
      id: "root",
      type: "Page",
      attrs: {},
      children: [
        {
          id: "hero",
          type: "Hero",
          attrs: {
            title: "Summer Sale",
            image: {
              url: "/img/en.png",
            },
          },
          children: [],
        },
        {
          id: "widget",
          type: "Widget",
          attrs: {
            blob: {
              version: 1,
              nested: {
                featured: true,
              },
            },
          },
          children: [],
        },
      ],
    },
  } satisfies Parameters<typeof createDocument<HashTypes>>[0];
}

test("equal documents produce identical node, subtree, path hashes, and derived revisions", () => {
  const treeA = createDocument<HashTypes>(createHashSource());
  const treeB = createDocument<HashTypes>(structuredClone(createHashSource()));

  assert.equal(getNodeHash(treeA, "hero"), getNodeHash(treeB, "hero"));
  assert.equal(getSubtreeHash(treeA, "root"), getSubtreeHash(treeB, "root"));
  assert.equal(getPathHash(treeA, "hero", "/image/url"), getPathHash(treeB, "hero", "/image/url"));
  assert.equal(treeA.revision, getSubtreeHash(treeA, "root"));
  assert.equal(treeB.revision, getSubtreeHash(treeB, "root"));
});

test("atomic schema paths are opaque but still change hashes when inner data changes", () => {
  const sourceA = createHashSource();
  const sourceB = createHashSource();
  sourceB.root.children[1]!.attrs.blob.nested.featured = false;

  const schema = {
    types: {
      Widget: {
        atomicPaths: [["blob"]] as const,
      },
    },
  };

  const treeA = createDocument<HashTypes>(sourceA, { schema });
  const treeB = createDocument<HashTypes>(sourceB, { schema });

  assert.notEqual(getPathHash(treeA, "widget", "/blob"), getPathHash(treeB, "widget", "/blob"));
  assert.notEqual(getNodeHash(treeA, "widget"), getNodeHash(treeB, "widget"));
  assert.notEqual(getSubtreeHash(treeA, "root"), getSubtreeHash(treeB, "root"));
});

