import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  createResolutionSession,
  InvalidResolutionInputError,
  type TreeDocument,
  type TreePatch,
} from "../src/index.js";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    subtitle?: string;
    gallery: string[];
  };
  RichText: {
    html: string;
  };
};

function createBaseDocument(
  revision = "rev-1",
  heroTitle = "Summer Sale",
  heroSubtitle = "Free shipping",
): TreeDocument<ContentTypes> {
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
            title: heroTitle,
            subtitle: heroSubtitle,
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
      ],
    },
  };
}

function createTree(
  revision = "rev-1",
  heroTitle = "Summer Sale",
  heroSubtitle = "Free shipping",
) {
  return createDocument(createBaseDocument(revision, heroTitle, heroSubtitle));
}

test("createResolutionSession rejects patches that already conflict with the old base", () => {
  const oldBase = createTree("rev-1");
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "broken-on-old-base",
    baseRevision: "rev-1",
    ops: [
      {
        kind: "setAttr",
        opId: "hero-title",
        nodeId: "hero",
        path: "/title",
        value: "Promotions d'ete",
        guards: [
          {
            kind: "attrEquals",
            nodeId: "hero",
            path: "/title",
            value: "Wrong old title",
          },
        ],
      },
    ],
  };

  assert.throws(
    () => createResolutionSession(oldBase, oldBase, patch),
    InvalidResolutionInputError,
  );
});

test("resolution sessions can take base for one conflict and keep the remaining patch intent", () => {
  const oldBase = createTree("rev-1");
  const newBase = createTree("rev-2", "Spring Sale");
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "promo-copy",
    baseRevision: "rev-1",
    metadata: { locale: "fr" },
    ops: [
      {
        kind: "setAttr",
        opId: "hero-title",
        nodeId: "hero",
        path: "/title",
        value: "Promotions de printemps",
        guards: [
          {
            kind: "attrEquals",
            nodeId: "hero",
            path: "/title",
            value: "Summer Sale",
          },
        ],
      },
      {
        kind: "setAttr",
        opId: "legal-copy",
        nodeId: "legal",
        path: "/html",
        value: "<p>EU only</p>",
        guards: [
          {
            kind: "attrEquals",
            nodeId: "legal",
            path: "/html",
            value: "<p>US only</p>",
          },
        ],
      },
    ],
  };

  const session = createResolutionSession(oldBase, newBase, patch, { includeHidden: false });
  assert.deepEqual(session.unresolvedConflicts.map((conflict) => conflict.opId), ["hero-title"]);
  assert.deepEqual(session.appliedOpIds, ["legal-copy"]);
  assert.deepEqual(session.skippedOpIds, ["hero-title"]);
  assert.equal(session.preview.nodes.get("hero")?.attrs.title, "Spring Sale");
  assert.equal(session.preview.nodes.get("legal")?.attrs.html, "<p>EU only</p>");

  const unresolved = session.build();
  assert.equal(unresolved.status, "unresolved");
  assert.deepEqual(unresolved.conflicts.map((conflict) => conflict.opId), ["hero-title"]);

  const resolved = session.takeBase("hero-title").build();
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.appliedOpIds, ["legal-copy"]);
  assert.deepEqual(resolved.skippedOpIds, ["hero-title"]);
  assert.equal(resolved.resolvedPatch.patchId, "promo-copy");
  assert.equal(resolved.resolvedPatch.baseRevision, "rev-2");
  assert.deepEqual(resolved.resolvedPatch.metadata, { locale: "fr" });

  const applied = applyPatch(newBase, resolved.resolvedPatch, { includeHidden: false });
  assert.equal(applied.status, "applied");
  assert.equal(applied.tree.nodes.get("hero")?.attrs.title, "Spring Sale");
  assert.equal(applied.tree.nodes.get("legal")?.attrs.html, "<p>EU only</p>");
});

