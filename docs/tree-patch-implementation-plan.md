# Tree Patch Engine Implementation Plan

This document is the execution checklist for implementing the v1 engine described in [tree-patch-ts-spec.md](./tree-patch-ts-spec.md).

Use this file as the source of truth for implementation status:

- mark a task `[x]` only when code, tests, and API shape for that item are done;
- mark a phase complete only when every task and every acceptance criterion in that phase is `[x]`;
- if the spec changes in a way that affects implementation order or scope, update this plan in the same change.
- use `bun` for package management and test execution unless this document is explicitly updated.

## Overall Status

- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Phase 4 complete
- [x] Phase 5 complete
- [x] v1 complete

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

- [x] Define the internal overlay state model used by apply, validate, materialize, and rebase flows.
- [x] Implement `RevisionStatus` computation for `match`, `mismatch`, and `unknown`.
- [x] Implement sequential guard evaluation against current overlay state.
- [x] Implement `validatePatch()` in `atomic` and `preview` modes.
- [x] Implement `applyPatch()` in `atomic` and `preview` modes.
- [x] Implement `materialize()` as a projection-oriented **convenience wrapper** that delegates to the same sequential overlay engine as `applyPatch()`, not a separate code path.
- [x] Implement `setAttr` with object autovivification and dense-array rules.
- [x] Implement `removeAttr` with object removal and array splice semantics.
- [x] Implement `hideNode` with explicit-hidden state tracking.
- [x] Implement `showNode` so it clears only explicit hidden state on the same node.
- [x] Implement `insertNode` for patch-owned nodes under source-backed or patch-owned parents.
- [x] Decode persisted values through codecs before comparison and materialization.
- [x] Encode persisted values correctly when they are emitted by builder- or diff-generated patches.
- [x] Return typed result envelopes for `valid`, `applied`, `preview`, and `conflict` outcomes.
- [x] Build nested materialized output with sidecar `state.hidden` and `state.patchOwned`.

### Acceptance Criteria

- [x] `applyPatch(..., { mode: "atomic" })` returns `status: "conflict"` and no committed result when any operation conflicts.
- [x] `applyPatch(..., { mode: "preview" })` returns partial results plus conflicts for failed operations.
- [x] `validatePatch()` uses the same sequential overlay semantics as `applyPatch()` and does not commit state.
- [x] `materialize()` uses the same conflict semantics as `applyPatch()` and does not silently ignore conflicts.
- [x] Runtime-invalid paths produce `PatchConflict.kind = "PathInvalid"`.
- [x] `setAttr` creates missing plain-object segments but never creates array holes or appends arrays implicitly.
- [x] `removeAttr` on an array index splices the array and shifts subsequent elements.
- [x] `showNode` does not override hidden state inherited from a hidden ancestor.
- [x] `includeHidden: false` omits effectively hidden nodes and their descendants from materialized output.
- [x] Codec-backed values compare and materialize correctly after decode.
- [x] `RevisionStatus` computation returns `match` when both revisions present and equal, `mismatch` when both present and unequal, `unknown` when either is absent.

## Phase 3 - Structural Operations And Snapshot Integrity

Goal: support structural mutations safely while preserving overlay ordering semantics, ownership rules, and incremental index/cache maintenance.

### Implementation Checklist

- [x] Implement `moveNode` with `beforeId`, `afterId`, `atStart`, and `atEnd` positioning.
- [x] Implement anchor validation and anchor-missing conflicts.
- [x] Implement illegal move cycle detection.
- [x] Enforce ownership restrictions for moving source-backed nodes under patch-owned parents.
- [x] Implement `replaceSubtree` with root identity preservation and descendant ownership behavior.
- [x] Implement `removeNode` for patch-owned nodes.
- [x] Enforce root restrictions for `hideNode`, `moveNode`, `removeNode`, and `replaceSubtree`.
- [x] Ensure later operations in the same patch see overlay state produced by earlier successful structural ops.
- [x] Update normalized indexes incrementally for insert, move, replace, and remove scenarios.
- [x] Invalidate node, subtree, and path-hash caches only for affected regions.

### Acceptance Criteria

