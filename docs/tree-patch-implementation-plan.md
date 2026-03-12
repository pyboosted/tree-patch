# Tree Patch Engine Implementation Plan

This document is the execution checklist for implementing the v1 engine described in [tree-patch-ts-spec.md](./tree-patch-ts-spec.md).

Use this file as the source of truth for implementation status:

- mark a task `[x]` only when code, tests, and API shape for that item are done;
- mark a phase complete only when every task and every acceptance criterion in that phase is `[x]`;
- if the spec changes in a way that affects implementation order or scope, update this plan in the same change.
- use `bun` for package management and test execution unless this document is explicitly updated.

## Overall Status

- [x] Phase 1 complete
- [ ] Phase 2 complete
- [ ] Phase 3 complete
- [ ] Phase 4 complete
- [ ] Phase 5 complete
- [ ] v1 complete

## Cross-Phase Invariants

These rules apply in every phase and should be re-checked before closing a phase:

- Public API works with nested trees, even if the runtime uses normalized indexes internally.
- All patch operations are evaluated sequentially against current overlay state.
- `applyPatch()` is atomic by default and supports explicit preview mode.
- Runtime-invalid paths produce `PatchConflict.kind = "PathInvalid"`; malformed trees, malformed pointers, and unsupported runtime values without adapters/codecs remain programmer errors.
- `diffTrees()` defaults to `hideNode` when a source-backed node is absent in the target.
- Root policy is always enforced: the root cannot be hidden, moved, or removed.
- Persisted patch payloads, guard values, and replacement subtree attrs use `PersistedValue`.
- Non-JSON persisted values require a codec; unknown codec IDs are rejected.
- Returned document snapshots are immutable from the public API perspective.
- Package management and test execution use `bun` (`bun install`, `bun test`, and `bun run ...`).
- Hashing, equality, conflict reporting, diff generation, and op ordering are deterministic.

## Module Map

Nested folder layout under `src/`, with tests at project root:

- `src/core/`: document model, normalization, indexes, overlay state, apply, validate, materialize, rebase
- `src/schema/`: adapters, codecs, path helpers, canonical serialization, hashing helpers
- `src/diff/`: diff generation and transform fallback policy
- `src/editor/`: patch builder, typed editor facade, guard generation helpers
- `tests/`: unit, integration, and compile-time typing fixtures (mirrors `src/` structure)

## Phase 1 - Foundation And Snapshots

Goal: establish the public types, persisted value model, normalization pipeline, immutable snapshots, and deterministic base hashing so later phases can build on stable primitives.

### Implementation Checklist

- [x] Set up the package skeleton, TypeScript config, `bun`-based dependency management, `bun` test scripts, and public export surface.
- [x] Define core public types for trees, nodes, patches, guards, persisted values, codecs, adapters, options, and result envelopes.
- [x] Implement `PersistedValue`, `JsonValue`, `EncodedValue`, `ValueCodec`, and `ValueAdapter`.
- [x] Implement schema registration for node types and per-path adapters keyed by JSON Pointer.
- [x] Implement `pathToPointer()` and `pointerToPath()`.
- [x] Implement runtime path parsing and validation for JSON Pointer paths relative to `node.attrs`.
- [x] Implement `createDocument()` with nested-tree normalization into indexed nodes.
- [x] Build required indexes: `parentById`, `positionById`, `depthById`, `rootId`.
- [x] Enforce duplicate ID detection and root invariants during document creation.
- [x] Establish immutable snapshot behavior for returned `IndexedTree` values.
- [x] Implement default deterministic equality and canonical serialization for JSON-compatible values.
- [x] Implement base node hash, subtree hash, and lazily addressable attribute-path hash primitives.
- [x] Recognize `atomicPaths` from `NodeRuntimeSpec` and treat them as opaque units in node hash computation.
- [x] Implement default revision token derivation from default subtree hash when `revision` is absent.
- [x] Implement `resolvePointer()` for runtime traversal of JSON Pointer paths against attribute objects.
- [x] Define typed programmer error classes (`TreePatchError` hierarchy) for malformed trees, duplicate IDs, invalid roots, missing codecs, and invalid pointers — distinct from `PatchConflict`.

### Acceptance Criteria

