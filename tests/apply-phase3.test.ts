import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  materialize,
  MalformedPatchError,
  type TreeDocument,
  type TreePatch,
} from "../src/index.js";
import { getNodeHash, getPathHash, getSubtreeHash } from "../src/core/hash.js";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    image: {
      url: string;
    };
    gallery: string[];
  };
  RichText: {
    html: string;
  };
  Section: {
    label: string;
  };
};

function createSourceDocument(revision = "rev-1"): TreeDocument<ContentTypes> {
  return {
    revision,
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
            gallery: ["/gallery/a.png", "/gallery/b.png"],
          },
          children: [],
        },
        {
          id: "legal",
          type: "RichText",
          attrs: {
            html: "<p>US only</p>",
          },
          children: [],
        },
        {
          id: "section",
          type: "Section",
          attrs: {
            label: "Details",
          },
          children: [
            {
              id: "section-note",
              type: "RichText",
              attrs: {
                html: "<p>Nested note</p>",
              },
              children: [],
            },
          ],
        },
      ],
    },
  };
}

function createSourceTree(revision = "rev-1") {
  return createDocument<ContentTypes>(createSourceDocument(revision));
}

test("moveNode supports same-parent reorder and cross-parent move while keeping indexes consistent", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "move-structure",
    ops: [
      {
        kind: "moveNode",
        opId: "legal-first",
        nodeId: "legal",
        newParentId: "root",
        position: { atStart: true },
      },
      {
        kind: "moveNode",
        opId: "note-to-root",
        nodeId: "section-note",
        newParentId: "root",
        position: { atEnd: true },
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.materialized.children.map((child) => child.id), [
    "legal",
    "hero",
    "section",
    "section-note",
  ]);
  assert.deepEqual(result.tree.nodes.get("section")?.childIds, []);
  assert.equal(result.tree.index.parentById.get("section-note"), "root");
  assert.equal(result.tree.index.positionById.get("section-note"), 3);
  assert.equal(result.tree.index.depthById.get("section-note"), 1);
  assert.equal(result.tree.index.positionById.get("legal"), 0);
  assert.equal(result.tree.index.positionById.get("hero"), 1);
  assert.equal(result.tree.index.positionById.get("section"), 2);
});

test("moveNode rejects patch-owned parent moves, root moves, cycles, and missing anchors", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "move-conflicts",
    ops: [
      {
        kind: "insertNode",
        opId: "insert-promo",
        parentId: "root",
        node: {
          id: "promo",
          type: "RichText",
          attrs: { html: "<p>Promo</p>" },
          children: [],
        },
      },
      {
        kind: "moveNode",
        opId: "hero-under-promo",
        nodeId: "hero",
        newParentId: "promo",
        position: { atEnd: true },
      },
      {
        kind: "moveNode",
        opId: "move-root",
        nodeId: "root",
        newParentId: "section",
        position: { atEnd: true },
      },
      {
        kind: "moveNode",
        opId: "cycle",
        nodeId: "section",
        newParentId: "section-note",
        position: { atEnd: true },
      },
      {
        kind: "moveNode",
        opId: "missing-anchor",
        nodeId: "legal",
        newParentId: "root",
        position: { afterId: "missing" },
      },
    ],
  };

  const result = applyPatch(source, patch, { mode: "preview" });
  assert.equal(result.status, "preview");
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), [
    "IllegalOperation",
    "IllegalOperation",
    "IllegalOperation",
    "AnchorMissing",
  ]);
  assert.equal(result.tree.nodes.get("promo")?.attrs.html, "<p>Promo</p>");
});

