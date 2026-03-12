import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  createEditor,
  EditorNodeMissingError,
  EditorNodeTypeMismatchError,
  materialize,
  MissingCodecError,
  MissingPatchIdError,
  patchBuilder,
  rebasePatch,
  validatePatch,
  type AnyMaterializedNode,
  type TreeDocument,
  type TreePatch,
  type TreeSchema,
} from "../src/index.js";
import { getPathHash } from "../src/core/hash.js";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    subtitle?: string;
    image: {
      url: string;
      alt?: string;
    };
    style?: {
      fontSize?: number;
    };
    gallery: string[];
    publishedAt?: Date;
  };
  RichText: {
    html: string;
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

const schemaWithCodec = {
  types: {
    Hero: {
      adapters: {
        "/publishedAt": {
          equals: (left: Date, right: Date) => left.getTime() === right.getTime(),
          clone: (value: Date) => new Date(value.getTime()),
          hash: (value: Date) => value.toISOString(),
          codec: dateCodec,
        },
      },
    },
  },
} satisfies TreeSchema<ContentTypes>;

const schemaWithoutCodec = {
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
            subtitle: "Free shipping",
            image: {
              url: "/img/en.png",
              alt: "English hero",
            },
            style: {
              fontSize: 32,
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
      ],
    },
  };
}

function createSourceTree(
  revision = "rev-1",
  publishedAt: Date | undefined = undefined,
  schema: TreeSchema<ContentTypes> = schemaWithCodec,
) {
  return createDocument(createSourceDocument(revision, publishedAt), { schema });
}

function stripMaterialized(node: AnyMaterializedNode<ContentTypes>): unknown {
  return {
    id: node.id,
    type: node.type,
    attrs: node.attrs,
    children: node.children.map((child) => stripMaterialized(child)),
  };
}

function visibleShape(tree: ReturnType<typeof createSourceTree>): unknown {
  const result = materialize(tree, emptyPatch, { includeHidden: false });
  assert.notEqual(result.status, "conflict");
  return stripMaterialized(result.materialized);
}

test("patchBuilder requires patchId and emits deterministic field and visibility ops", () => {
  const builder = patchBuilder<ContentTypes>();
  builder.setAttr("hero", ["title"], "Promotions d'ete", {
    expect: "Summer Sale",
  });
  assert.throws(() => builder.build(), MissingPatchIdError);

  const patch = patchBuilder<ContentTypes>()
    .patchId("fr-home")
    .baseRevision("rev-1")
    .setAttr("hero", ["title"], "Promotions d'ete", {
      expect: "Summer Sale",
    })
    .setAttr("hero", ["image", "url"], "/img/fr.png", {
      expect: "/img/en.png",
    })
    .hideNode("legal")
    .build();

  assert.deepEqual(
    patch.ops.map((op) => op.opId),
    ["set:hero:/title", "set:hero:/image/url", "hide:legal"],
  );
  assert.equal(patch.baseRevision, "rev-1");
  assert.equal(patch.ops[0]?.kind, "setAttr");
  assert.equal(patch.ops[0]?.guards?.[0]?.kind, "attrEquals");
  assert.deepEqual(
    patch.ops[0]?.guards?.[0] && "value" in patch.ops[0].guards[0]
      ? patch.ops[0].guards[0].value
      : undefined,
    "Summer Sale",
  );
  assert.equal(patch.ops[2]?.kind, "hideNode");
  assert.deepEqual(patch.ops[2]?.guards, [{ kind: "nodeExists", nodeId: "legal" }]);
});

