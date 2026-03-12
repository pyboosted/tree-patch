import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePersistedValue,
  defaultJsonValueAdapter,
  encodePersistedValue,
  MissingCodecError,
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

