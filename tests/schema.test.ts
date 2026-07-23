import assert from "node:assert/strict";
import test from "node:test";

import { InvalidPointerError, InvalidSchemaError } from "../src/index.js";
import {
  compileTreeSchema,
  getValueAdapterForPointer,
  isAtomicPointer,
} from "../src/schema/schema.js";

type SchemaTypes = {
  Hero: {
    image: {
      url: string;
    };
    blob: {
      version: number;
      flags: {
        featured: boolean;
      };
    };
  };
};

test("compileTreeSchema registers atomic paths and per-pointer adapters", () => {
  const urlAdapter = {
    equals: Object.is,
    clone: (value: string) => value,
  };

  const schema = compileTreeSchema<SchemaTypes>({
    types: {
      Hero: {
        atomicPaths: [["blob"]],
        adapters: {
          "/image/url": urlAdapter,
        },
      },
    },
  });

  assert.equal(isAtomicPointer(schema, "Hero", "/blob"), true);
  assert.deepEqual(getValueAdapterForPointer(schema, "Hero", "/image/url"), urlAdapter);
  assert.notEqual(getValueAdapterForPointer(schema, "Hero", "/image/url"), urlAdapter);
  assert.equal(getValueAdapterForPointer(schema, "Hero", "/missing"), undefined);
});

test("compileTreeSchema rejects overlapping atomic paths", () => {
  assert.throws(
    () =>
      compileTreeSchema<SchemaTypes>({
        types: {
          Hero: {
            atomicPaths: [["blob"], ["blob", "flags"]],
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidSchemaError);
      assert.equal(error.code, "INVALID_SCHEMA");
      return true;
    },
  );
});

test("compileTreeSchema rejects malformed adapter pointers", () => {
  assert.throws(
    () =>
      compileTreeSchema<SchemaTypes>({
        types: {
          Hero: {
            adapters: {
              badPointer: {
                equals: Object.is,
              },
            } as Record<string, { equals(a: unknown, b: unknown): boolean }>,
          },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidPointerError);
      assert.equal(error.code, "INVALID_POINTER");
      return true;
    },
  );
});

test("compiled schemas are immutable snapshots of validated descriptors", () => {
  const mutableAdapter = {
    equals: Object.is,
    clone: (value: string) => value,
    codec: {
      codecId: "text",
      serialize: (value: string) => value,
      deserialize: (value: string) => value,
    },
  };
  const atomicPaths: Array<readonly ["blob"]> = [["blob"]];
  const schema = compileTreeSchema<SchemaTypes>({
    types: {
      Hero: {
        atomicPaths,
        adapters: {
          "/image/url": mutableAdapter,
        },
      },
    },
  });
  const compiledAdapter = getValueAdapterForPointer(schema, "Hero", "/image/url")!;

  mutableAdapter.equals = () => false;
  mutableAdapter.codec.codecId = "changed";
  atomicPaths.length = 0;

  assert.equal(compiledAdapter.equals("same", "same"), true);
  assert.equal(compiledAdapter.codec?.codecId, "text");
  assert.equal(isAtomicPointer(schema, "Hero", "/blob"), true);
  assert.throws(() => (schema.types as Map<string, unknown>).clear(), TypeError);
  assert.throws(
    () =>
      (schema.types.get("Hero")!.adapters as Map<string, unknown>).set(
        "/other",
        mutableAdapter,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      (schema.types.get("Hero")!.atomicPointerSet as Set<string>).add("/other"),
    TypeError,
  );
});

test("compileTreeSchema rejects malformed adapter descriptors", () => {
  const invalidAdapters: unknown[] = [
    {},
    { equals: true },
    { equals: Object.is, hash: "not-a-function" },
    { equals: Object.is, clone: "not-a-function" },
    { equals: Object.is, codec: {} },
    {
      equals: Object.is,
      codec: {
        codecId: "",
        serialize: (value: string) => value,
        deserialize: (value: string) => value,
      },
    },
  ];

  for (const adapter of invalidAdapters) {
    assert.throws(
      () =>
        compileTreeSchema<SchemaTypes>({
          types: {
            Hero: {
              adapters: {
                "/image/url": adapter,
              },
            },
          },
        } as never),
      InvalidSchemaError,
    );
  }
});