test("moveNode no-op reorders succeed without changing subtree hashes", () => {
  const source = createSourceTree();
  const sourceRootHash = getSubtreeHash(source, "root");
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "move-no-op",
    ops: [
      {
        kind: "moveNode",
        opId: "legal-after-hero",
        nodeId: "legal",
        newParentId: "root",
        position: { afterId: "hero" },
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.materialized.children.map((child) => child.id), ["hero", "legal", "section"]);
  assert.equal(getSubtreeHash(result.tree, "root"), sourceRootHash);
});

test("replaceSubtree preserves parent and position, allows patch-owned descendant reuse, and removed descendants become missing", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "replace-section",
    ops: [
      {
        kind: "insertNode",
        opId: "insert-extra",
        parentId: "section",
        node: {
          id: "section-extra",
          type: "RichText",
          attrs: { html: "<p>Inserted first</p>" },
          children: [],
        },
      },
      {
        kind: "replaceSubtree",
        opId: "replace-section",
        nodeId: "section",
        node: {
          id: "section",
          type: "Section",
          attrs: { label: "Localized details" },
          children: [
            {
              id: "section-extra",
              type: "RichText",
              attrs: { html: "<p>Reused</p>" },
              children: [],
            },
            {
              id: "section-fresh",
              type: "RichText",
              attrs: { html: "<p>Fresh</p>" },
              children: [],
            },
          ],
        },
      },
      {
        kind: "setAttr",
        opId: "touch-removed-descendant",
        nodeId: "section-note",
        path: "/html",
        value: "<p>Should fail</p>",
      },
    ],
  };

  const result = applyPatch(source, patch, { mode: "preview" });
  assert.equal(result.status, "preview");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.kind, "NodeMissing");
  assert.deepEqual(result.tree.nodes.get("section")?.childIds, ["section-extra", "section-fresh"]);
  assert.equal(result.tree.index.parentById.get("section"), "root");
  assert.equal(result.tree.index.positionById.get("section"), 2);
  assert.equal(result.tree.nodes.has("section-note"), false);

  const section = result.materialized.children.find((child) => child.id === "section");
  assert.ok(section);
  assert.equal(section.state?.patchOwned, undefined);
  assert.equal(section.children[0]?.id, "section-extra");
  assert.equal(section.children[0]?.state?.patchOwned, true);
  assert.equal(section.children[1]?.id, "section-fresh");
  assert.equal(section.children[1]?.state?.patchOwned, true);
});

test("replaceSubtree rejects malformed root ids, live collisions, and removed source descendant id reuse", () => {
  const source = createSourceTree();

  assert.throws(
    () =>
      applyPatch(source, {
        format: "tree-patch/v1",
        patchId: "bad-replacement-id",
        ops: [
          {
            kind: "replaceSubtree",
            opId: "bad-id",
            nodeId: "section",
            node: {
              id: "not-section",
              type: "Section",
              attrs: { label: "Broken" },
              children: [],
            },
          },
        ],
      }),
    MalformedPatchError,
  );

  const conflictPatch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "replace-conflicts",
    ops: [
      {
        kind: "replaceSubtree",
        opId: "live-collision",
        nodeId: "hero",
        node: {
          id: "hero",
          type: "Hero",
          attrs: {
            title: "Local hero",
            image: {
              url: "/img/fr.png",
            },
            gallery: ["/gallery/c.png"],
          },
          children: [
            {
              id: "legal",
              type: "RichText",
              attrs: { html: "<p>Collision</p>" },
              children: [],
            },
          ],
        },
      },
      {
        kind: "replaceSubtree",
        opId: "source-descendant-reuse",
        nodeId: "section",
        node: {
          id: "section",
          type: "Section",
          attrs: { label: "Still bad" },
          children: [
            {
              id: "section-note",
              type: "RichText",
              attrs: { html: "<p>Reused source descendant</p>" },
              children: [],
            },
          ],
        },
      },
    ],
  };

  const result = applyPatch(source, conflictPatch, { mode: "preview" });
  assert.equal(result.status, "preview");
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), [
    "NodeAlreadyExists",
    "IllegalOperation",
  ]);
});

