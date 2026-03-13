import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  materialize,
  MissingCodecError,
  UnsupportedPatchOperationError,
  validatePatch,
  type TreeDocument,
  type TreePatch,
} from "../src/index.js";
import { getNodeHash, getPathHash } from "../src/core/hash.js";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    image: {
      url: string;
    };
    gallery: string[];
    style?: {
      fontSize?: number;
    };
    publishedAt?: Date;
  };
  RichText: {
    html: string;
  };
  Section: {
    label: string;
  };
};

const dateCodec = {
  codecId: "date",
  serialize(value: Date) {
    return value.toISOString();
  },
  deserialize(value: string) {
    return new Date(value);
  },
};

const schema = {
  types: {
    Hero: {
      adapters: {
        "/publishedAt": {
          equals: (left: Date, right: Date) => left.getTime() === right.getTime(),
          clone: (value: Date) => new Date(value.getTime()),
          codec: dateCodec,
        },
      },
    },
  },
} as const;

function createSourceDocument(
  revision = "rev-1",
  publishedAt: Date | undefined = undefined,
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
            title: "Summer Sale",
            image: {
              url: "/img/en.png",
            },
            gallery: ["/gallery/a.png", "/gallery/b.png"],
            ...(publishedAt ? { publishedAt } : {}),
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

function createSourceTree(
  revision = "rev-1",
  publishedAt: Date | undefined = undefined,
) {
  return createDocument<ContentTypes>(createSourceDocument(revision, publishedAt), {
    schema,
  });
}

test("validatePatch preview computes revision status and simulates sequential ops without committing", () => {
  const source = createSourceTree("rev-1");
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "preview-validate",
    baseRevision: "rev-1",
    ops: [
      {
        kind: "insertNode",
        opId: "insert-promo",
        parentId: "root",
        node: {
          id: "promo",
          type: "RichText",
          attrs: {
            html: "<p>Promo</p>",
          },
          children: [],
        },
      },
      {
        kind: "setAttr",
        opId: "update-promo",
        nodeId: "promo",
        path: "/html",
        value: "<p>Updated</p>",
      },
      {
        kind: "removeAttr",
        opId: "remove-missing",
        nodeId: "hero",
        path: "/missing",
      },
    ],
  };

  const result = validatePatch(source, patch, { mode: "preview" });
  assert.equal(result.status, "conflict");
  assert.equal(result.revision.status, "match");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.kind, "PathInvalid");
  assert.equal(source.nodes.has("promo"), false);
});

test("validatePatch reports mismatch and unknown revision states", () => {
  const source = createSourceTree("rev-2");
  const mismatch = validatePatch(source, {
    format: "tree-patch/v1",
    patchId: "mismatch",
    baseRevision: "rev-1",
    ops: [],
  });
  assert.equal(mismatch.revision.status, "mismatch");

  const unknown = validatePatch(source, {
    format: "tree-patch/v1",
    patchId: "unknown",
    ops: [],
  });
  assert.equal(unknown.revision.status, "unknown");
});

test("applyPatch atomic mode returns conflict and no committed result", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "atomic-conflict",
    ops: [
      {
        kind: "setAttr",
        opId: "update-title",
        nodeId: "hero",
        path: "/title",
        value: "Promotions d'ete",
      },
      {
        kind: "removeAttr",
        opId: "invalid-remove",
        nodeId: "hero",
        path: "/missing",
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts.length, 1);
  assert.equal(source.nodes.get("hero")?.attrs.title, "Summer Sale");
});

test("applyPatch preview returns partial results and later ops see earlier successful overlay changes", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "preview-apply",
    ops: [
      {
        kind: "insertNode",
        opId: "insert-promo",
        parentId: "root",
        position: { afterId: "hero" },
        node: {
          id: "promo",
          type: "RichText",
          attrs: {
            html: "<p>Promo</p>",
          },
          children: [],
        },
      },
      {
        kind: "removeAttr",
        opId: "invalid-remove",
        nodeId: "hero",
        path: "/missing",
      },
      {
        kind: "setAttr",
        opId: "update-promo",
        nodeId: "promo",
        path: "/html",
        value: "<p>Later update</p>",
      },
      {
        kind: "hideNode",
        opId: "hide-legal",
        nodeId: "legal",
      },
    ],
  };

  const result = applyPatch(source, patch, { mode: "preview", includeHidden: false });
  assert.equal(result.status, "preview");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.kind, "PathInvalid");
  assert.equal(result.tree.nodes.has("promo"), true);
  assert.equal(result.tree.nodes.get("promo")?.attrs.html, "<p>Later update</p>");
  assert.deepEqual(result.materialized.children.map((child) => child.id), [
    "hero",
    "promo",
    "section",
  ]);
});

