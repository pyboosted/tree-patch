import assert from "node:assert/strict";
import test from "node:test";

import { InvalidPointerError, pathToPointer, pointerToPath } from "../src/index.js";
import { resolvePointer } from "../src/schema/pointers.js";

test("pathToPointer and pointerToPath round-trip representative object and array paths", () => {
  assert.equal(pathToPointer(["hero", "image", "url"]), "/hero/image/url");
  assert.equal(pathToPointer(["items", 0, "title"]), "/items/0/title");

  assert.deepEqual(pointerToPath("/hero/image/url"), ["hero", "image", "url"]);
  assert.deepEqual(pointerToPath("/items/0/title"), ["items", 0, "title"]);
  assert.deepEqual(pointerToPath(pathToPointer(["style", "fontSize"])), [
    "style",
    "fontSize",
  ]);
});

test("resolvePointer traverses objects, arrays, and numeric object keys at runtime", () => {
  const value = {
    foo: {
      "0": "zero",
    },
    items: [
      {
        title: "First",
      },
    ],
  };

  const numericObjectKey = resolvePointer(value, "/foo/0");
  assert.equal(numericObjectKey.ok, true);
  if (numericObjectKey.ok) {
    assert.equal(numericObjectKey.value, "zero");
  }

  const arrayPath = resolvePointer(value, "/items/0/title");
  assert.equal(arrayPath.ok, true);
  if (arrayPath.ok) {
    assert.equal(arrayPath.value, "First");
  }

  const missing = resolvePointer(value, "/items/2/title");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "InvalidArrayIndex");
  }
});

test("invalid pointer syntax throws a typed pointer error", () => {
  assert.throws(() => pointerToPath("/bad~2escape"), (error: unknown) => {
    assert.ok(error instanceof InvalidPointerError);
    assert.equal(error.code, "INVALID_POINTER");
    return true;
  });
});