- [x] Moving a source-backed node under a patch-owned parent yields `IllegalOperation`.
- [x] `replaceSubtree` requires `node.id === nodeId`.
- [x] `replaceSubtree` keeps the original parent relationship and child position of the replaced root.
- [x] Descendants introduced by `replaceSubtree` are treated as patch-owned.
- [x] Later ops targeting descendants removed by `replaceSubtree` or `removeNode` yield `NodeMissing`.
- [x] Root cannot be hidden, moved, or removed.
- [x] Root replacement is only allowed when the replacement root preserves the same root ID.
- [x] Structural updates leave `parentById`, `positionById`, and `depthById` consistent.
- [x] Unrelated caches remain valid after localized structural changes.

## Phase 4 - Diff And Rebase

Goal: implement deterministic patch generation and patch revalidation on new bases using the same semantic rules as core apply.

### Implementation Checklist

- [x] Implement `diffTrees()` entrypoint and deterministic empty-patch short-circuit using root subtree hashes.
- [x] Implement node matching by stable `id`.
- [x] Detect additions, removals, reorders, moves, and attribute changes.
- [x] Default source-backed deletion handling to `hideNode`.
- [x] Implement `unsupportedTransformPolicy` with `"replaceSubtree"` and `"error"` behavior.
- [x] Implement configurable subtree replacement thresholds.
- [x] Generate deterministic operation ordering from diff output.
- [x] Generate guards for field, move, hide/show, insert, and subtree replacement operations.
- [x] Implement `rebasePatch()` with sequential validation against `newBase`.
- [x] Return `appliedOpIds`, `skippedOpIds`, conflicts, preview snapshot, and rebased patch when possible.
- [x] Reuse subtree and path hashes to prune unchanged regions in diff and rebase.

### Acceptance Criteria

- [x] Equal inputs with equal options always produce identical diff output.
- [x] A source-backed node missing from `target` becomes `hideNode` by default.
- [x] Type change on the same node ID falls back to `replaceSubtree`.
- [x] Unsupported transforms that require moving a source-backed node under a patch-owned parent follow `unsupportedTransformPolicy`.
- [x] `unsupportedTransformPolicy: "replaceSubtree"` emits a deterministic replacement on the nearest viable source-backed ancestor.
- [x] `unsupportedTransformPolicy: "error"` returns a typed programmer error.
- [x] `rebasePatch()` preserves operations whose guards still pass and skips/report conflicts for the rest.
- [x] Rebase preview reflects only successful operations in order.
- [x] Unrelated source changes do not create conflicts for field-scoped overrides.

## Phase 5 - Builder, Typed Editor, Hardening

Goal: finish the ergonomics layer, type-safe authoring surface, codec-aware persistence edge cases, and the final performance and regression test envelope.

### Implementation Checklist

- [x] Implement `patchBuilder()` with fluent patch construction.
- [x] Implement `createEditor()` with node-type-aware editing helpers.
- [x] Add compile-time-safe path typing for supported recursion depth, minimum five nested object levels.
- [x] Add compile-time-safe value typing based on selected path.
- [x] Implement builder-side guard generation for `expect` values and structural ops.
- [x] Make builder serialization codec-aware for persisted values and replacement subtrees.
- [x] Extend typed error coverage for builder-specific and editor-specific failure modes (unsupported transforms, malformed patches at build time).
- [x] Audit hot paths for lazy hash computation and incremental invalidation behavior.
- [x] Add end-to-end workflow tests based on the spec examples.
- [x] Audit public exports and documentation examples for consistency with implemented behavior.

### Acceptance Criteria

- [x] Compile-time fixtures reject invalid editor and builder paths.
- [x] Compile-time fixtures reject invalid value types for valid paths.
- [x] Builder-generated patches use `PersistedValue` correctly for JSON and codec-backed values.
- [x] Missing codecs for required persisted values fail deterministically at build or serialization time.
- [x] Repeated validate/apply cycles reuse caches without stale results leaking through public APIs.
- [x] Spec example workflow passes end to end.
- [x] Public API and runtime behavior match the v1 acceptance requirements from the spec.

## Definition Of Done For v1

- [x] Every phase is marked complete.
- [x] Every acceptance criterion in every phase is marked complete.
- [x] No required v1 behavior from the spec remains behind a TODO or placeholder implementation.
- [x] Public API, result types, and runtime semantics match the current specification.
- [x] Regression tests cover conflict detection, move semantics, subtree replacement, codec persistence, preview flows, and cache invalidation.
