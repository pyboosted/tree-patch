// Comparison harness: median-of-N with per-iteration cold setup where the
// scenario is cache-sensitive.
//
// Usage:
//   node benchmarks/compare.mjs [out.json]          — spawn one child process
//     per scenario (isolated heaps, --expose-gc) and aggregate results
//   node benchmarks/compare.mjs --run "<scenario>"  — run a single scenario
//     inline and print its JSON result (used by the parent process)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyPatch,
  createDocument,
  diffTrees,
} from "../dist/index.js";
import { getNodeHash } from "../dist/core/hash.js";

function wideTreeInput(size, version, reverse = false) {
  const ids = Array.from({ length: size }, (_, index) => `leaf-${index}`);
  if (reverse) ids.reverse();
  return {
    root: {
      id: "root",
      type: "Root",
      attrs: { version },
      children: ids.map((id) => ({ id, type: "Leaf", attrs: {}, children: [] })),
    },
  };
}

function deepTreeInput(size, delta) {
  const root = { id: "deep-0", type: "Deep", attrs: { value: delta }, children: [] };
  let current = root;
  for (let index = 1; index < size; index += 1) {
    const child = {
      id: `deep-${index}`,
      type: "Deep",
      attrs: { value: index + delta },
      children: [],
    };
    current.children.push(child);
    current = child;
  }
  return { root };
}

const emptyInput = () => ({
  root: { id: "root", type: "Root", attrs: { version: 1 }, children: [] },
});

// Each scenario: { iterations, setup() -> ctx (fresh per iteration), run(ctx) }.
const scenarios = {
  "diff: 100k siblings cold": {
    iterations: 9,
    setup: () => ({
      base: createDocument(wideTreeInput(100_000, 1)),
      target: createDocument(wideTreeInput(100_000, 2)),
    }),
    run: ({ base, target }) => diffTrees(base, target).ops.length,
  },
  "diff: 100k siblings warm-hash": {
    iterations: 15,
    once: () => {
      const base = createDocument(wideTreeInput(100_000, 1));
      const target = createDocument(wideTreeInput(100_000, 2));
      diffTrees(base, target);
      return { base, target };
    },
    run: ({ base, target }) => diffTrees(base, target).ops.length,
  },
  "materialize: sparse attr in 100k tree": {
    iterations: 15,
    once: () => {
      const base = createDocument(wideTreeInput(100_000, 1));
      const target = createDocument(wideTreeInput(100_000, 2));
      const patch = diffTrees(base, target);
      return { base, patch };
    },
    run: ({ base, patch }) => applyPatch(base, patch).materialized.id,
  },
  "diff: reverse 10k siblings cold": {
    iterations: 15,
    setup: () => ({
      base: createDocument(wideTreeInput(10_000, 1)),
      target: createDocument(wideTreeInput(10_000, 1, true)),
    }),
    run: ({ base, target }) => diffTrees(base, target).ops.length,
  },
  "apply: reverse 10k siblings": {
    iterations: 25,
    once: () => {
      const base = createDocument(wideTreeInput(10_000, 1));
      const target = createDocument(wideTreeInput(10_000, 1, true));
      return { base, patch: diffTrees(base, target) };
    },
    run: ({ base, patch }) => applyPatch(base, patch).status,
  },
  "diff: 5k chain ratio threshold cold": {
    iterations: 15,
    setup: () => ({
      base: createDocument(deepTreeInput(5_000, 0)),
      target: createDocument(deepTreeInput(5_000, 1)),
    }),
    run: ({ base, target }) =>
      diffTrees(base, target, { replaceSubtreeWhen: { subtreeChangeRatioGte: 0.5 } })
        .ops.length,
  },
  "apply: insert 8k siblings": {
    iterations: 25,
    once: () => {
      const base = createDocument(emptyInput());
      const target = createDocument(wideTreeInput(8_000, 1));
      return { base, patch: diffTrees(base, target) };
    },
    run: ({ base, patch }) => applyPatch(base, patch).status,
  },
  "apply: update 4k-node chain": {
    iterations: 25,
    once: () => {
      const base = createDocument(deepTreeInput(4_000, 0));
      const target = createDocument(deepTreeInput(4_000, 1));
      return { base, patch: diffTrees(base, target) };
    },
    run: ({ base, patch }) => applyPatch(base, patch).status,
  },
  "createDocument: 100k siblings": {
    iterations: 15,
    setup: () => ({ input: wideTreeInput(100_000, 1) }),
    run: ({ input }) => createDocument(input).nodes.size,
  },
  "createDocument: 100k-value attrs": {
    iterations: 15,
    setup: () => ({
      input: {
        root: {
          id: "large-value",
          type: "Bag",
          attrs: { values: Array.from({ length: 100_000 }, (_, index) => index) },
          children: [],
        },
      },
    }),
    run: ({ input }) => createDocument(input).nodes.size,
  },
  "hash: 100k primitive values cold": {
    iterations: 15,
    setup: () => ({
      doc: createDocument({
        revision: "external",
        root: {
          id: "large-value",
          type: "Bag",
          attrs: { values: Array.from({ length: 100_000 }, (_, index) => index) },
          children: [],
        },
      }),
    }),
    run: ({ doc }) => getNodeHash(doc, "large-value").length,
  },
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runScenario(name, scenario) {
  const shared = scenario.once ? scenario.once() : undefined;
  const times = [];
  let checksum;
  // warmup
  {
    const ctx = shared ?? scenario.setup();
    checksum = scenario.run(ctx);
    if (!shared) scenario.run(scenario.setup());
  }
  for (let i = 0; i < scenario.iterations; i += 1) {
    const ctx = shared ?? scenario.setup();
    globalThis.gc?.();
    const started = performance.now();
    const result = scenario.run(ctx);
    times.push(performance.now() - started);
    if (result !== checksum) {
      throw new Error(`${name}: unstable result ${result} != ${checksum}`);
    }
  }
  return {
    medianMs: Number(median(times).toFixed(2)),
    minMs: Number(Math.min(...times).toFixed(2)),
    checksum,
  };
}

if (process.argv[2] === "--run") {
  const name = process.argv[3];
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}`);
  console.log(JSON.stringify(runScenario(name, scenario)));
} else {
  const self = fileURLToPath(import.meta.url);
  const results = {};
  for (const name of Object.keys(scenarios)) {
    const output = execFileSync(
      process.execPath,
      ["--expose-gc", self, "--run", name],
      { encoding: "utf8" },
    );
    results[name] = JSON.parse(output.trim().split("\n").at(-1));
    console.log(
      `${name}: median ${results[name].medianMs}ms  min ${results[name].minMs}ms  (result=${results[name].checksum})`,
    );
  }
  if (process.argv[2]) {
    writeFileSync(process.argv[2], JSON.stringify(results, null, 2));
    console.log(`saved -> ${process.argv[2]}`);
  }
}
