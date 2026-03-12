import assert from "node:assert/strict";
import test from "node:test";

import {
  createDocument,
  DuplicateIdError,
  InvalidRootError,
  MalformedTreeError,
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
