# Tree Patch Engine for TypeScript

**Status:** Draft development specification  
**Language:** TypeScript 5.x  
**Primary use case:** Localization overlays and conflict-aware patching for structured content trees

---

## 1. Purpose

This document specifies a TypeScript library that:

- works with **tree-shaped content documents** as a first-class data model;
- stores localized or customized variants as **patches**, not full copies of documents;
- detects **conflicts only when the source changed in the exact fields or structures referenced by a patch**;
- supports **tree editing operations** such as field replacement, subtree replacement, hiding nodes, inserting locale-specific nodes, and moving nodes;
- supports **generic node attributes**, including attribute types that vary by node `type`;
- maintains **indexes and caches** internally and compares **only the minimum required regions** of the tree.

The library is designed for localization workflows, but the core engine must remain generic and reusable for any tree-based content system.

---

## 2. Design principles

The implementation MUST follow these principles:

1. **Stable node identity over position.** Tree operations MUST target nodes by stable `id`, not by array index.
2. **Type-driven attributes.** The shape of `attrs` MUST be linked to the node `type` at the type level.
3. **Field-scoped conflicts.** Changes outside the fields or structures referenced by a patch MUST NOT produce conflicts.
4. **Structural edits with anchors.** Reorder and insert operations MUST use parent/anchor references, not numeric indexes.
5. **Deterministic behavior.** Hashing, equality, diff generation, patch application, and conflict reporting MUST be deterministic.
6. **Incremental computation.** The engine MUST cache indexes and hashes and invalidate only affected regions.
7. **JSON-serializable patches.** Persisted patches MUST be serializable without runtime-only state and MUST use explicit codec envelopes for non-JSON values when needed.
8. **Runtime-extensible comparison and serialization.** The library MUST provide adapters for equality, hashing, cloning, and optional codec-based persistence for non-JSON attribute values.

---

## 3. Non-goals

The first version of the library MUST NOT try to solve all of the following:

- real-time collaborative editing / CRDT semantics;
- automatic semantic merge of conflicting translations;
- schema inference from arbitrary runtime documents;
- storage engine concerns;
- UI concerns;
- text translation itself.

---

## 4. Terminology

### 4.1 Tree
A rooted directed acyclic structure where each node has exactly one parent except the root.

### 4.2 Node
A tree element with:
- stable `id`;
- discriminant `type`;
- typed `attrs`;
- ordered `children`.

### 4.3 Source document
The base content tree authored in the primary language or canonical source.

### 4.4 Patch
A sequence of semantic operations with optional guards, intended to transform a source tree into a localized or customized view.

### 4.5 Guard
A precondition attached to a patch operation. If a guard fails, the operation conflicts.

### 4.6 Conflict
A deterministic validation failure caused by missing target structure, guard mismatch, type mismatch, anchor mismatch, or an illegal operation.

### 4.7 Materialized tree
The result of applying a patch to a source tree.

### 4.8 Patch-owned node
A node introduced by the patch, not present in the source tree.

---

## 5. Public data model

The public API MUST accept and return **nested tree objects**.

The runtime implementation MAY normalize trees internally into maps and indexes.

### 5.1 Type map

The library MUST model node attributes through a type map.

```ts
export type NodeTypeMap = Record<string, unknown>;
```

Example:

```ts
type ContentTypes = {
  Page: {};
  Hero: {
    title: string;
    subtitle?: string;
    image: { url: string; alt?: string };
    style?: { fontSize?: number };
  };
  RichText: {
    html: string;
  };
};
```

### 5.2 Node types linked to `type`

The library MUST expose a discriminated union where `attrs` is tied to `type`.

```ts
export type NodeId = string;

export type TreeNode<TTypes extends NodeTypeMap, TType extends keyof TTypes = keyof TTypes> = {
  id: NodeId;
  type: TType;
  attrs: TTypes[TType];
  children: readonly AnyTreeNode<TTypes>[];
};

export type AnyTreeNode<TTypes extends NodeTypeMap> = {
  [K in keyof TTypes]: TreeNode<TTypes, K>
}[keyof TTypes];

export interface TreeDocument<TTypes extends NodeTypeMap> {
  root: AnyTreeNode<TTypes>;
  revision?: string;
  metadata?: Record<string, unknown>;
}
```

### 5.3 Reserved envelope fields

The public document format MUST reserve these node envelope keys:

- `id`
- `type`
- `attrs`
- `children`

User-defined fields MUST live under `attrs` or under explicit optional document metadata.

### 5.4 Node ID requirements

- Node IDs MUST be unique within a document.
- Node IDs MUST remain stable across source revisions whenever the logical block remains the same.
- The library MUST reject documents with duplicate IDs.
- The library MUST treat unstable IDs as a caller error; support for fuzzy matching is explicitly out of scope.

