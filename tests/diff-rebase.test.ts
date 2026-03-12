import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
  materialize,
  MissingCodecError,
  rebasePatch,
  UnsupportedTransformError,
  type AnyMaterializedNode,
  type TreeDocument,
  type TreePatch,
  type TreeSchema,
} from "../src/index.js";

type ContentTypes = {
  Page: {
    locale?: string;
  };
  Hero: {
    title: string;
    image: {
      url: string;
    };
    gallery: string[];
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

const schemaWithDateCodec = {
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
} satisfies TreeSchema<ContentTypes>;

const schemaWithoutDateCodec = {
  types: {
    Hero: {
      adapters: {
        "/publishedAt": {
          equals: (left: Date, right: Date) => left.getTime() === right.getTime(),
          clone: (value: Date) => new Date(value.getTime()),
          hash: (value: Date) => value.toISOString(),
        },
      },
    },
  },
} satisfies TreeSchema<ContentTypes>;

const emptyPatch: TreePatch = {
  format: "tree-patch/v1",
  patchId: "empty",
  ops: [],
};

function createBaseDocument(
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

function createTree(
  document: TreeDocument<ContentTypes>,
  schema: TreeSchema<ContentTypes> = schemaWithDateCodec,
) {
  return createDocument<ContentTypes>(document, { schema });
}

function stripMaterialized(node: AnyMaterializedNode<ContentTypes>): unknown {
  return {
    id: node.id,
    type: node.type,
    attrs: node.attrs,
    children: node.children.map((child) => stripMaterialized(child)),
  };
}

function materializeShape(tree: ReturnType<typeof createTree>, includeHidden = false): unknown {
  const result = materialize(tree, emptyPatch, { includeHidden });
  assert.notEqual(result.status, "conflict");
  return stripMaterialized(result.materialized);
}

function assertDiffRoundTrip(
  base: ReturnType<typeof createTree>,
  target: ReturnType<typeof createTree>,
  options: Parameters<typeof diffTrees<ContentTypes>>[2] = {},
): TreePatch {
  const patch = diffTrees(base, target, options);
  const applied = applyPatch(base, patch, { includeHidden: false });
  assert.equal(applied.status, "applied");
  assert.deepEqual(stripMaterialized(applied.materialized), materializeShape(target));
  return patch;
}

test("diffTrees returns a deterministic empty patch for equal trees", () => {
  const base = createTree(createBaseDocument("rev-1"));
  const target = createTree(createBaseDocument("rev-1"));

  const first = diffTrees(base, target);
  const second = diffTrees(base, target);

  assert.deepEqual(first, second);
  assert.equal(first.ops.length, 0);
  assert.equal(first.baseRevision, "rev-1");
  assert.match(first.patchId, /^diff:/);
});

test("diffTrees hides missing source-backed nodes by default and can reject that transform", () => {
  const base = createTree(createBaseDocument("rev-1"));
  const target = createTree({
    revision: "rev-1",
    root: {
      ...createBaseDocument("rev-1").root,
      children: [
        createBaseDocument("rev-1").root.children[0]!,
        createBaseDocument("rev-1").root.children[2]!,
      ],
    },
  });

  const patch = assertDiffRoundTrip(base, target);
  assert.deepEqual(
    patch.ops.map((op) => `${op.kind}:${"nodeId" in op ? op.nodeId : ""}`),
    ["hideNode:legal"],
  );

  assert.throws(
    () => diffTrees(base, target, { hideMissingSourceNodes: false }),
    UnsupportedTransformError,
  );
});

test("diffTrees emits removeNode for missing patch-owned nodes", () => {
  const source = createTree(createBaseDocument("rev-1"));
  const inserted = applyPatch(source, {
    format: "tree-patch/v1",
    patchId: "insert-promo",
    ops: [
      {
        kind: "insertNode",
        opId: "promo",
        parentId: "root",
        position: { afterId: "hero" },
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

  const target = createTree(createBaseDocument("rev-1"));
  const patch = assertDiffRoundTrip(inserted.tree, target);

  assert.deepEqual(
    patch.ops.map((op) => `${op.kind}:${"nodeId" in op ? op.nodeId : ""}`),
    ["removeNode:promo"],
  );
});

test("diffTrees uses replaceSubtree for type changes and honors replacement thresholds", () => {
  const base = createTree(createBaseDocument("rev-1"));
  const typeChanged = createTree({
    revision: "rev-1",
    root: {
      id: "root",
      type: "Page",
      attrs: {},
      children: [
        createBaseDocument("rev-1").root.children[0]!,
        {
          id: "legal",
          type: "Section",
          attrs: { label: "Legal" },
          children: [
            {
              id: "legal-note",
              type: "RichText",
              attrs: { html: "<p>FR legal</p>" },
              children: [],
            },
          ],
        },
        createBaseDocument("rev-1").root.children[2]!,
      ],
    },
  });

  const typeChangePatch = assertDiffRoundTrip(base, typeChanged);
  assert.equal(typeChangePatch.ops[0]?.kind, "replaceSubtree");
  assert.equal(
    typeChangePatch.ops[0] && "nodeId" in typeChangePatch.ops[0]
      ? typeChangePatch.ops[0].nodeId
      : undefined,
    "legal",
  );

  const thresholdTarget = createTree({
    revision: "rev-1",
    root: {
      id: "root",
      type: "Page",
      attrs: {},
      children: [
        createBaseDocument("rev-1").root.children[0]!,
        createBaseDocument("rev-1").root.children[1]!,
        {
          id: "section",
          type: "Section",
          attrs: { label: "Localized details" },
          children: [
            {
              id: "section-note",
              type: "RichText",
              attrs: { html: "<p>Nested note</p>" },
              children: [],
            },
          ],
        },
      ],
    },
  });

  const thresholdPatch = assertDiffRoundTrip(base, thresholdTarget, {
    replaceSubtreeWhen: {
      changedAttrCountGte: 1,
    },
  });

  assert.equal(thresholdPatch.ops[0]?.kind, "replaceSubtree");
  assert.equal(
    thresholdPatch.ops[0] && "nodeId" in thresholdPatch.ops[0]
      ? thresholdPatch.ops[0].nodeId
      : undefined,
    "section",
  );
  assert.equal(
    thresholdPatch.ops.some(
      (op) => op.kind === "setAttr" && op.nodeId === "section" && op.path === "/label",
    ),
    false,
  );
});

test("diffTrees falls back to replaceSubtree for unsupported source-backed moves under patch-owned parents", () => {
  const base = createTree(createBaseDocument("rev-1"));
  const target = createTree({
    revision: "rev-1",
    root: {
      id: "root",
      type: "Page",
      attrs: {},
      children: [
        {
          id: "promo",
          type: "Section",
          attrs: { label: "Promo" },
          children: [createBaseDocument("rev-1").root.children[0]!],
        },
        createBaseDocument("rev-1").root.children[1]!,
        createBaseDocument("rev-1").root.children[2]!,
      ],
    },
  });

  const patch = assertDiffRoundTrip(base, target);
  assert.equal(patch.ops[0]?.kind, "replaceSubtree");
  assert.equal(
    patch.ops[0] && "nodeId" in patch.ops[0] ? patch.ops[0].nodeId : undefined,
    "root",
  );

  assert.throws(
    () => diffTrees(base, target, { unsupportedTransformPolicy: "error" }),
    UnsupportedTransformError,
  );
});

test("diffTrees serializes codec-backed values and rejects missing codecs", () => {
  const january = new Date("2025-01-05T00:00:00.000Z");
  const february = new Date("2025-02-10T00:00:00.000Z");
  const base = createTree(createBaseDocument("rev-1", january), schemaWithDateCodec);
  const target = createTree(createBaseDocument("rev-1", february), schemaWithDateCodec);

  const patch = assertDiffRoundTrip(base, target);
  assert.equal(patch.ops.length, 1);
  assert.equal(patch.ops[0]?.kind, "setAttr");
  assert.equal(patch.ops[0] && "nodeId" in patch.ops[0] ? patch.ops[0].nodeId : undefined, "hero");
  assert.equal(patch.ops[0] && "path" in patch.ops[0] ? patch.ops[0].path : undefined, "/publishedAt");
  assert.deepEqual(
    patch.ops[0] && "value" in patch.ops[0] ? patch.ops[0].value : undefined,
    {
      $codec: "date",
      value: "2025-02-10T00:00:00.000Z",
    },
  );
  assert.equal(patch.ops[0]?.guards?.[0]?.kind, "attrHash");

  const baseWithoutCodec = createTree(createBaseDocument("rev-1", january), schemaWithoutDateCodec);
  const targetWithoutCodec = createTree(createBaseDocument("rev-1", february), schemaWithoutDateCodec);
  assert.throws(() => diffTrees(baseWithoutCodec, targetWithoutCodec), MissingCodecError);
});

test("rebasePatch keeps successful ops, skips conflicts, and updates baseRevision", () => {
  const oldBase = createTree(createBaseDocument("rev-1"));
  const newBase = createTree({
    revision: "rev-2",
    root: {
      id: "root",
      type: "Page",
      attrs: {},
      children: [
        {
          id: "hero",
          type: "Hero",
          attrs: {
            title: "Spring Sale",
            image: {
              url: "/img/en.png",
            },
            gallery: ["/gallery/a.png", "/gallery/b.png"],
          },
          children: [],
        },
        createBaseDocument("rev-1").root.children[1]!,
        createBaseDocument("rev-1").root.children[2]!,
      ],
    },
  });

  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "promo-copy",
    baseRevision: "rev-1",
    metadata: { author: "tester" },
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

  const rebased = rebasePatch(oldBase, newBase, patch, { includeHidden: false });
  assert.equal(rebased.revision.status, "mismatch");
  assert.deepEqual(rebased.appliedOpIds, ["legal-copy"]);
  assert.deepEqual(rebased.skippedOpIds, ["hero-title"]);
  assert.equal(rebased.conflicts.length, 1);
  assert.equal(rebased.conflicts[0]?.kind, "GuardFailed");
  assert.equal(rebased.rebasedPatch?.patchId, "promo-copy");
  assert.equal(rebased.rebasedPatch?.baseRevision, "rev-2");
  assert.deepEqual(rebased.rebasedPatch?.metadata, { author: "tester" });
  assert.deepEqual(rebased.rebasedPatch?.ops.map((op) => op.opId), ["legal-copy"]);
  assert.ok(rebased.preview);
  assert.equal(rebased.preview?.nodes.get("hero")?.attrs.title, "Spring Sale");
  assert.equal(rebased.preview?.nodes.get("legal")?.attrs.html, "<p>EU only</p>");
});