- [x] `createDocument()` rejects malformed trees, duplicate IDs, and invalid root structure deterministically.
- [x] `pathToPointer(pointerToPath(x))` and `pointerToPath(pathToPointer(x))` round-trip for representative object and array paths.
- [x] JSON-compatible values work without codecs in persisted patches and guards.
- [x] Persisting a non-JSON value without a codec fails with a typed programmer error.
- [x] Default subtree hash includes node `id`, `type`, canonicalized `attrs`, and ordered child hashes.
- [x] Repeated hashing of equal documents produces the same output across runs.
- [x] Returned `IndexedTree` snapshots can be reused safely without observable mutation.
- [x] The project can install dependencies and run the test suite through `bun`.
- [x] Atomic paths marked in schema are treated as opaque units during hash computation; internal changes still affect the hash but nested decomposition is not attempted.
- [x] Typed programmer errors (`DuplicateIdError`, `InvalidRootError`, `MalformedTreeError`, `MissingCodecError`) are distinct from `PatchConflict` and carry a discriminant `code` field.

## Phase 2 - Core Overlay Apply Engine

Goal: build the sequential overlay-based engine for validation, apply, preview, and materialization of non-structural operations.

### Implementation Checklist

- [ ] Define the internal overlay state model used by apply, validate, materialize, and rebase flows.
- [ ] Implement `RevisionStatus` computation for `match`, `mismatch`, and `unknown`.
- [ ] Implement sequential guard evaluation against current overlay state.
- [ ] Implement `validatePatch()` in `atomic` and `preview` modes.
- [ ] Implement `applyPatch()` in `atomic` and `preview` modes.
- [ ] Implement `materialize()` as a projection-oriented **convenience wrapper** that delegates to the same sequential overlay engine as `applyPatch()`, not a separate code path.
- [ ] Implement `setAttr` with object autovivification and dense-array rules.
- [ ] Implement `removeAttr` with object removal and array splice semantics.
- [ ] Implement `hideNode` with explicit-hidden state tracking.
- [ ] Implement `showNode` so it clears only explicit hidden state on the same node.
- [ ] Implement `insertNode` for patch-owned nodes under source-backed or patch-owned parents.
- [ ] Decode persisted values through codecs before comparison and materialization.
- [ ] Encode persisted values correctly when they are emitted by builder- or diff-generated patches.
- [ ] Return typed result envelopes for `valid`, `applied`, `preview`, and `conflict` outcomes.
- [ ] Build nested materialized output with sidecar `state.hidden` and `state.patchOwned`.

### Acceptance Criteria

- [ ] `applyPatch(..., { mode: "atomic" })` returns `status: "conflict"` and no committed result when any operation conflicts.
- [ ] `applyPatch(..., { mode: "preview" })` returns partial results plus conflicts for failed operations.
- [ ] `validatePatch()` uses the same sequential overlay semantics as `applyPatch()` and does not commit state.
- [ ] `materialize()` uses the same conflict semantics as `applyPatch()` and does not silently ignore conflicts.
- [ ] Runtime-invalid paths produce `PatchConflict.kind = "PathInvalid"`.
- [ ] `setAttr` creates missing plain-object segments but never creates array holes or appends arrays implicitly.
- [ ] `removeAttr` on an array index splices the array and shifts subsequent elements.
- [ ] `showNode` does not override hidden state inherited from a hidden ancestor.
- [ ] `includeHidden: false` omits effectively hidden nodes and their descendants from materialized output.
- [ ] Codec-backed values compare and materialize correctly after decode.
- [ ] `RevisionStatus` computation returns `match` when both revisions present and equal, `mismatch` when both present and unequal, `unknown` when either is absent.

## Phase 3 - Structural Operations And Snapshot Integrity

Goal: support structural mutations safely while preserving overlay ordering semantics, ownership rules, and incremental index/cache maintenance.

### Implementation Checklist

- [ ] Implement `moveNode` with `beforeId`, `afterId`, `atStart`, and `atEnd` positioning.
- [ ] Implement anchor validation and anchor-missing conflicts.
- [ ] Implement illegal move cycle detection.
- [ ] Enforce ownership restrictions for moving source-backed nodes under patch-owned parents.
- [ ] Implement `replaceSubtree` with root identity preservation and descendant ownership behavior.
- [ ] Implement `removeNode` for patch-owned nodes.
- [ ] Enforce root restrictions for `hideNode`, `moveNode`, `removeNode`, and `replaceSubtree`.
- [ ] Ensure later operations in the same patch see overlay state produced by earlier successful structural ops.
- [ ] Update normalized indexes incrementally for insert, move, replace, and remove scenarios.
- [ ] Invalidate node, subtree, and path-hash caches only for affected regions.

### Acceptance Criteria

