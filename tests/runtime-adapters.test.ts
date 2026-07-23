import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
  patchBuilder,
  type TreeSchema,
} from "../src/index.js";

type RuntimeTypes = {
  Event: {
    label: string;
    when: Date;
  };
  Boxed: {
    box: {
      label: string;
      when: Date;
    };
  };
};

const dateSchema = {
  types: {
    Event: {
      adapters: {
        "/when": {
          equals: (left: Date, right: Date) => left.getTime() === right.getTime(),
          clone: (value: Date) => new Date(value.getTime()),
          hash: (value: Date) => value.toISOString(),
          codec: {
            codecId: "date",
            serialize: (value: Date) => value.toISOString(),
            deserialize: (value: string) => new Date(value),
          },
        },
      },
    },
  },
} satisfies TreeSchema<RuntimeTypes>;

function eventTree(when: Date) {
  return createDocument<RuntimeTypes>(
    {
      root: {
        id: "root",
        type: "Event",
        attrs: { label: "launch", when },
        children: [],
      },
    },
    { schema: dateSchema },
  );
}

test("clone ownership never exposes mutable adapter values from snapshots or materialization", () => {
  const original = new Date("2026-01-02T03:04:05.000Z");
  const tree = eventTree(original);
  original.setUTCFullYear(1999);

  const exposed = tree.nodes.get("root")!.attrs.when;
  exposed.setUTCFullYear(2000);
  assert.equal(
    tree.nodes.get("root")!.attrs.when.toISOString(),
    "2026-01-02T03:04:05.000Z",
  );

  const result = applyPatch(tree, {
    format: "tree-patch/v1",
    patchId: "empty",
    ops: [],
  });
  assert.equal(result.status, "applied");
  result.materialized.attrs.when.setUTCFullYear(2001);
  assert.equal(
    result.tree.nodes.get("root")!.attrs.when.toISOString(),
    "2026-01-02T03:04:05.000Z",
  );
  assert.equal(diffTrees(tree, eventTree(new Date("2026-01-02T03:04:05.000Z"))).ops.length, 0);
});

test("custom equals without hash controls diff and builder guards", () => {
  type LabelTypes = {
    Label: {
      value: string;
    };
  };
  const schema = {
    types: {
      Label: {
        adapters: {
          "/value": {
            equals: (left: string, right: string) =>
              left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US"),
            clone: (value: string) => value,
          },
        },
      },
    },
  } satisfies TreeSchema<LabelTypes>;
  const makeTree = (value: string) =>
    createDocument<LabelTypes>(
      {
        root: {
          id: "root",
          type: "Label",
          attrs: { value },
          children: [],
        },
      },
      { schema },
    );

  const base = makeTree("Alpha");
  assert.deepEqual(diffTrees(base, makeTree("alpha")).ops, []);

  const patch = patchBuilder<LabelTypes>({
    source: base,
    patchId: "semantic-expect",
  })
    .node("root", "Label")
    .set(["value"], "Beta", { expect: "ALPHA" })
    .build();

  assert.equal(patch.ops[0]?.guards?.[0]?.kind, "attrEquals");
  const applied = applyPatch(base, patch);
  assert.equal(applied.status, "applied");
  assert.equal(applied.materialized.attrs.value, "Beta");
});

test("a codec registered for a whole plain object owns its persisted representation", () => {
  type Box = RuntimeTypes["Boxed"]["box"];
  const schema = {
    types: {
      Boxed: {
        adapters: {
          "/box": {
            equals: (left: Box, right: Box) =>
              left.label === right.label && left.when.getTime() === right.when.getTime(),
            clone: (value: Box) => ({
              label: value.label,
              when: new Date(value.when.getTime()),
            }),
            hash: (value: Box) => `${value.label}:${value.when.toISOString()}`,
            codec: {
              codecId: "dated-box",
              serialize: (value: Box) => ({
                label: value.label,
                when: value.when.toISOString(),
              }),
              deserialize: (value: { label: string; when: string }) => ({
                label: value.label,
                when: new Date(value.when),
              }),
            },
          },
        },
      },
    },
  } satisfies TreeSchema<RuntimeTypes>;
  const source = createDocument<RuntimeTypes>(
    {
      root: {
        id: "root",
        type: "Boxed",
        attrs: {
          box: {
            label: "before",
            when: new Date("2026-01-01T00:00:00.000Z"),
          },
        },
        children: [],
      },
    },
    { schema },
  );
  const nextBox: Box = {
    label: "after",
    when: new Date("2026-02-01T00:00:00.000Z"),
  };

  const patch = patchBuilder<RuntimeTypes>({
    source,
    patchId: "whole-value-codec",
  })
    .node("root", "Boxed")
    .set(["box"], nextBox)
    .build();

  assert.deepEqual(patch.ops[0] && "value" in patch.ops[0] ? patch.ops[0].value : undefined, {
    $codec: "dated-box",
    value: {
      label: "after",
      when: "2026-02-01T00:00:00.000Z",
    },
  });

  const applied = applyPatch(source, patch);
  assert.equal(applied.status, "applied");
  assert.equal(applied.materialized.attrs.box.label, "after");
  assert.equal(
    applied.materialized.attrs.box.when.toISOString(),
    "2026-02-01T00:00:00.000Z",
  );
});