---

## 6. Runtime schema and adapters

Because the library must support generic attribute values, it MUST provide a runtime schema/adapter layer.

### 6.1 JSON and persisted value model

Persisted patches MUST be fully JSON-serializable.

```ts
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];

export interface EncodedValue {
  $codec: string;
  value: JsonValue;
}

export type PersistedValue = JsonValue | EncodedValue;
```

The envelope shape `{ "$codec": string, "value": JsonValue }` is reserved for encoded persisted values. An implementation MAY namespace this envelope in a backward-compatible way, but it MUST document the chosen wire format.

Runtime source documents MAY contain non-JSON values only when appropriate adapters are registered.

### 6.2 Value adapter and codec

A value adapter defines equality, hashing, cloning, and optional persistence for attribute values.

```ts
export interface ValueCodec<T = unknown> {
  codecId: string;
  serialize(value: T): JsonValue;
  deserialize(value: JsonValue): T;
}

export interface ValueAdapter<T = unknown> {
  equals(a: T, b: T): boolean;
  hash?(value: T): string;
  clone?(value: T): T;
  codec?: ValueCodec<T>;
}
```

A codec is required only when a non-JSON runtime value may appear in a persisted patch payload, a persisted guard value, or a serialized replacement subtree.

### 6.3 Default adapter

The implementation MUST provide a default adapter for JSON-compatible values:

- primitives;
- arrays;
- plain objects;
- `null`.

The default adapter MUST use deterministic deep equality and deterministic canonical serialization for hashing.

### 6.4 Node type schema

The library SHOULD expose a runtime schema per node type.

```ts
export interface NodeRuntimeSpec<TAttrs> {
  atomicPaths?: readonly AttrPath<TAttrs>[];
  adapters?: Partial<Record<JsonPointer, ValueAdapter<any>>>;
}

export interface TreeSchema<TTypes extends NodeTypeMap> {
  types: {
    [K in keyof TTypes]?: NodeRuntimeSpec<TTypes[K]>;
  };
}
```

Path keys in `adapters` MUST be JSON Pointers relative to the node `attrs` object. The empty pointer `""` MAY be used for the entire `attrs` object.

### 6.5 Atomic comparison

The schema MAY mark selected attribute paths as **atomic**.

If a path is atomic:
- diff generation MUST treat the path as a single value;
- guards MAY use full-value equality or hash comparison;
- nested field-level diff under that path MUST NOT be attempted.

This is required for large objects where field-level diff is undesirable.

### 6.6 Non-JSON value rules

- In-memory comparison and hashing MAY use adapters without codecs.
- Patch building, patch serialization, and `diffTrees()` MUST fail with a typed programmer error if they need to persist a non-JSON value at a path without a codec.
- `validatePatch()`, `applyPatch()`, `materialize()`, and `rebasePatch()` MUST decode encoded persisted values before comparison or materialization.
- Encoded values MUST be treated as data, not instructions. Unknown codec IDs MUST be rejected unless a compatible codec registry is installed.

---

## 7. Attribute paths

The ergonomic API MUST support **typed tuple paths**.

The serialized patch format MUST use **JSON Pointer strings**.

### 7.1 Path types

```ts
export type JsonPointer = `/${string}` | "";
export type AttrPath<T> = DeepPath<T>;

// helper type shapes are implementation-defined
export type DeepPath<T> = readonly (string | number)[];
export type DeepValue<T, P extends AttrPath<T>> = unknown;
```

The exact helper type implementation is implementation-defined, but the public editor and builder APIs MUST expose overloads that reject invalid paths and invalid value types at compile time for supported TypeScript recursion limits.

By default, compile-time path typing MUST work for at least 5 nested object levels.

The goal is compile-time safety for calls like:

```ts
editor.node("hero", "Hero").set(["image", "url"], "/img/fr.png");
```

and compile-time rejection for invalid combinations such as:

```ts
editor.node("hero", "Hero").set(["missing"], "x");     // should fail
editor.node("hero", "Hero").set(["style", "fontSize"], "x"); // should fail
```

### 7.2 Path conversion

The library MUST expose helpers:

```ts
pathToPointer(path: AttrPath<any>): JsonPointer;
pointerToPath(pointer: JsonPointer): AttrPath<any>;
```

### 7.3 Runtime path policy

The first version MUST use these runtime rules for attribute paths:

- paths and pointers are always relative to `node.attrs`;
- `setAttr` MUST create missing intermediate **plain-object** segments when traversal stays within plain objects;
- `setAttr` MUST NOT auto-create arrays or append to arrays;
- `setAttr` on an array index MUST replace an existing dense element only;
- arrays MUST be treated as dense; holes MUST NOT be created;
- `removeAttr` on an array index MUST splice and shift subsequent elements;
- `setAttr` MUST yield `PathInvalid` if traversal encounters a scalar, a non-container value, or an out-of-range array index before the final segment;
- `removeAttr` on a well-formed pointer that does not resolve on the runtime value MUST yield `PathInvalid`.

