import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyPatch, createDocument, diffTrees } from "../src/index.js";
import {
  getNodeHash,
  getPathHash,
  getSubtreeHash,
  getTreeRevisionHash,
} from "../src/core/hash.js";
import { getTreeState } from "../src/core/state.js";

type HashTypes = {
  Page: { version?: number };
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
  assert.match(treeA.revision!, /^tree:h3:/);
  assert.match(getNodeHash(treeA, "hero"), /^h3:/);
  assert.match(getSubtreeHash(treeA, "root"), /^h3:/);
  assert.match(getPathHash(treeA, "hero", "/image/url"), /^h3:/);

  const legacyGuard = applyPatch(treeA, {
    format: "tree-patch/v1",
    patchId: "legacy-hash-guard",
    ops: [{
      kind: "setAttr",
      opId: "set-title",
      nodeId: "hero",
      path: "/title",
      value: "Winter Sale",
      guards: [{
        kind: "attrHash",
        nodeId: "hero",
        path: "/title",
        hash: "h2:00000000000000000000000000000000",
      }],
    }],
  });
  assert.equal(legacyGuard.status, "conflict");
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

  const semanticNoOp = applyPatch(external, {
    format: "tree-patch/v1",
    patchId: "same-title",
    ops: [{
      kind: "setAttr",
      opId: "same-title",
      nodeId: "hero",
      path: "/title",
      value: "Summer Sale",
    }],
  });
  assert.equal(semanticNoOp.status, "applied");
  assert.equal(semanticNoOp.tree.revision, "cms-rev-42");

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
  assert.match(hidden.tree.revision!, /^tree:h3:/);

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

test("visibility signatures and revisions encode node id boundaries unambiguously", () => {
  type BoundaryTypes = {
    Page: {};
  };
  const nodeIds = ["a", "b", "a|b", "a\u0000b"];
  const source = createDocument<BoundaryTypes>({
    root: {
      id: "root",
      type: "Page",
      attrs: {},
      children: nodeIds.map((id) => ({
        id,
        type: "Page" as const,
        attrs: {},
        children: [],
      })),
    },
  });
  const hide = (ids: readonly string[]) => {
    const result = applyPatch(source, {
      format: "tree-patch/v1",
      patchId: `hide-${ids.length}`,
      ops: ids.map((nodeId, index) => ({
        kind: "hideNode" as const,
        opId: `hide-${index}`,
        nodeId,
      })),
    });
    assert.equal(result.status, "applied");
    return result.tree;
  };

  const twoHidden = hide(["a", "b"]);
  const pipeHidden = hide(["a|b"]);
  assert.equal(diffTrees(twoHidden, pipeHidden).ops.length, 3);

  const nulHidden = hide(["a\u0000b"]);
  assert.notEqual(twoHidden.revision, nulHidden.revision);
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

test("ordered child aggregates are shared for parent attrs and forked for child edits", () => {
  const source = createDocument<HashTypes>(createHashSource());
  const sourceState = getTreeState(source);
  const sourceAggregate = sourceState.cache.childHashByParentId.get("root")!;
  const sourceDigest = sourceAggregate.digest();

  const rootEdit = applyPatch(source, {
    format: "tree-patch/v1",
    patchId: "root-attr",
    ops: [{
      kind: "setAttr",
      opId: "set-version",
      nodeId: "root",
      path: "/version",
      value: 2,
    }],
  });
  assert.equal(rootEdit.status, "applied");
  assert.strictEqual(
    getTreeState(rootEdit.tree).cache.childHashByParentId.get("root"),
    sourceAggregate,
  );

  const childEdit = applyPatch(source, {
    format: "tree-patch/v1",
    patchId: "child-attr",
    ops: [{
      kind: "setAttr",
      opId: "set-title",
      nodeId: "hero",
      path: "/title",
      value: "Winter Sale",
    }],
  });
  assert.equal(childEdit.status, "applied");
  getSubtreeHash(childEdit.tree, "root");
  const childEditAggregate =
    getTreeState(childEdit.tree).cache.childHashByParentId.get("root")!;
  assert.notStrictEqual(childEditAggregate, sourceAggregate);
  assert.notEqual(childEditAggregate.digest(), sourceDigest);
  assert.equal(sourceAggregate.digest(), sourceDigest);
});

test("portable hashing no longer depends on node crypto runtime imports", () => {
  const hashSource = readFileSync(new URL("../src/core/hash.ts", import.meta.url), "utf8");
  const diffSource = readFileSync(new URL("../src/core/diff.ts", import.meta.url), "utf8");

  assert.doesNotMatch(hashSource, /node:crypto|createHash\(/);
  assert.doesNotMatch(diffSource, /node:crypto|createHash\(/);
  assert.doesNotMatch(diffSource, /localeCompare\(/);
});