test("builder and editor serialize codec-backed values and reject missing codecs", () => {
  const january = new Date("2025-01-05T00:00:00.000Z");
  const february = new Date("2025-02-10T00:00:00.000Z");
  const source = createSourceTree("rev-1", january, schemaWithCodec);

  const fieldPatch = patchBuilder<ContentTypes>({ source, schema: schemaWithCodec })
    .patchId("publish")
    .setAttr("hero", ["publishedAt"], february, {
      expect: january,
    })
    .build();

  assert.deepEqual(fieldPatch.ops, [
    {
      kind: "setAttr",
      opId: "set:hero:/publishedAt",
      nodeId: "hero",
      path: "/publishedAt",
      value: {
        $codec: "date",
        value: "2025-02-10T00:00:00.000Z",
      },
      guards: [
        {
          kind: "attrHash",
          nodeId: "hero",
          path: "/publishedAt",
          hash: getPathHash(source, "hero", "/publishedAt"),
        },
      ],
    },
  ]);

  const insertPatch = patchBuilder<ContentTypes>({ schema: schemaWithCodec })
    .patchId("insert-hero")
    .insertNode("root", {
      id: "promo-hero",
      type: "Hero",
      attrs: {
        title: "Promo",
        image: {
          url: "/img/promo.png",
        },
        gallery: [],
        publishedAt: february,
      },
      children: [],
    })
    .build();

  assert.deepEqual(
    insertPatch.ops[0] && insertPatch.ops[0].kind === "insertNode"
      ? insertPatch.ops[0].node.attrs
      : undefined,
    {
      title: "Promo",
      image: {
        url: "/img/promo.png",
      },
      gallery: [],
      publishedAt: {
        $codec: "date",
        value: "2025-02-10T00:00:00.000Z",
      },
    },
  );

  assert.throws(
    () =>
      patchBuilder<ContentTypes>({ schema: schemaWithoutCodec })
        .patchId("bad-insert")
        .insertNode("root", {
          id: "bad-hero",
          type: "Hero",
          attrs: {
            title: "Bad",
            image: { url: "/img/bad.png" },
            gallery: [],
            publishedAt: february,
          },
          children: [],
        }),
    MissingCodecError,
  );

  assert.throws(
    () =>
      patchBuilder<ContentTypes>({
        source: createSourceTree("rev-1", january, schemaWithoutCodec),
        schema: schemaWithoutCodec,
      })
        .patchId("bad-replace")
        .replaceSubtree("hero", {
          id: "hero",
          type: "Hero",
          attrs: {
            title: "Localized",
            image: { url: "/img/localized.png" },
            gallery: [],
            publishedAt: february,
          },
          children: [],
        }),
    MissingCodecError,
  );
});

test("createEditor validates node handles and can continue editing inserted nodes", () => {
  const source = createSourceTree();
  assert.throws(() => createEditor(source).node("missing", "Hero"), EditorNodeMissingError);
  assert.throws(() => createEditor(source).node("legal", "Hero"), EditorNodeTypeMismatchError);

  const editor = createEditor(source);
  editor.patchId("promo-flow");
  editor.node("root", "Page").insert(
    {
      id: "promo",
      type: "RichText",
      attrs: {
        html: "<p>Promo</p>",
      },
      children: [],
    },
    { afterId: "hero" },
  );
  editor.node("promo", "RichText").set(["html"], "<p>Updated promo</p>", {
    expect: "<p>Promo</p>",
  });

  const patch = editor.build();
  assert.deepEqual(
    patch.ops.map((op) => op.opId),
    ["insert:promo", "set:promo:/html"],
  );

  const result = applyPatch(source, patch, { includeHidden: false });
  assert.equal(result.status, "applied");
  assert.equal(result.materialized.children[1]?.id, "promo");
  assert.equal(result.tree.nodes.get("promo")?.attrs.html, "<p>Updated promo</p>");
});

