import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPatch,
  createDocument,
  diffTrees,
  patchBuilder,
  type TreePatch,
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
  Schedule: {
    dates: Date[];
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

test("equal subtree hashes bypass broader adapter equality", () => {
  type LabelTypes = {
    Label: { value: string };
  };
  let equalsCount = 0;
  const schema = {
    types: {
      Label: {
        adapters: {
          "/value": {
            equals: (left: string, right: string) => {
              equalsCount += 1;
              return left.toLowerCase() === right.toLowerCase();
            },
            clone: (value: string) => value,
          },
        },
      },
    },
  } satisfies TreeSchema<LabelTypes>;
  const makeTree = () => createDocument<LabelTypes>({
    root: {
      id: "root",
      type: "Label",
      attrs: { value: "Alpha" },
      children: [],
    },
  }, { schema });
  const base = makeTree();
  const target = makeTree();
  equalsCount = 0;

  assert.deepEqual(diffTrees(base, target).ops, []);
  assert.equal(equalsCount, 0);
});

test("diff reads adapter-backed values from internal state without defensive clones", () => {
  type EventTypes = {
    Event: { when: Date };
  };
  let cloneCount = 0;
  const schema = {
    types: {
      Event: {
        adapters: {
          "/when": {
            equals: (left: Date, right: Date) =>
              left.getTime() === right.getTime(),
            hash: (value: Date) => value.toISOString(),
            clone: (value: Date) => {
              cloneCount += 1;
              return new Date(value.getTime());
            },
            codec: {
              codecId: "date",
              serialize: (value: Date) => value.toISOString(),
              deserialize: (value: string) => new Date(value),
            },
          },
        },
      },
    },
  } satisfies TreeSchema<EventTypes>;
  const makeTree = (day: string) => createDocument<EventTypes>({
    root: {
      id: "root",
      type: "Event",
      attrs: { when: new Date(`2026-07-${day}T00:00:00.000Z`) },
      children: [],
    },
  }, { schema });
  const base = makeTree("22");
  const target = makeTree("23");
  cloneCount = 0;

  const patch = diffTrees(base, target);
  assert.equal(patch.ops.length, 1);
  assert.equal(cloneCount, 0);
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

test("container setAttr operations recursively decode nested codec values", () => {
  const schema = {
    types: {
      Schedule: {
        adapters: {
          "/dates/0": {
            equals: (left: Date, right: Date) =>
              left.getTime() === right.getTime(),
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
  const makeTree = (iso: string) => createDocument<RuntimeTypes>({
    root: {
      id: "root",
      type: "Schedule",
      attrs: {
        dates: [new Date(iso)],
      },
      children: [],
    },
  }, { schema });
  const source = makeTree("2026-01-01T00:00:00.000Z");
  const target = makeTree("2026-02-01T00:00:00.000Z");

  const diffPatch = diffTrees(source, target);
  assert.deepEqual(diffPatch.ops[0] && "value" in diffPatch.ops[0]
    ? diffPatch.ops[0].value
    : undefined, [{
    $codec: "date",
    value: "2026-02-01T00:00:00.000Z",
  }]);

  const diffApplied = applyPatch(source, diffPatch);
  assert.equal(diffApplied.status, "applied");
  assert.equal(diffApplied.materialized.type, "Schedule");
  if (diffApplied.materialized.type === "Schedule") {
    assert.ok(diffApplied.materialized.attrs.dates[0] instanceof Date);
    assert.equal(
      diffApplied.materialized.attrs.dates[0]?.toISOString(),
      "2026-02-01T00:00:00.000Z",
    );
  }

  const wholeAttrsPatch = patchBuilder<RuntimeTypes>({
    source,
    patchId: "whole-schedule",
  })
    .node("root", "Schedule")
    .set([], {
      dates: [new Date("2026-03-01T00:00:00.000Z")],
    })
    .build();
  const wholeAttrsApplied = applyPatch(source, wholeAttrsPatch);
  assert.equal(wholeAttrsApplied.status, "applied");
  assert.equal(wholeAttrsApplied.materialized.type, "Schedule");
  if (wholeAttrsApplied.materialized.type === "Schedule") {
    assert.equal(
      wholeAttrsApplied.materialized.attrs.dates[0]?.toISOString(),
      "2026-03-01T00:00:00.000Z",
    );
  }
});

test("container adapters clone after nested codec values are decoded", () => {
  const dateAdapter = {
    equals: (left: Date, right: Date) =>
      left.getTime() === right.getTime(),
    clone: (value: Date) => new Date(value.getTime()),
    hash: (value: Date) => value.toISOString(),
    codec: {
      codecId: "date",
      serialize: (value: Date) => value.toISOString(),
      deserialize: (value: string) => new Date(value),
    },
  };
  const schema = {
    types: {
      Schedule: {
        adapters: {
          "/dates": {
            equals: (left: Date[], right: Date[]) =>
              left.length === right.length &&
              left.every((value, index) =>
                value.getTime() === right[index]?.getTime()),
            clone: (value: Date[]) =>
              value.map((date) => new Date(date.getTime())),
            hash: (value: Date[]) =>
              JSON.stringify(value.map((date) => date.toISOString())),
          },
          "/dates/0": dateAdapter,
        },
      },
    },
  } satisfies TreeSchema<RuntimeTypes>;
  const makeTree = (iso: string) => createDocument<RuntimeTypes>({
    root: {
      id: "root",
      type: "Schedule",
      attrs: {
        dates: [new Date(iso)],
      },
      children: [],
    },
  }, { schema });
  const source = makeTree("2026-01-01T00:00:00.000Z");
  const patch = diffTrees(
    source,
    makeTree("2026-02-01T00:00:00.000Z"),
  );

  assert.deepEqual(patch.ops[0] && "value" in patch.ops[0]
    ? patch.ops[0].value
    : undefined, [{
    $codec: "date",
    value: "2026-02-01T00:00:00.000Z",
  }]);

  const setDates = patch.ops[0];
  assert.equal(setDates?.kind, "setAttr");
  if (!setDates || setDates.kind !== "setAttr") {
    throw new Error("Expected a setAttr operation.");
  }
  const guardedPatch = {
    ...patch,
    ops: [{
      ...setDates,
      guards: [{
        kind: "attrEquals",
        nodeId: "root",
        path: "/dates",
        value: [{
          $codec: "date",
          value: "2026-01-01T00:00:00.000Z",
        }],
      }],
    }],
  } satisfies TreePatch;

  const applied = applyPatch(source, guardedPatch);
  assert.equal(applied.status, "applied");
  assert.equal(applied.materialized.type, "Schedule");
  if (applied.materialized.type === "Schedule") {
    assert.ok(applied.materialized.attrs.dates[0] instanceof Date);
    assert.equal(
      applied.materialized.attrs.dates[0]?.toISOString(),
      "2026-02-01T00:00:00.000Z",
    );
  }
});