test("resolution sessions can keep local changes and rebuild a fresh patch against the new base", () => {
  const oldBase = createTree("rev-1");
  const newBase = createTree("rev-2", "Spring Sale");
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "promo-copy",
    baseRevision: "rev-1",
    metadata: { locale: "fr" },
    ops: [
      {
        kind: "setAttr",
        opId: "hero-title",
        nodeId: "hero",
        path: "/title",
        value: "Promotions de printemps",
        guards: [
          {
            kind: "attrEquals",
            nodeId: "hero",
            path: "/title",
            value: "Summer Sale",
          },
        ],
      },
      {
        kind: "setAttr",
        opId: "legal-copy",
        nodeId: "legal",
        path: "/html",
        value: "<p>EU only</p>",
        guards: [
          {
            kind: "attrEquals",
            nodeId: "legal",
            path: "/html",
            value: "<p>US only</p>",
          },
        ],
      },
    ],
  };

  const session = createResolutionSession(oldBase, newBase, patch, { includeHidden: false });
  const resolved = session.keepLocal("hero-title").build();
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.appliedOpIds, ["hero-title", "legal-copy"]);
  assert.deepEqual(resolved.skippedOpIds, []);
  assert.equal(resolved.resolvedPatch.patchId, "promo-copy");
  assert.deepEqual(resolved.resolvedPatch.metadata, { locale: "fr" });

  const applied = applyPatch(newBase, resolved.resolvedPatch, { includeHidden: false });
  assert.equal(applied.status, "applied");
  assert.equal(applied.tree.nodes.get("hero")?.attrs.title, "Promotions de printemps");
  assert.equal(applied.tree.nodes.get("legal")?.attrs.html, "<p>EU only</p>");
});

test("keepLocalAll replays conflicting operations in original order before rebuilding the patch", () => {
  const oldBase = createTree("rev-1");
  const newBase = createTree("rev-2", "Spring Sale");
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "hero-sequence",
    baseRevision: "rev-1",
    ops: [
      {
        kind: "setAttr",
        opId: "hero-step-1",
        nodeId: "hero",
        path: "/title",
        value: "Promo A",
        guards: [
          {
            kind: "attrEquals",
            nodeId: "hero",
            path: "/title",
            value: "Summer Sale",
          },
        ],
      },
      {
        kind: "setAttr",
        opId: "hero-step-2",
        nodeId: "hero",
        path: "/title",
        value: "Promo B",
        guards: [
          {
            kind: "attrEquals",
            nodeId: "hero",
            path: "/title",
            value: "Promo A",
          },
        ],
      },
    ],
  };

  const session = createResolutionSession(oldBase, newBase, patch);
  assert.deepEqual(session.unresolvedConflicts.map((conflict) => conflict.opId), [
    "hero-step-1",
    "hero-step-2",
  ]);

  const resolved = session.keepLocalAll().build();
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(resolved.appliedOpIds, ["hero-step-1", "hero-step-2"]);

  const applied = applyPatch(newBase, resolved.resolvedPatch);
  assert.equal(applied.status, "applied");
  assert.equal(applied.tree.nodes.get("hero")?.attrs.title, "Promo B");
});

test("replay conflicts surface after keepLocal and can be cleared with takeBase", () => {
  const base = createTree("rev-1");
  const inserted = applyPatch(base, {
    format: "tree-patch/v1",
    patchId: "insert-promo",
    baseRevision: "rev-1",
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
    ],
  });
  assert.equal(inserted.status, "applied");

  const oldBase = inserted.tree;
  const newBase = createTree("rev-2");
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "remove-promo",
    baseRevision: oldBase.revision,
    ops: [
      {
        kind: "removeNode",
        opId: "remove-promo",
        nodeId: "promo",
        guards: [
          { kind: "nodeExists", nodeId: "promo" },
          { kind: "parentIs", nodeId: "promo", parentId: "root" },
        ],
      },
    ],
  };

  const session = createResolutionSession(oldBase, newBase, patch);
  assert.deepEqual(session.unresolvedConflicts.map((conflict) => conflict.opId), ["remove-promo"]);

  const replaying = session.keepLocal("remove-promo");
  assert.deepEqual(replaying.unresolvedConflicts, []);
  assert.deepEqual(replaying.replayConflicts.map((conflict) => conflict.opId), ["remove-promo"]);

  const unresolved = replaying.build();
  assert.equal(unresolved.status, "unresolved");
  assert.deepEqual(unresolved.replayConflicts.map((conflict) => conflict.opId), ["remove-promo"]);

  const resolved = replaying.takeBase("remove-promo").build();
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedPatch.ops.length, 0);
  assert.equal(resolved.resolvedPatch.patchId, "remove-promo");
  assert.equal(resolved.preview.nodes.has("promo"), false);
});