---

## 8. Internal normalized representation

Although the public API works with nested trees, the engine SHOULD normalize trees internally.

```ts
export interface IndexedTree<TTypes extends NodeTypeMap> {
  rootId: NodeId;
  nodes: ReadonlyMap<NodeId, IndexedNode<TTypes>>;
  revision?: string;
  metadata?: Record<string, unknown>;
  index: TreeIndex;
  cache: TreeCache;
}

export type IndexedNode<TTypes extends NodeTypeMap, TType extends keyof TTypes = keyof TTypes> = {
  id: NodeId;
  type: TType;
  attrs: TTypes[TType];
  childIds: readonly NodeId[];
};
```

### 8.1 Ownership and immutability contract

`createDocument()` MUST establish an immutable snapshot boundary.

A conforming implementation MUST do one of the following:

- clone or structurally clone the input tree and own that clone; or
- freeze or otherwise guard the input and document that subsequent external mutation is unsupported.

The default behavior MUST guarantee cache safety.

Returned `IndexedTree` instances MUST be treated as immutable snapshots. Public mutation-style APIs MUST return new snapshots and MUST NOT mutate previously returned snapshots.

External mutation of input objects after `createDocument()` is unsupported behavior. An implementation SHOULD throw or warn in development mode when such mutation is detectable.

### 8.2 Required indexes

The engine MUST compute and maintain:

- `parentById: Map<NodeId, NodeId | null>`
- `positionById: Map<NodeId, number>`
- `depthById: Map<NodeId, number>`
- `rootId`

The engine MAY additionally maintain:

- ancestor chain cache;
- child sequence hash;
- patch-owned node set;
- reverse dependency cache for path-level hashes.

### 8.3 Required caches

The engine MUST support these caches:

- **node hash**: hash of a node envelope excluding descendants;
- **subtree hash**: hash of node + ordered descendant hashes;
- **attribute path hash**: lazily computed hash for a specific `(nodeId, path)`.

Subtree hashes used for document revision tokens MUST include node `id`, node `type`, canonicalized `attrs`, and ordered child hashes by default.

A separate optional content-only hash MAY ignore `id`, but it MUST NOT be used as the default document revision token.

### 8.4 Invalidation

When a node changes, the engine MUST:

1. invalidate the node hash for that node;
2. invalidate any cached attribute-path hashes for that node;
3. invalidate subtree hashes for that node and all ancestors;
4. update parent/position indexes only for affected structural regions.

The engine MUST NOT recompute unrelated hashes.

---

## 9. Patch model

The patch model MUST be semantic, tree-aware, JSON-serializable, and evaluated sequentially against overlay state.

### 9.1 Patch envelope

```ts
export interface TreePatch {
  format: "tree-patch/v1";
  patchId: string;
  baseRevision?: string;
  metadata?: Record<string, unknown>;
  ops: readonly PatchOp[];
}
```

### 9.2 Operation requirements

Every patch operation MUST:

- have stable `opId`;
- be independently validatable;
- carry the minimum information required for deterministic application;
- support optional guards;
- reference nodes by `id` and structure by anchors, not indexes;
- be interpreted sequentially, so later operations MAY depend on the overlay state produced by earlier operations.

### 9.3 Patch operations

```ts
export type PatchOp =
  | SetAttrOp
  | RemoveAttrOp
  | HideNodeOp
  | ShowNodeOp
  | InsertNodeOp
  | MoveNodeOp
  | ReplaceSubtreeOp
  | RemoveNodeOp;
```

#### 9.3.1 Set attribute

```ts
export interface SetAttrOp {
  kind: "setAttr";
  opId: string;
  nodeId: NodeId;
  path: JsonPointer;
  value: PersistedValue;
  guards?: readonly Guard[];
}
```

Semantics:
- replaces or creates the value at `node.attrs[path]`;
- conflicts if the target node is missing, node type mismatches a guard, or a guard fails.

#### 9.3.2 Remove attribute

```ts
export interface RemoveAttrOp {
  kind: "removeAttr";
  opId: string;
  nodeId: NodeId;
  path: JsonPointer;
  guards?: readonly Guard[];
}
```

Semantics:
- removes an attribute path;
- conflicts if the target node is missing, the path is invalid, or a guard fails.

#### 9.3.3 Hide node

```ts
export interface HideNodeOp {
  kind: "hideNode";
  opId: string;
  nodeId: NodeId;
  guards?: readonly Guard[];
}
```