test("replaceSubtree allows root replacement when the replacement keeps the same root id", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "replace-root",
    ops: [
      {
        kind: "replaceSubtree",
        opId: "replace-root",
        nodeId: "root",
        node: {
          id: "root",
          type: "Page",
          attrs: {},
          children: [
            {
              id: "landing-hero",
              type: "Hero",
              attrs: {
                title: "Bienvenue",
                image: {
                  url: "/img/fr.png",
                },
                gallery: ["/gallery/fr.png"],
              },
              children: [],
            },
          ],
        },
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  assert.equal(result.tree.rootId, "root");
  assert.deepEqual(result.materialized.children.map((child) => child.id), ["landing-hero"]);
  assert.equal(result.tree.nodes.has("hero"), false);
  assert.equal(result.tree.nodes.has("section"), false);
});

test("removeNode removes patch-owned subtrees and later ops on removed descendants become missing", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "remove-patch-owned",
    ops: [
      {
        kind: "insertNode",
        opId: "insert-promo",
        parentId: "root",
        node: {
          id: "promo",
          type: "Section",
          attrs: { label: "Promo" },
          children: [
            {
              id: "promo-child",
              type: "RichText",
              attrs: { html: "<p>Nested promo</p>" },
              children: [],
            },
          ],
        },
      },
      {
        kind: "removeNode",
        opId: "remove-promo",
        nodeId: "promo",
      },
      {
        kind: "setAttr",
        opId: "touch-removed-child",
        nodeId: "promo-child",
        path: "/html",
        value: "<p>Missing</p>",
      },
    ],
  };

  const result = applyPatch(source, patch, { mode: "preview" });
  assert.equal(result.status, "preview");
  assert.equal(result.conflicts[0]?.kind, "NodeMissing");
  assert.equal(result.tree.nodes.has("promo"), false);
  assert.equal(result.tree.nodes.has("promo-child"), false);
  assert.deepEqual(result.materialized.children.map((child) => child.id), ["hero", "legal", "section"]);
});

test("removeNode rejects source-backed and root targets", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "remove-conflicts",
    ops: [
      {
        kind: "removeNode",
        opId: "remove-legal",
        nodeId: "legal",
      },
      {
        kind: "removeNode",
        opId: "remove-root",
        nodeId: "root",
      },
    ],
  };

  const result = applyPatch(source, patch, { mode: "preview" });
  assert.equal(result.status, "preview");
  assert.deepEqual(result.conflicts.map((conflict) => conflict.kind), [
    "IllegalOperation",
    "IllegalOperation",
  ]);
});

test("localized structural changes preserve unrelated caches while touched subtree hashes change", () => {
  const source = createSourceTree();
  const heroNodeHash = getNodeHash(source, "hero");
  const heroPathHash = getPathHash(source, "hero", "/title");
  const movedSubtreeHash = getSubtreeHash(source, "section-note");
  const rootHash = getSubtreeHash(source, "root");

  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "move-cache",
    ops: [
      {
        kind: "moveNode",
        opId: "note-to-root",
        nodeId: "section-note",
        newParentId: "root",
        position: { atEnd: true },
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  assert.equal(result.tree.cache.nodeHashById.get("hero"), heroNodeHash);
  assert.equal(result.tree.cache.pathHashByNodeId.get("hero")?.get("/title"), heroPathHash);
  assert.equal(getSubtreeHash(result.tree, "section-note"), movedSubtreeHash);
  assert.notEqual(getSubtreeHash(result.tree, "root"), rootHash);
});

test("hidden patch-owned nodes stay hidden after structural moves and are pruned when includeHidden is false", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "hidden-move",
    ops: [
      {
        kind: "insertNode",
        opId: "insert-promo",
        parentId: "root",
        node: {
          id: "promo",
          type: "RichText",
          attrs: { html: "<p>Promo</p>" },
          children: [],
        },
      },
      {
        kind: "hideNode",
        opId: "hide-promo",
        nodeId: "promo",
      },
      {
        kind: "moveNode",
        opId: "move-promo",
        nodeId: "promo",
        newParentId: "section",
        position: { atStart: true },
      },
    ],
  };

  const included = applyPatch(source, patch, { includeHidden: true });
  assert.equal(included.status, "applied");
  const section = included.materialized.children.find((child) => child.id === "section");
  assert.ok(section);
  assert.equal(section.children[0]?.id, "promo");
  assert.equal(section.children[0]?.state?.hidden, true);
  assert.equal(section.children[0]?.state?.patchOwned, true);

  const pruned = materialize(source, patch, { includeHidden: false });
  assert.equal(pruned.status, "applied");
  const prunedSection = pruned.materialized.children.find((child) => child.id === "section");
  assert.ok(prunedSection);
  assert.deepEqual(prunedSection.children.map((child) => child.id), ["section-note"]);
});