- [ ] Moving a source-backed node under a patch-owned parent yields `IllegalOperation`.
- [ ] `replaceSubtree` requires `node.id === nodeId`.
- [ ] `replaceSubtree` keeps the original parent relationship and child position of the replaced root.
- [ ] Descendants introduced by `replaceSubtree` are treated as patch-owned.
- [ ] Later ops targeting descendants removed by `replaceSubtree` or `removeNode` yield `NodeMissing`.
- [ ] Root cannot be hidden, moved, or removed.
- [ ] Root replacement is only allowed when the replacement root preserves the same root ID.
- [ ] Structural updates leave `parentById`, `positionById`, and `depthById` consistent.
- [ ] Unrelated caches remain valid after localized structural changes.

## Phase 4 - Diff And Rebase

Goal: implement deterministic patch generation and patch revalidation on new bases using the same semantic rules as core apply.

### Implementation Checklist

- [ ] Implement `diffTrees()` entrypoint and deterministic empty-patch short-circuit using root subtree hashes.
- [ ] Implement node matching by stable `id`.
- [ ] Detect additions, removals, reorders, moves, and attribute changes.
- [ ] Default source-backed deletion handling to `hideNode`.
- [ ] Implement `unsupportedTransformPolicy` with `"replaceSubtree"` and `"error"` behavior.
- [ ] Implement configurable subtree replacement thresholds.
- [ ] Generate deterministic operation ordering from diff output.
- [ ] Generate guards for field, move, hide/show, insert, and subtree replacement operations.
- [ ] Implement `rebasePatch()` with sequential validation against `newBase`.
- [ ] Return `appliedOpIds`, `skippedOpIds`, conflicts, preview snapshot, and rebased patch when possible.
- [ ] Reuse subtree and path hashes to prune unchanged regions in diff and rebase.

### Acceptance Criteria

- [ ] Equal inputs with equal options always produce identical diff output.
- [ ] A source-backed node missing from `target` becomes `hideNode` by default.
- [ ] Type change on the same node ID falls back to `replaceSubtree`.
- [ ] Unsupported transforms that require moving a source-backed node under a patch-owned parent follow `unsupportedTransformPolicy`.
- [ ] `unsupportedTransformPolicy: "replaceSubtree"` emits a deterministic replacement on the nearest viable source-backed ancestor.
- [ ] `unsupportedTransformPolicy: "error"` returns a typed programmer error.
- [ ] `rebasePatch()` preserves operations whose guards still pass and skips/report conflicts for the rest.
- [ ] Rebase preview reflects only successful operations in order.
- [ ] Unrelated source changes do not create conflicts for field-scoped overrides.

## Phase 5 - Builder, Typed Editor, Hardening

Goal: finish the ergonomics layer, type-safe authoring surface, codec-aware persistence edge cases, and the final performance and regression test envelope.

### Implementation Checklist

- [ ] Implement `patchBuilder()` with fluent patch construction.
- [ ] Implement `createEditor()` with node-type-aware editing helpers.
- [ ] Add compile-time-safe path typing for supported recursion depth, minimum five nested object levels.
- [ ] Add compile-time-safe value typing based on selected path.
- [ ] Implement builder-side guard generation for `expect` values and structural ops.
- [ ] Make builder serialization codec-aware for persisted values and replacement subtrees.
- [ ] Extend typed error coverage for builder-specific and editor-specific failure modes (unsupported transforms, malformed patches at build time).
- [ ] Audit hot paths for lazy hash computation and incremental invalidation behavior.
- [ ] Add end-to-end workflow tests based on the spec examples.
- [ ] Audit public exports and documentation examples for consistency with implemented behavior.

### Acceptance Criteria

- [ ] Compile-time fixtures reject invalid editor and builder paths.
- [ ] Compile-time fixtures reject invalid value types for valid paths.
- [ ] Builder-generated patches use `PersistedValue` correctly for JSON and codec-backed values.
- [ ] Missing codecs for required persisted values fail deterministically at build or serialization time.
- [ ] Repeated validate/apply cycles reuse caches without stale results leaking through public APIs.
- [ ] Spec example workflow passes end to end.
- [ ] Public API and runtime behavior match the v1 acceptance requirements from the spec.

## Definition Of Done For v1

- [ ] Every phase is marked complete.
- [ ] Every acceptance criterion in every phase is marked complete.
- [ ] No required v1 behavior from the spec remains behind a TODO or placeholder implementation.
- [ ] Public API, result types, and runtime semantics match the current specification.
- [ ] Regression tests cover conflict detection, move semantics, subtree replacement, codec persistence, preview flows, and cache invalidation.