Semantics:
- marks a node as **explicitly hidden** in overlay state;
- MUST NOT physically delete source nodes;
- root MUST NOT be hidden;
- MUST preserve descendant structure for conflict validation unless a caller opts into pruning at materialization time.

#### 9.3.4 Show node

```ts
export interface ShowNodeOp {
  kind: "showNode";
  opId: string;
  nodeId: NodeId;
  guards?: readonly Guard[];
}
```

Semantics:
- clears the explicit hidden flag on the same node;
- MUST NOT override hidden state inherited from ancestors;
- MUST NOT be treated as a force-visible escape hatch in v1.

#### 9.3.5 Insert patch-owned node or subtree

```ts
export interface InsertNodeOp {
  kind: "insertNode";
  opId: string;
  parentId: NodeId;
  position?: ChildPosition;
  node: SerializedPatchNode;
  guards?: readonly Guard[];
}
```

Semantics:
- inserts a patch-owned node or subtree under the specified parent;
- `parentId` MAY reference a source-backed or patch-owned node;
- inserted descendants are patch-owned.

`node.id` MUST be unique. The implementation SHOULD namespace patch-owned IDs automatically when the caller does not provide one.

#### 9.3.6 Move node

```ts
export interface MoveNodeOp {
  kind: "moveNode";
  opId: string;
  nodeId: NodeId;
  newParentId: NodeId;
  position?: ChildPosition;
  guards?: readonly Guard[];
}
```

Semantics:
- moves an existing node under a new parent or reorders it within the same parent;
- MUST use anchors, not raw indexes;
- in v1, moving a **source-backed** node under a patch-owned parent MUST be rejected as `IllegalOperation` unless an extension explicitly enables it.

#### 9.3.7 Replace subtree

```ts
export interface ReplaceSubtreeOp {
  kind: "replaceSubtree";
  opId: string;
  nodeId: NodeId;
  node: SerializedPatchNode;
  guards?: readonly Guard[];
}
```

Semantics:
- replaces the target node and all descendants with the provided subtree;
- `node.id` MUST equal `nodeId`;
- the replacement root keeps the existing parent relation and child position;
- all descendants introduced under the replacement root are treated as patch-owned in v1;
- the replacement MUST NOT reuse a live node ID outside the replaced subtree and MUST NOT reuse removed source-descendant IDs unless an extension explicitly enables that behavior;
- later operations in the same patch observe post-replacement overlay state; operations targeting removed descendants MUST yield `NodeMissing`.

`replaceSubtree` SHOULD be used only when field-level or move-based representation is undesirable.

#### 9.3.8 Remove patch-owned node

```ts
export interface RemoveNodeOp {
  kind: "removeNode";
  opId: string;
  nodeId: NodeId;
  guards?: readonly Guard[];
}
```

Semantics:
- MUST be allowed only for patch-owned nodes by default;
- removing source nodes physically MUST be rejected unless the caller explicitly enables that behavior;
- root MUST NOT be removed.

### 9.4 Child position

```ts
export type ChildPosition =
  | { beforeId: NodeId }
  | { afterId: NodeId }
  | { atStart: true }
  | { atEnd: true };
```

The implementation MUST reject ambiguous positions and missing anchor references.

### 9.5 Serialized patch node

```ts
export interface SerializedPatchNode {
  id: NodeId;
  type: string;
  attrs: PersistedValue;
  children: readonly SerializedPatchNode[];
}
```

The subtree MUST be fully JSON-serializable using plain JSON values or codec envelopes.

### 9.6 Root-node policy

The root node MUST exist exactly once.

The root:

- MUST NOT be hidden;
- MUST NOT be moved;
- MUST NOT be removed.

`replaceSubtree` MAY target the root only if the replacement root keeps the same `id` and remains the root of the materialized document.

---

## 10. Guards

Guards are the core mechanism for conflict detection.

### 10.1 Guard model

```ts
export type Guard =
  | { kind: "nodeExists"; nodeId: NodeId }
  | { kind: "nodeAbsent"; nodeId: NodeId }
  | { kind: "nodeTypeIs"; nodeId: NodeId; nodeType: string }
  | { kind: "attrEquals"; nodeId: NodeId; path: JsonPointer; value: PersistedValue }
  | { kind: "attrHash"; nodeId: NodeId; path: JsonPointer; hash: string }
  | { kind: "subtreeHash"; nodeId: NodeId; hash: string }
  | { kind: "parentIs"; nodeId: NodeId; parentId: NodeId | null }
  | { kind: "positionAfter"; nodeId: NodeId; afterId: NodeId }
  | { kind: "positionBefore"; nodeId: NodeId; beforeId: NodeId };
```

### 10.2 Guard evaluation rules

