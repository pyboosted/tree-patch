import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
  MalformedPatchError,
  MalformedTreeError,
  patchBuilder,
  UnsupportedRuntimeValueError,
  type JsonValue,
  type TreePatch,
} from "../src/index.js";
import { getPathHash } from "../src/core/hash.js";

type JsonNodeTypes = {
  Json: Record<string, JsonValue>;
};

function createJsonTree(attrs: Record<string, JsonValue> = {}) {
  return createDocument<JsonNodeTypes>({
    root: {
      id: "root",
      type: "Json",
      attrs,
      children: [],
    },
  });
}

test("readonly map views expose Map reads without leaking mutable backing maps", () => {
  const tree = createJsonTree({ object: { value: 1 } });

  assert.equal(tree.nodes.size, 1);
  assert.deepEqual([...tree.nodes.keys()], ["root"]);

  let callbackMap: ReadonlyMap<string, unknown> | undefined;
  tree.nodes.forEach((_node, _nodeId, map) => {
    callbackMap = map;
  });
  assert.equal(callbackMap, tree.nodes);
  assert.throws(
    () => (callbackMap as Map<string, unknown>).clear(),
    /read-only Map view/i,
  );
  assert.equal(tree.nodes.has("root"), true);

  getPathHash(tree, "root", "/object");
  const pathHashes = tree.cache.pathHashByNodeId.get("root");
  assert.ok(pathHashes);
  assert.throws(
    () => (pathHashes as Map<string, string>).set("/object", "poisoned"),
    /read-only Map view/i,
  );
  assert.notEqual(pathHashes.get("/object"), "poisoned");
});

test("JSON object keys are own data properties throughout clone, diff, and apply", () => {
  const attrs = JSON.parse(
    '{"__proto__":{"polluted":true},"toString":"local"}',
  ) as Record<string, JsonValue>;
  const target = createJsonTree(attrs);
  const targetAttrs = target.nodes.get("root")!.attrs;

  assert.equal(Object.hasOwn(targetAttrs, "__proto__"), true);
  assert.equal(Object.hasOwn(targetAttrs, "toString"), true);
  assert.deepEqual(targetAttrs.__proto__, { polluted: true });
  assert.equal(targetAttrs.toString, "local");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  const base = createJsonTree();
  const patch = diffTrees(base, target);
  const applied = applyPatch(base, patch);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") {
    assert.deepEqual(applied.tree.nodes.get("root")?.attrs, targetAttrs);
  }
});

test("codec-shaped JSON user data round-trips through diff and apply", () => {
  const payload = {
    $codec: "user-tag",
    value: {
      ok: true,
    },
  };
  const base = createJsonTree();
  const target = createJsonTree({ payload });
  const patch = JSON.parse(
    JSON.stringify(diffTrees(base, target)),
  ) as TreePatch;

  assert.deepEqual(
    patch.ops[0]?.kind === "setAttr" ? patch.ops[0].value : undefined,
    {
      $codec: "$tree-patch/json",
      value: payload,
    },
  );

  const applied = applyPatch(base, patch);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") {
    assert.deepEqual(
      applied.tree.nodes.get("root")?.attrs.payload,
      payload,
    );
  }
});

test("inherited object properties do not resolve as attribute paths", () => {
  const source = createJsonTree();
  const patch: TreePatch = {
    format: "tree-patch/v1",
    patchId: "remove-inherited",
    ops: [
      {
        kind: "removeAttr",
        opId: "remove-to-string",
        nodeId: "root",
        path: "/toString",
      },
    ],
  };

  const result = applyPatch(source, patch);
  assert.equal(result.status, "conflict");
  if (result.status === "conflict") {
    assert.equal(result.conflicts[0]?.kind, "PathInvalid");
  }
});

test("document and patch metadata stay JSON-only and isolated from caller mutation", () => {
  const metadata = {
    locale: "en",
    nested: {
      tags: ["draft"],
    },
  };
  const tree = createDocument<JsonNodeTypes>({
    metadata,
    root: {
      id: "root",
      type: "Json",
      attrs: {},
      children: [],
    },
  });

  metadata.nested.tags.push("mutated");
  assert.deepEqual(tree.metadata, {
    locale: "en",
    nested: {
      tags: ["draft"],
    },
  });
  assert.throws(
    () => (tree.metadata!.nested as { tags: string[] }).tags.push("blocked"),
    TypeError,
  );

  const patchMetadata = {
    nested: {
      labels: ["one"],
    },
  };
  const patch = patchBuilder<JsonNodeTypes>({
    source: tree,
    patchId: "metadata",
    metadata: patchMetadata,
  }).build();
  patchMetadata.nested.labels.push("mutated");
  assert.deepEqual(patch.metadata, {
    nested: {
      labels: ["one"],
    },
  });

  assert.throws(
    () =>
      createDocument<JsonNodeTypes>({
        metadata: { invalid: new Date() } as never,
        root: {
          id: "root",
          type: "Json",
          attrs: {},
          children: [],
        },
      }),
    MalformedTreeError,
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () =>
      applyPatch(tree, {
        format: "tree-patch/v1",
        patchId: "cyclic-metadata",
        metadata: cyclic as never,
        ops: [],
      }),
    MalformedPatchError,
  );
});

test("codecs must serialize runtime values to JSON", () => {
  assert.throws(
    () =>
      createDocument<{
        Runtime: { value: Date };
      }>(
        {
          root: {
            id: "root",
            type: "Runtime",
            attrs: { value: new Date() },
            children: [],
          },
        },
        {
          schema: {
            types: {
              Runtime: {
                adapters: {
                  "/value": {
                    equals: Object.is,
                    codec: {
                      codecId: "invalid",
                      serialize: (() => new Date()) as never,
                      deserialize: () => new Date(),
                    },
                  },
                },
              },
            },
          },
        },
      ),
    UnsupportedRuntimeValueError,
  );
});
