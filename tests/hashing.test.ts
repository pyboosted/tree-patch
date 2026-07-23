import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyPatch, createDocument } from "../src/index.js";
import {
  getNodeHash,
  getPathHash,
  getSubtreeHash,
  getTreeRevisionHash,
} from "../src/core/hash.js";

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
  assert.equal(treeA.revision, getTreeRevisionHash(treeA));
  assert.equal(treeB.revision, getTreeRevisionHash(treeB));
  assert.match(treeA.revision!, /^tree:/);
});

test("derived revisions include visibility and metadata while semantic no-ops preserve external revisions", () => {
  const external = createDocument<HashTypes>({
    ...createHashSource(),
    revision: "cms-rev-42",
  });
  const empty = applyPatch(external, {
    format: "tree-patch/v1",
    patchId: "empty",
    ops: [],
  });
  assert.equal(empty.status, "applied");
  assert.equal(empty.tree.revision, "cms-rev-42");

  const hidden = applyPatch(external, {
    format: "tree-patch/v1",
    patchId: "hide",
    baseRevision: "cms-rev-42",
    ops: [
      {
        kind: "hideNode",
        opId: "hide-hero",
        nodeId: "hero",
      },
    ],
  });
  assert.equal(hidden.status, "applied");
  assert.notEqual(hidden.tree.revision, external.revision);
  assert.match(hidden.tree.revision!, /^tree:/);

  const metadataA = createDocument<HashTypes>({
    ...createHashSource(),
    metadata: { locale: "en" },
  });
  const metadataB = createDocument<HashTypes>({
    ...createHashSource(),
    metadata: { locale: "fr" },
  });
  assert.notEqual(metadataA.revision, metadataB.revision);
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

test("portable hashing no longer depends on node crypto runtime imports", () => {
  const hashSource = readFileSync(new URL("../src/core/hash.ts", import.meta.url), "utf8");
  const diffSource = readFileSync(new URL("../src/core/diff.ts", import.meta.url), "utf8");

  assert.doesNotMatch(hashSource, /node:crypto|createHash\(/);
  assert.doesNotMatch(diffSource, /node:crypto|createHash\(/);
  assert.doesNotMatch(diffSource, /localeCompare\(/);
});