- During `applyPatch()`, `materialize()`, and `rebasePatch()`, guards MUST be evaluated against the **current overlay state** produced by all prior successful operations in the same patch.
- During `validatePatch()`, the same sequential semantics MUST be used, but validation MUST NOT commit external state.
- Guard evaluation MUST be deterministic.
- A failed guard MUST yield a conflict.
- A successful guard MUST NOT mutate state.

### 10.3 Recommended usage

The diff and patch-builder layers SHOULD generate these guard patterns:

- **field override** → `attrEquals` or `attrHash` on the exact path being overridden;
- **subtree override** → `subtreeHash` on the target node;
- **hide/show node** → `nodeExists` and optional `nodeTypeIs`;
- **move** → `nodeExists`, `parentIs` or anchor existence guards;
- **insert** → `nodeExists(parent)` and optional anchor guard.

### 10.4 Equality vs hash guards

The engine SHOULD prefer:

- `attrEquals` for small scalar or small object values;
- `attrHash` for large objects;
- `subtreeHash` for large subtree replacements.

When a guard uses an encoded value, the engine MUST decode it through the matching codec before equality comparison.

---

## 11. Conflict semantics

Conflict detection MUST be narrow and operation-scoped.

### 11.1 Fundamental rule

A patch operation conflicts **only if**:

- its target or required anchor is missing;
- its guards fail;
- it becomes structurally invalid;
- it violates policy constraints.

Unrelated source changes MUST NOT conflict.

### 11.2 Required conflict scenarios

#### Case A: unrelated attribute change

If a patch overrides `hero.attrs.title`, and the source changes only `hero.attrs.subtitle`, there MUST be **no conflict**.

#### Case B: exact attribute change

If a patch overrides `hero.attrs.title`, and the source changes `hero.attrs.title`, the patch MUST conflict if the guard no longer matches.

#### Case C: reorder without target change

If a patch changes a node attribute and the source only reorders siblings, there MUST be **no conflict** unless the patch operation depends on that order.

#### Case D: move anchored to missing sibling

If a move/insert operation depends on `beforeId` or `afterId`, and that anchor no longer exists, the operation MUST conflict.

#### Case E: subtree replacement

If a patch replaces a subtree guarded by a subtree hash, any source change inside that subtree MUST conflict.

### 11.3 Conflict object

```ts
export interface PatchConflict {
  opId: string;
  kind:
    | "NodeMissing"
    | "NodeAlreadyExists"
    | "TypeMismatch"
    | "GuardFailed"
    | "AnchorMissing"
    | "ParentMismatch"
    | "IllegalOperation"
    | "PathInvalid";
  nodeId?: NodeId;
  path?: JsonPointer;
  expected?: unknown;
  actual?: unknown;
  message: string;
}
```

### 11.4 Atomicity

`applyPatch()` MUST be atomic by default:

- if any operation conflicts, the function MUST return conflicts and no committed result;
- a non-atomic preview mode MAY exist, but it MUST be explicitly requested.

---

## 12. Public API surface

The library SHOULD expose a small, focused API.

### 12.1 Core functions

```ts
function createDocument<TTypes extends NodeTypeMap>(
  input: TreeDocument<TTypes>,
  options?: CreateDocumentOptions<TTypes>
): IndexedTree<TTypes>;

function validatePatch<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options?: ValidateOptions
): ValidationResult;

function applyPatch<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options?: ApplyOptions
): ApplyResult<TTypes>;

function diffTrees<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  options?: DiffOptions<TTypes>
): TreePatch;

function rebasePatch<TTypes extends NodeTypeMap>(
  oldBase: IndexedTree<TTypes>,
  newBase: IndexedTree<TTypes>,
  patch: TreePatch,
  options?: RebaseOptions
): RebaseResult<TTypes>;

function materialize<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options?: MaterializeOptions
): MaterializeResult<TTypes>;
```

### 12.2 Common options and result types

```ts
export interface CreateDocumentOptions<TTypes extends NodeTypeMap> {
  schema?: TreeSchema<TTypes>;
  ownership?: "clone" | "assumeImmutable";
}

export interface ValidateOptions {
  mode?: "atomic" | "preview";
}

export interface ApplyOptions extends ValidateOptions {
  includeHidden?: boolean;
}

export interface MaterializeOptions extends ApplyOptions {}

export interface RebaseOptions extends ApplyOptions {}

export interface RevisionStatus {
  status: "match" | "mismatch" | "unknown";
  sourceRevision?: string;
  patchBaseRevision?: string;
}

export type ValidationResult =
  | {
      status: "valid";
      revision: RevisionStatus;
    }
  | {
      status: "conflict";
      revision: RevisionStatus;
      conflicts: readonly PatchConflict[];
    };

export type ApplyResult<TTypes extends NodeTypeMap> =
  | {
      status: "applied";
      revision: RevisionStatus;
      tree: IndexedTree<TTypes>;
      materialized: MaterializedNode<TTypes>;
    }
  | {
      status: "preview";
      revision: RevisionStatus;
      tree: IndexedTree<TTypes>;
      materialized: MaterializedNode<TTypes>;
      conflicts: readonly PatchConflict[];
    }
  | {
      status: "conflict";
      revision: RevisionStatus;
      conflicts: readonly PatchConflict[];
    };

export type MaterializeResult<TTypes extends NodeTypeMap> = ApplyResult<TTypes>;
```