test("setAttr autovivifies objects and removeAttr splices arrays", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "set-remove",
    ops: [
      {
        kind: "setAttr",
        opId: "font-size",
        nodeId: "hero",
        path: "/style/fontSize",
        value: 28,
      },
      {
        kind: "removeAttr",
        opId: "drop-gallery-first",
        nodeId: "hero",
        path: "/gallery/0",
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  assert.equal(result.tree.nodes.get("hero")?.attrs.style?.fontSize, 28);
  assert.deepEqual(result.tree.nodes.get("hero")?.attrs.gallery, ["/gallery/b.png"]);
});

test("showNode does not override a hidden ancestor and includeHidden false prunes the subtree", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "visibility",
    ops: [
      {
        kind: "hideNode",
        opId: "hide-section",
        nodeId: "section",
      },
      {
        kind: "showNode",
        opId: "show-note",
        nodeId: "section-note",
      },
    ],
  };

  const included = applyPatch(source, patch, { includeHidden: true });
  assert.equal(included.status, "applied");
  const section = included.materialized.children.find((child) => child.id === "section");
  assert.ok(section);
  assert.equal(section.state?.hidden, true);
  assert.equal(section.state?.explicitlyHidden, true);
  assert.equal(section.children[0]?.state?.hidden, true);
  assert.equal(section.children[0]?.state?.explicitlyHidden, undefined);

  const pruned = materialize(source, patch, { includeHidden: false });
  assert.equal(pruned.status, "applied");
  assert.deepEqual(pruned.materialized.children.map((child) => child.id), ["hero", "legal"]);
});

test("insertNode supports positioning, patch-owned parents, duplicate-id conflicts, and missing anchors", () => {
  const source = createSourceTree();
  const okPatch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "insert-ordering",
    ops: [
      {
        kind: "insertNode",
        opId: "start",
        parentId: "root",
        position: { atStart: true },
        node: {
          id: "start",
          type: "RichText",
          attrs: { html: "<p>Start</p>" },
          children: [],
        },
      },
      {
        kind: "insertNode",
        opId: "after-hero",
        parentId: "root",
        position: { afterId: "hero" },
        node: {
          id: "after-hero",
          type: "Section",
          attrs: { label: "Promo" },
          children: [],
        },
      },
      {
        kind: "insertNode",
        opId: "before-legal",
        parentId: "root",
        position: { beforeId: "legal" },
        node: {
          id: "before-legal",
          type: "RichText",
          attrs: { html: "<p>Before legal</p>" },
          children: [],
        },
      },
      {
        kind: "insertNode",
        opId: "end",
        parentId: "root",
        position: { atEnd: true },
        node: {
          id: "end",
          type: "RichText",
          attrs: { html: "<p>End</p>" },
          children: [],
        },
      },
      {
        kind: "insertNode",
        opId: "child-under-patch-owned",
        parentId: "after-hero",
        node: {
          id: "promo-child",
          type: "RichText",
          attrs: { html: "<p>Child</p>" },
          children: [],
        },
      },
    ],
  };

  const applied = applyPatch(source, okPatch);
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.materialized.children.map((child) => child.id), [
    "start",
    "hero",
    "after-hero",
    "before-legal",
    "legal",
    "section",
    "end",
  ]);
  const patchOwnedParent = applied.materialized.children.find((child) => child.id === "after-hero");
  assert.ok(patchOwnedParent);
  assert.equal(patchOwnedParent.state?.patchOwned, true);
  assert.equal(patchOwnedParent.children[0]?.id, "promo-child");
  assert.equal(patchOwnedParent.children[0]?.state?.patchOwned, true);

  const conflictPatch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "insert-conflicts",
    ops: [
      {
        kind: "insertNode",
        opId: "duplicate-id",
        parentId: "root",
        node: {
          id: "hero",
          type: "RichText",
          attrs: { html: "<p>Nope</p>" },
          children: [],
        },
      },
      {
        kind: "insertNode",
        opId: "missing-anchor",
        parentId: "root",
        position: { afterId: "missing" },
        node: {
          id: "promo-2",
          type: "RichText",
          attrs: { html: "<p>Nope</p>" },
          children: [],
        },
      },
    ],
  };

  const preview = applyPatch(source, conflictPatch, { mode: "preview" });
  assert.equal(preview.status, "preview");
  assert.deepEqual(preview.conflicts.map((conflict) => conflict.kind), [
    "NodeAlreadyExists",
    "AnchorMissing",
  ]);
});

