import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePersistedValue,
  defaultJsonValueAdapter,
  encodePersistedValue,
  MissingCodecError,
  UnsupportedRuntimeValueError,
} from "../src/index.js";

const dateCodec = {
  codecId: "date",
  serialize(value: Date) {
    return value.toISOString();
  },
  deserialize(value: string) {
    return new Date(value);
  },
};

test("default JSON adapter uses deterministic equality, hashing, and cloning", () => {
  const left = {
    b: 1,
    a: ["x", "y"],
  } as const;
  const right = {
    a: ["x", "y"],
    b: 1,
  } as const;

  assert.equal(defaultJsonValueAdapter.equals(left, right), true);
  assert.equal(defaultJsonValueAdapter.hash?.(left), defaultJsonValueAdapter.hash?.(right));

  const clone = defaultJsonValueAdapter.clone?.(left);
  assert.deepEqual(clone, left);
  assert.notEqual(clone, left);
});

test("persisted values pass JSON through and use codecs for non-JSON values", () => {
  const jsonValue = { title: "Hello", flags: [true, false] };
  const encodedJson = encodePersistedValue(jsonValue);
  assert.deepEqual(encodedJson, jsonValue);
  assert.notEqual(encodedJson, jsonValue);

  const encodedDate = encodePersistedValue(new Date("2026-03-12T00:00:00.000Z"), {
    equals: (left, right) => left.getTime() === right.getTime(),
    codec: dateCodec,
  });

  assert.deepEqual(encodedDate, {
    $codec: "date",
    value: "2026-03-12T00:00:00.000Z",
  });

  const decodedDate = decodePersistedValue(encodedDate, [dateCodec]);
  assert.ok(decodedDate instanceof Date);
  assert.equal(decodedDate.toISOString(), "2026-03-12T00:00:00.000Z");

  const nested = decodePersistedValue({
    event: {
      at: encodedDate,
    },
  }, [dateCodec]) as { event: { at: Date } };
  assert.ok(nested.event.at instanceof Date);
  assert.equal(nested.event.at.toISOString(), "2026-03-12T00:00:00.000Z");
});

test("persisted values reject missing or unknown codecs", () => {
  assert.throws(
    () =>
      encodePersistedValue(new Date("2026-03-12T00:00:00.000Z"), {
        equals: (left, right) => left.getTime() === right.getTime(),
      }),
    MissingCodecError,
  );

  assert.throws(
    () =>
      decodePersistedValue(
        {
          $codec: "missing",
          value: "2026-03-12T00:00:00.000Z",
        },
        [dateCodec],
      ),
    MissingCodecError,
  );
});

test("the reserved codec envelope shape is not treated as ordinary JSON user data", () => {
  assert.throws(
    () =>
      decodePersistedValue({
        $codec: "plain-json-looking-object",
        value: {
          title: "Hello",
        },
      }),
    MissingCodecError,
  );
});

test("default JSON operations are stack-safe and reject cyclic input explicitly", () => {
  let deep: Record<string, unknown> = { value: "leaf" };
  for (let depth = 0; depth < 20_000; depth += 1) {
    deep = { next: deep };
  }

  const clone = defaultJsonValueAdapter.clone!(deep as never) as Record<string, unknown>;
  assert.equal(defaultJsonValueAdapter.equals(deep as never, clone as never), true);
  assert.equal(
    defaultJsonValueAdapter.hash!(deep as never),
    defaultJsonValueAdapter.hash!(clone as never),
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => defaultJsonValueAdapter.clone!(cyclic as never),
    UnsupportedRuntimeValueError,
  );
  assert.throws(
    () => defaultJsonValueAdapter.hash!(cyclic as never),
    UnsupportedRuntimeValueError,
  );
});