`RevisionStatus.status` MUST be:

- `"match"` when both revisions are present and equal;
- `"mismatch"` when both revisions are present and not equal;
- `"unknown"` when either side is absent.

`materialize()` MUST use the same validation and conflict semantics as `applyPatch()`. It is a projection-oriented wrapper and MUST NOT silently ignore conflicts.

### 12.3 Patch builder

The library MUST provide an ergonomic builder API.

```ts
const patch = patchBuilder<ContentTypes>()
  .patchId("fr-home")
  .baseRevision(source.revision)
  .setAttr("hero", ["title"], "Promotions d'été", {
    expect: "Summer Sale",
  })
  .setAttr("hero", ["image", "url"], "/img/fr.png", {
    expect: "/img/en.png",
  })
  .hideNode("legal-us-only")
  .insertNode("hero", {
    id: "promo-fr",
    type: "RichText",
    attrs: { html: "<p>Livraison gratuite</p>" },
    children: [],
  }, { afterId: "cta" })
  .build();
```

### 12.4 Typed node editor

The library SHOULD provide a typed editor facade for user-authored patch construction.

```ts
const editor = createEditor<ContentTypes>(source);

editor.node("hero", "Hero").set(["title"], "Promotions d'été", {
  expect: "Summer Sale",
});
```

Requirements:
- the editor MUST validate that the claimed node type matches the actual node type if available;
- the editor MUST type-check the attribute path against the selected node type.

---

## 13. Diff generation

The library MUST support diff generation from `base` to `target`.

### 13.1 Diff assumptions

- matching is by stable `id` only;
- type changes on the same `id` SHOULD result in `replaceSubtree`;
- child order is meaningful.

### 13.2 Diff strategy

The diff engine SHOULD use this order:

1. Compare root subtree hashes. If equal, return an empty patch.
2. Match nodes by `id`.
3. Detect additions and removals.
4. Detect moves/reorders using parent and child sequence differences.
5. Detect attribute changes per node.
6. Decide between fine-grained field ops and `replaceSubtree` using configurable thresholds.

### 13.3 Unsupported transforms and fallbacks

In v1, `moveNode` cannot express every possible materialized target shape. In particular, moving a **source-backed** node under a patch-owned parent is not representable as a normal move.

When `diffTrees()` encounters such a target, it MUST follow `unsupportedTransformPolicy`:

- `"replaceSubtree"` → emit `replaceSubtree` on the nearest source-backed ancestor that can deterministically express the target state;
- `"error"` → throw or return a typed `UnsupportedTransform` programmer error.

The default policy SHOULD be `"replaceSubtree"`.

### 13.4 Minimality

The diff engine DOES NOT need to guarantee globally minimal patches.

It MUST guarantee:
- deterministic output for equal inputs and options;
- semantically correct output;
- stable ordering of operations.

### 13.5 Replacement threshold

The diff engine SHOULD expose a threshold policy such as:

```ts
interface DiffOptions<TTypes extends NodeTypeMap> {
  replaceSubtreeWhen?: {
    changedAttrCountGte?: number;
    changedChildCountGte?: number;
    subtreeChangeRatioGte?: number;
  };
  hideMissingSourceNodes?: boolean;
  unsupportedTransformPolicy?: "replaceSubtree" | "error";
  schema?: TreeSchema<TTypes>;
}
```

---

## 14. Patch application algorithm

### 14.1 High-level algorithm

For `applyPatch(source, patch)` the engine MUST:

1. validate patch format;
2. compute `RevisionStatus`;
3. validate node references and patch-owned IDs that can be checked up front;
4. create a working overlay state from the source snapshot;
5. evaluate and apply operations in order;
6. if any conflict occurs, abort in atomic mode or continue in preview mode as configured;
7. update indexes and invalidate only affected caches;
8. return the new indexed document and nested materialized tree view.

### 14.2 Operation ordering

Operations MUST be applied in the order stored in the patch.

The patch builder and diff generator SHOULD emit operations in a stable order:

1. insertions for patch-owned support structure;
2. moves;
3. field mutations;
4. visibility toggles;
5. subtree replacements;
6. removals of patch-owned nodes.

The exact order MAY differ if the implementation documents it, but it MUST be deterministic.

### 14.3 Sequential overlay state and overlapping operations

Each operation MUST observe the overlay state produced by all prior successful operations in the same patch.

