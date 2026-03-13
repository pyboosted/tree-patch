import assert from "node:assert/strict";
import test from "node:test";

import {
  createCopyOnWriteMap,
  createCopyOnWriteSet,
  ensureMutableMapValue,
  materializeMap,
  materializeSet,
} from "../src/core/cow.js";

test("copy-on-write maps read through base state and detach only touched entries", () => {
  const baseInner = new Map([["x", "1"]]);
  const base = new Map([
    ["alpha", baseInner],
    ["beta", new Map([["y", "2"]])],
  ]);

  const overlay = createCopyOnWriteMap(base);
  const alpha = ensureMutableMapValue(overlay, "alpha", (current) => new Map(current));
  alpha.set("x", "updated");
  overlay.set("gamma", new Map([["z", "3"]]));

  assert.equal(baseInner.get("x"), "1");
  assert.equal(base.has("gamma"), false);
  assert.equal((overlay.get("alpha") as Map<string, string>).get("x"), "updated");

  const materialized = materializeMap(overlay);
  assert.deepEqual([...materialized.keys()], ["alpha", "beta", "gamma"]);
  assert.equal(materialized.get("alpha")?.get("x"), "updated");
  assert.equal(materialized.get("beta")?.get("y"), "2");
});

test("copy-on-write sets keep the base untouched across adds and deletes", () => {
  const base = new Set(["hero", "legal"]);
  const overlay = createCopyOnWriteSet(base);

  overlay.delete("legal");
  overlay.add("promo");

  assert.deepEqual([...base], ["hero", "legal"]);
  assert.deepEqual([...overlay], ["hero", "promo"]);
  assert.deepEqual([...materializeSet(overlay)], ["hero", "promo"]);
});
