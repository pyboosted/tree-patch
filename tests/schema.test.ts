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
  assert.equal(getValueAdapterForPointer(schema, "Hero", "/image/url"), urlAdapter);
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