User-authored patches MAY contain overlapping operations. They MUST be interpreted strictly in order.

The diff generator and patch builder MUST NOT emit redundant or overlapping operations for the same covered region unless explicitly configured to do so.

### 14.4 Validation without full diff

The engine MUST validate a patch **without diffing the entire tree**.

Only these values may be read for an operation:
- target node in current overlay state;
- guard target paths;
- required parent/anchor information;
- subtree hashes when subtree guards are present.

This requirement is central to performance.

---

## 15. Rebase semantics

`rebasePatch(oldBase, newBase, patch)` MUST:

1. re-validate each operation against `newBase`;
2. preserve operations whose guards still pass;
3. report conflicts for operations whose guards fail;
4. optionally update `baseRevision` if the caller accepts the rebase result.

The first version SHOULD NOT attempt automatic semantic repair beyond anchor-preserving cases explicitly configured by the caller.

### 15.1 Rebase result

```ts
export interface RebaseResult<TTypes extends NodeTypeMap> {
  revision: RevisionStatus;
  rebasedPatch?: TreePatch;
  conflicts: readonly PatchConflict[];
  appliedOpIds: readonly string[];
  skippedOpIds: readonly string[];
  preview?: IndexedTree<TTypes>;
}
```

### 15.2 Optional repair

A future-compatible but optional extension MAY support limited repair rules, for example:
- anchor fallback from `beforeId` to `atEnd` if explicitly enabled;
- updating `attrEquals` to `attrHash` when values exceed a threshold.

Automatic translation conflict resolution is out of scope.

---

## 16. Materialization rules

Materialization turns source + patch into a nested tree view and MUST use the same sequential conflict semantics as `applyPatch()`.

### 16.1 Effective visibility

The engine MUST support these materialization modes:

- `includeHidden: true` → hidden nodes remain present with sidecar visibility metadata;
- `includeHidden: false` → effectively hidden nodes are omitted from the nested result.

Effective visibility MUST follow these rules:

- the root is always effectively visible and MUST NOT be hidden, moved, or removed;
- a node is effectively hidden if the node itself is explicitly hidden **or** any ancestor is effectively hidden;
- `showNode` clears only the explicit hidden flag on the same node;
- `showNode` MUST NOT override a hidden ancestor;
- when `includeHidden: false`, an effectively hidden node and its entire subtree, including patch-owned descendants, MUST be omitted.

### 16.2 Sidecar visibility metadata

Because the library must not define user attribute shape, visibility MUST NOT be stored under `attrs` by default.

The nested materialized view SHOULD expose visibility as sidecar metadata, for example:

```ts
interface MaterializedNode<TTypes extends NodeTypeMap, TType extends keyof TTypes = keyof TTypes> {
  id: NodeId;
  type: TType;
  attrs: TTypes[TType];
  children: readonly MaterializedNode<TTypes>[];
  state?: {
    hidden?: boolean;        // effective hidden state
    patchOwned?: boolean;
  };
}
```

An implementation MAY additionally expose `explicitlyHidden` as non-normative metadata, but `hidden` MUST represent the effective hidden state.

---

## 17. Caching and performance requirements

This section is normative.

### 17.1 Complexity goals

For a document with `n` nodes and tree height `h`:

- initial normalization/indexing SHOULD be `O(n)`;
- point attribute update SHOULD invalidate caches in `O(h)`;
- move operation SHOULD update affected indexes in `O(size of affected sibling regions + h)`;
- patch validation SHOULD be proportional to the number of operations and referenced paths, not full-tree size;
- diff SHOULD prune unchanged subtrees via subtree hashes.

### 17.2 Lazy path hashing

The engine MUST compute path-level hashes lazily.

It MUST NOT pre-hash every attribute path in the document unless explicitly requested.

### 17.3 Equality strategy

For guard or diff comparison of a value path, the engine SHOULD use this strategy:

1. reference equality if possible;
2. primitive equality for scalars;
3. cached path hash if available;
4. adapter hash if available;
5. deep equality as fallback.

### 17.4 Stable subtree hash

Subtree hashing MUST include:

- node `id` by default;
- node `type`;
- canonicalized `attrs` hash;
- ordered child subtree hashes.

The default subtree hash SHOULD ignore transient metadata.

A separate optional content-only hash MAY ignore `id`, but it MUST NOT replace the default subtree hash for revision tracking or equality short-circuiting.

### 17.5 Cache invalidation guarantees

After any mutation, stale cached values MUST NOT be observable through public APIs.

---

## 18. Serialization and persistence

### 18.1 Persisted patch format

Persisted patches MUST include:

- `format` version;
- `patchId`;
- `ops`;
- optional `baseRevision`;
- optional metadata.

Persisted patches MUST NOT include runtime caches.