test("editor-built workflow round-trips and rebase stays field-scoped", () => {
  const source = createSourceTree("rev-1");
  const editor = createEditor(source);
  editor.patchId("fr-FR:home");
  editor.node("hero", "Hero").set(["title"], "Promotions d'ete", {
    expect: "Summer Sale",
  });
  editor.node("hero", "Hero").set(["image", "url"], "/img/fr.png", {
    expect: "/img/en.png",
  });
  editor.node("hero", "Hero").set(["style", "fontSize"], 28, {
    expect: 32,
  });
  editor.node("legal", "RichText").hide();
  const patch = editor.build();

  const applied = applyPatch(source, patch, { includeHidden: false });
  assert.equal(applied.status, "applied");
  assert.deepEqual(stripMaterialized(applied.materialized), {
    id: "root",
    type: "Page",
    attrs: {},
    children: [
      {
        id: "hero",
        type: "Hero",
        attrs: {
          title: "Promotions d'ete",
          subtitle: "Free shipping",
          image: {
            url: "/img/fr.png",
            alt: "English hero",
          },
          style: {
            fontSize: 28,
          },
          gallery: ["/gallery/a.png", "/gallery/b.png"],
        },
        children: [],
      },
    ],
  });

  const unrelatedBase = createDocument<ContentTypes>({
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
            title: "Summer Sale",
            subtitle: "Free delivery worldwide",
            image: {
              url: "/img/en.png",
              alt: "English hero",
            },
            style: {
              fontSize: 32,
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
      ],
    },
  }, { schema: schemaWithCodec });

  const rebasedUnrelated = rebasePatch(source, unrelatedBase, patch, { includeHidden: false });
  assert.equal(rebasedUnrelated.conflicts.length, 0);
  assert.deepEqual(rebasedUnrelated.appliedOpIds, patch.ops.map((op) => op.opId));
  assert.equal(rebasedUnrelated.rebasedPatch?.baseRevision, "rev-2");

  const conflictBase = createDocument<ContentTypes>({
    revision: "rev-3",
    root: {
      id: "root",
      type: "Page",
      attrs: {},
      children: [
        {
          id: "hero",
          type: "Hero",
          attrs: {
            title: "Big Summer Sale",
            subtitle: "Free shipping",
            image: {
              url: "/img/en.png",
              alt: "English hero",
            },
            style: {
              fontSize: 32,
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
      ],
    },
  }, { schema: schemaWithCodec });

  const rebasedConflict = rebasePatch(source, conflictBase, patch, { includeHidden: false });
  assert.equal(rebasedConflict.conflicts.length, 1);
  assert.equal(rebasedConflict.conflicts[0]?.opId, "set:hero:/title");
  assert.equal(rebasedConflict.preview?.nodes.get("hero")?.attrs.image.url, "/img/fr.png");
  assert.equal(rebasedConflict.preview?.nodes.get("hero")?.attrs.style?.fontSize, 28);
});

test("repeated validate/apply cycles with builder patches do not mutate source or leak stale results", () => {
  const source = createSourceTree("rev-1");
  const built = createEditor(source, { patchId: "cache-check" });
  built.node("hero", "Hero").set(["image", "url"], "/img/fr.png", { expect: "/img/en.png" });
  built.node("legal", "RichText").hide();
  const treePatch = built.build();

  const sourceTitleHash = getPathHash(source, "hero", "/title");
  const validationA = validatePatch(source, treePatch);
  const validationB = validatePatch(source, treePatch);
  assert.equal(validationA.status, "valid");
  assert.equal(validationB.status, "valid");

  const appliedA = applyPatch(source, treePatch, { includeHidden: false });
  const appliedB = applyPatch(source, treePatch, { includeHidden: false });
  assert.equal(appliedA.status, "applied");
  assert.equal(appliedB.status, "applied");
  assert.deepEqual(stripMaterialized(appliedA.materialized), stripMaterialized(appliedB.materialized));
  assert.deepEqual(visibleShape(source), {
    id: "root",
    type: "Page",
    attrs: {},
    children: [
      {
        id: "hero",
        type: "Hero",
        attrs: {
          title: "Summer Sale",
          subtitle: "Free shipping",
          image: {
            url: "/img/en.png",
            alt: "English hero",
          },
          style: {
            fontSize: 32,
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
    ],
  });
  assert.equal(getPathHash(source, "hero", "/title"), sourceTitleHash);
});
