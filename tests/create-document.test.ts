import assert from "node:assert/strict";
import test from "node:test";

import {
  createDocument,
  DuplicateIdError,
  InvalidRootError,
  MalformedTreeError,
  UnsupportedRuntimeValueError,
} from "../src/index.js";

type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    image: {
      url: string;
    };
  };
  RichText: {
    html: string;
  };
};

function createSource() {
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
          id: "legal",
          type: "RichText",
          attrs: {
            html: "<p>US only</p>",
          },
          children: [],
        },
      ],
    },
  } satisfies Parameters<typeof createDocument<ContentTypes>>[0];
}

test("createDocument normalizes the tree, builds indexes, and clones by default", () => {
  const source = createSource();
  const tree = createDocument<ContentTypes>(source);

  assert.equal(tree.rootId, "root");
  assert.equal(tree.index.parentById.get("root"), null);
  assert.equal(tree.index.parentById.get("hero"), "root");
  assert.equal(tree.index.positionById.get("legal"), 1);
  assert.equal(tree.index.depthById.get("hero"), 1);

  const heroNode = tree.nodes.get("hero");
  assert.ok(heroNode);
  assert.deepEqual(heroNode.attrs, {
    title: "Summer Sale",
    image: {
      url: "/img/en.png",
    },
  });
  assert.deepEqual(heroNode.childIds, []);
  assert.equal(typeof tree.revision, "string");
  assert.ok(tree.revision);

  source.root.children[0]!.attrs.title = "Big Summer Sale";
  source.root.children[0]!.attrs.image.url = "/img/changed.png";

  assert.equal(heroNode.attrs.title, "Summer Sale");
  assert.equal(heroNode.attrs.image.url, "/img/en.png");

  assert.throws(() => {
    (tree.nodes as Map<string, unknown>).set("other", { id: "other" });
  }, /read-only Map view/i);
});

test("createDocument rejects duplicate node ids deterministically", () => {
  const source = createSource();
  source.root.children.push({
    id: "hero",
    type: "RichText",
    attrs: {
      html: "<p>Duplicate</p>",
    },
    children: [],
  });

  assert.throws(() => createDocument<ContentTypes>(source), (error: unknown) => {
    assert.ok(error instanceof DuplicateIdError);
    assert.equal(error.code, "DUPLICATE_ID");
    return true;
  });
});

test("createDocument rejects malformed root shape and unsupported envelope keys", () => {
  assert.throws(
    () => createDocument<ContentTypes>({ root: null as unknown as ContentTypes["Page"] }),
    InvalidRootError,
  );

  const malformed = createSource();
  (malformed.root.children[0] as Record<string, unknown>).extra = "not-allowed";

  assert.throws(() => createDocument<ContentTypes>(malformed), (error: unknown) => {
    assert.ok(error instanceof MalformedTreeError);
    assert.equal(error.code, "MALFORMED_TREE");
    return true;
  });
});

test("createDocument rejects cyclic trees as malformed input", () => {
  const root = {
    id: "root",
    type: "Page",
    attrs: {},
    children: [] as unknown[],
  };
  root.children.push(root);

  assert.throws(
    () => createDocument<ContentTypes>({ root: root as unknown as Parameters<typeof createDocument<ContentTypes>>[0]["root"] }),
    MalformedTreeError,
  );
});

test("createDocument rejects cyclic attribute values with a typed runtime error", () => {
  const attrs: Record<string, unknown> = {};
  attrs.self = attrs;

  assert.throws(
    () =>
      createDocument<{
        Page: Record<string, unknown>;
      }>({
        root: {
          id: "root",
          type: "Page",
          attrs,
          children: [],
        },
      }),
    UnsupportedRuntimeValueError,
  );
});

test("deep structural chains are indexed without consuming the call stack", () => {
  type DeepTypes = {
    Deep: { depth: number };
  };
  const root = {
    id: "node-0",
    type: "Deep" as const,
    attrs: { depth: 0 },
    children: [] as unknown[],
  };
  let current = root;
  for (let depth = 1; depth <= 10_000; depth += 1) {
    const child = {
      id: `node-${depth}`,
      type: "Deep" as const,
      attrs: { depth },
      children: [] as unknown[],
    };
    current.children.push(child);
    current = child;
  }

  const tree = createDocument<DeepTypes>({ root } as never);
  assert.equal(tree.nodes.size, 10_001);
  assert.equal(tree.index.depthById.get("node-10000"), 10_000);
  assert.match(tree.revision!, /^tree:/);
});

test("duplicate ids are detected even when a descendant repeats an ancestor id", () => {
  assert.throws(
    () =>
      createDocument<ContentTypes>({
        root: {
          id: "root",
          type: "Page",
          attrs: {},
          children: [
            {
              id: "root",
              type: "Page",
              attrs: {},
              children: [],
            },
          ],
        },
      }),
    DuplicateIdError,
  );
});