test("codec-backed values compare and materialize after decode", () => {
  const oldDate = new Date("2026-03-12T00:00:00.000Z");
  const newDate = new Date("2026-03-13T00:00:00.000Z");
  const source = createSourceTree("rev-1", oldDate);
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "codec",
    baseRevision: "rev-1",
    ops: [
      {
        kind: "setAttr",
        opId: "set-date",
        nodeId: "hero",
        path: "/publishedAt",
        value: {
          $codec: "date",
          value: newDate.toISOString(),
        },
        guards: [
          {
            kind: "attrEquals",
            nodeId: "hero",
            path: "/publishedAt",
            value: {
              $codec: "date",
              value: oldDate.toISOString(),
            },
          },
        ],
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  const materializedDate = result.tree.nodes.get("hero")?.attrs.publishedAt;
  assert.ok(materializedDate instanceof Date);
  assert.equal(materializedDate.toISOString(), newDate.toISOString());
});

test("unknown codecs are rejected as programmer errors", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "missing-codec",
    ops: [
      {
        kind: "setAttr",
        opId: "set-date",
        nodeId: "hero",
        path: "/publishedAt",
        value: {
          $codec: "missing",
          value: "2026-03-12T00:00:00.000Z",
        },
      },
    ],
  };

  assert.throws(() => applyPatch(source, patch), MissingCodecError);
});

test("nodeTypeIs guards against missing nodes fail as guard conflicts", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "missing-node-type-guard",
    ops: [
      {
        kind: "setAttr",
        opId: "update-title",
        nodeId: "hero",
        path: "/title",
        value: "Promotions d'ete",
        guards: [
          {
            kind: "nodeTypeIs",
            nodeId: "missing-node",
            nodeType: "Hero",
          },
        ],
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0]?.kind, "GuardFailed");
  assert.equal(result.conflicts[0]?.nodeId, "missing-node");
  assert.equal(result.conflicts[0]?.expected, "Hero");
  assert.equal(result.conflicts[0]?.actual, undefined);
});

test("unknown operation kinds are rejected as programmer errors", () => {
  const source = createSourceTree();
  const patch = {
    format: "tree-patch/v1",
    patchId: "unsupported",
    ops: [
      {
        kind: "explodeNode",
        opId: "explode",
      },
    ],
  } as unknown as TreePatch;

  assert.throws(() => applyPatch(source, patch), UnsupportedPatchOperationError);
});

test("materialize uses the same conflict semantics as applyPatch", () => {
  const source = createSourceTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "materialize-conflict",
    ops: [
      {
        kind: "removeAttr",
        opId: "remove-missing",
        nodeId: "hero",
        path: "/missing",
      },
    ],
  };

  const result = materialize(source, patch);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0]?.kind, "PathInvalid");
});

test("unrelated cached hashes survive while touched hashes are invalidated", () => {
  const source = createSourceTree();
  const legalNodeHash = getNodeHash(source, "legal");
  const legalPathHash = getPathHash(source, "legal", "/html");
  const heroNodeHash = getNodeHash(source, "hero");

  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "cache",
    ops: [
      {
        kind: "setAttr",
        opId: "title",
        nodeId: "hero",
        path: "/title",
        value: "Localized Title",
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "applied");
  assert.equal(result.tree.cache.nodeHashById.get("legal"), legalNodeHash);
  assert.equal(result.tree.cache.pathHashByNodeId.get("legal")?.get("/html"), legalPathHash);
  assert.notEqual(result.tree.cache.nodeHashById.get("hero"), heroNodeHash);
  assert.equal(result.tree.cache.nodeHashById.get("hero"), getNodeHash(result.tree, "hero"));
});