All persisted patch payload values, guard values, and replacement-subtree attributes MUST be encoded as `PersistedValue`.

If the implementation supports codec envelopes, the chosen envelope format MUST be treated as reserved patch wire syntax, not ordinary user metadata.

### 18.2 Revision token

The library SHOULD support caller-supplied document revisions.

If missing, it MAY compute a deterministic revision token from the root subtree hash.

The default computed revision token MUST be based on the default subtree hash, which includes node `id`.

### 18.3 Forward compatibility

Unknown fields under patch metadata MUST be preserved by read/write cycles.

Unknown operation kinds MUST be rejected unless an extension registry is installed.

Unknown codec IDs MUST be rejected unless a compatible codec registry is installed.

---

## 19. Error model

### 19.1 Programmer errors

The library MUST throw or return typed errors for:

- malformed trees;
- duplicate IDs;
- invalid attribute paths;
- illegal move cycles;
- unsupported value types without adapters;
- ambiguous child positions.

### 19.2 Patch conflicts

Conflicts are **data-level outcomes**, not programmer exceptions.

`validatePatch`, `applyPatch`, and `rebasePatch` MUST return typed conflict results rather than throwing for ordinary guard failures.

---

## 20. Recommended module structure

A recommended package split:

```text
@tree-patch/core      // types, document model, apply/validate/materialize
@tree-patch/diff      // diff generation
@tree-patch/schema    // runtime schema, adapters, path helpers
@tree-patch/editor    // ergonomic patch builder/editor facade
```

A single-package implementation is acceptable for v1 if the modules remain logically separated.

---

## 21. Example workflow

### 21.1 Source tree

```ts
const source: TreeDocument<ContentTypes> = {
  revision: "rev-1",
  root: {
    id: "root",
    type: "Page",
    attrs: {},
    children: [
      {
        id: "hero",
        type: "Hero",
        attrs: {
          title: "Summer Sale",
          subtitle: "Up to 50% off",
          image: { url: "/img/en.png" },
          style: { fontSize: 32 },
        },
        children: [],
      },
      {
        id: "legal-us-only",
        type: "RichText",
        attrs: { html: "<p>US only</p>" },
        children: [],
      },
    ],
  },
};
```

### 21.2 Patch

```ts
const patch = patchBuilder<ContentTypes>()
  .patchId("fr-FR:home")
  .baseRevision("rev-1")
  .setAttr("hero", ["title"], "Promotions d'été", {
    expect: "Summer Sale",
  })
  .setAttr("hero", ["image", "url"], "/img/fr.png", {
    expect: "/img/en.png",
  })
  .setAttr("hero", ["style", "fontSize"], 28, {
    expect: 32,
  })
  .hideNode("legal-us-only")
  .build();
```

### 21.3 Source update without conflict

If the source changes only `hero.subtitle`, the patch MUST still apply.

### 21.4 Source update with conflict

If the source changes `hero.title` from `Summer Sale` to `Big Summer Sale`, the title operation MUST conflict.

---

## 22. Acceptance criteria for v1

The implementation is considered complete for v1 when all of the following are true:

1. It accepts nested trees with generic type-linked attributes.
2. It normalizes trees internally and maintains indexes/caches.
3. It supports `setAttr`, `removeAttr`, `hideNode`, `showNode`, `insertNode`, `moveNode`, `replaceSubtree`, and `removeNode`.
4. It serializes patches as JSON.
5. It validates and applies patches with operation-scoped conflicts.
6. It rebases patches onto new source revisions.
7. It materializes nested output trees.
8. It computes hashes incrementally and avoids full-tree comparisons where not needed.
9. It provides a typed patch builder/editor API.
10. It has deterministic test coverage for conflict detection, move semantics, subtree replacement, and cache invalidation.

---

## 23. Suggested implementation phases

### Phase 1
- core types;
- tree normalization;
- indexes;
- default JSON value adapter;
- `setAttr`, `removeAttr`, `hideNode`, `insertNode`;
- guard validation;
- atomic `applyPatch`;
- nested materialization.

### Phase 2
- move semantics with anchors;
- subtree hash cache;
- `replaceSubtree`;
- `diffTrees`;
- rebase support.

### Phase 3
- typed editor ergonomics;
- schema-driven atomic paths;
- advanced performance tuning;
- extension registry.

---

## 24. Summary of key decisions

- Public API works with **trees**, not only flat maps.
- Internal engine uses **normalized indexes and caches**.
- Attributes are **generic and tied to node type**.
- Conflicts are driven by **guards**, not whole-document equality.
- Structural operations use **stable node IDs and anchors**, not indexes.
- The engine compares **only referenced fields or subtrees**, with lazy hashes and incremental invalidation.
- The design is generic, but optimized for **localization patches over structured content**.
