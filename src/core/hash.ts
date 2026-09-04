import type {
  IndexedTree,
  JsonPointer,
  JsonValue,
  NodeId,
  NodeTypeMap,
} from "./types.js";
import { ensureMutableMapValue } from "./cow.js";
import { InvalidPointerError, UnsupportedRuntimeValueError } from "./errors.js";
import { isPlainObject } from "./snapshot.js";
import { getTreeState, type MutableTreeState } from "./state.js";
import { hashStableParts } from "./stable-hash.js";
import { canonicalizeJsonValue, isJsonValue } from "../schema/adapters.js";
import {
  getNodeRuntimeSpec,
  getValueAdapterForPointer,
  isAtomicPointer,
} from "../schema/schema.js";
import { resolvePointer } from "../schema/pointers.js";
import { ChildHashAggregate } from "./child-hash.js";

export const HASH_VERSION = "h3";

function versionHash(hash: string): string {
  return `${HASH_VERSION}:${hash}`;
}

function canHashAsPlainJson(
  schema: MutableTreeState<NodeTypeMap>["schema"],
  nodeType: string,
  pointer: JsonPointer,
): boolean {
  const spec = getNodeRuntimeSpec(schema, nodeType);
  if (pointer === "") {
    return spec.atomicPointers.length === 0 && spec.adapters.size === 0;
  }
  const containsPointer = (candidate: JsonPointer) =>
    candidate === pointer ||
    candidate.startsWith(`${pointer}/`);
  if (spec.atomicPointers.some(containsPointer)) {
    return false;
  }
  for (const adapterPointer of spec.adapters.keys()) {
    if (containsPointer(adapterPointer)) {
      return false;
    }
  }
  return true;
}

function hashOpaqueValue(
  value: unknown,
  adapter: ReturnType<typeof getValueAdapterForPointer>,
  pointer: JsonPointer,
): string {
  if (adapter?.hash) {
    const adaptedHash = adapter.hash(value as never);
    if (typeof adaptedHash !== "string") {
      throw new UnsupportedRuntimeValueError(
        `Adapter hash() at pointer "${pointer}" must return a string.`,
        { details: { pointer } },
      );
    }
    return hashStableParts(["adapter", adaptedHash]);
  }

  if (adapter?.codec) {
    return hashStableParts([
      "codec",
      adapter.codec.codecId,
      canonicalizeJsonValue(adapter.codec.serialize(value as never)),
    ]);
  }

  if (isJsonValue(value)) {
    return hashStableParts(["json", canonicalizeJsonValue(value)]);
  }

  throw new UnsupportedRuntimeValueError(
    `Value at pointer "${pointer}" is not hashable without an adapter hash() or codec.`,
    {
      details: { pointer },
    },
  );
}

function joinPointer(base: JsonPointer, segment: string | number): JsonPointer {
  const encoded = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return (base === "" ? `/${encoded}` : `${base}/${encoded}`) as JsonPointer;
}

function hashStructuredValue(
  value: unknown,
  nodeType: string,
  pointer: JsonPointer,
  tree: IndexedTree<NodeTypeMap>,
): string {
  const state = getTreeState(tree);
  if (canHashAsPlainJson(state.schema, nodeType, pointer)) {
    return versionHash(hashStableParts([
      "json",
      canonicalizeJsonValue(value as JsonValue),
    ]));
  }

  type Frame =
    | { kind: "value"; value: unknown; pointer: JsonPointer }
    | {
        kind: "container";
        value: object;
        containerKind: "array" | "object";
        keys: readonly string[];
        childCount: number;
      };
  const stack: Frame[] = [{ kind: "value", value, pointer }];
  const hashes: string[] = [];
  const active = new WeakSet<object>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "container") {
      active.delete(frame.value);
      const childHashes = hashes.splice(hashes.length - frame.childCount);
      if (frame.containerKind === "array") {
        hashes.push(hashStableParts((function* () {
          yield "array";
          yield* childHashes;
        })()));
      } else {
        hashes.push(hashStableParts((function* () {
          yield "object";
          for (let index = 0; index < frame.keys.length; index += 1) {
            const key = frame.keys[index]!;
            yield hashStableParts([
              "entry",
              JSON.stringify(key),
              childHashes[index]!,
            ]);
          }
        })()));
      }
      continue;
    }

    const adapter = getValueAdapterForPointer(
      state.schema,
      nodeType,
      frame.pointer,
    );
    if (adapter || isAtomicPointer(state.schema, nodeType, frame.pointer)) {
      hashes.push(hashOpaqueValue(frame.value, adapter, frame.pointer));
      continue;
    }
    if (
      frame.value === null ||
      typeof frame.value === "string" ||
      typeof frame.value === "boolean"
    ) {
      hashes.push(hashStableParts(["primitive", JSON.stringify(frame.value)]));
      continue;
    }
    if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) {
        throw new UnsupportedRuntimeValueError(
          `Non-finite number at pointer "${frame.pointer}" is not supported.`,
          { details: { pointer: frame.pointer } },
        );
      }
      hashes.push(hashStableParts(["primitive", JSON.stringify(frame.value)]));
      continue;
    }
    if (!Array.isArray(frame.value) && !isPlainObject(frame.value)) {
      throw new UnsupportedRuntimeValueError(
        `Value at pointer "${frame.pointer}" is not JSON-compatible and has no registered adapter.`,
        { details: { pointer: frame.pointer } },
      );
    }
    if (active.has(frame.value)) {
      throw new UnsupportedRuntimeValueError(
        `Cyclic runtime value at pointer "${frame.pointer}" is not supported.`,
        { details: { pointer: frame.pointer } },
      );
    }

    active.add(frame.value);
    if (Array.isArray(frame.value)) {
      stack.push({
        kind: "container",
        value: frame.value,
        containerKind: "array",
        keys: [],
        childCount: frame.value.length,
      });
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: frame.value[index],
          pointer: joinPointer(frame.pointer, index),
        });
      }
      continue;
    }

    const keys = Object.keys(frame.value).sort();
    stack.push({
      kind: "container",
      value: frame.value,
      containerKind: "object",
      keys,
      childCount: keys.length,
    });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({
        kind: "value",
        value: frame.value[key],
        pointer: joinPointer(frame.pointer, key),
      });
    }
  }

  return versionHash(hashes[0]!);
}

function getNodeOrThrow<TTypes extends NodeTypeMap>(
  state: MutableTreeState<TTypes>,
  nodeId: string,
) {
  const entry = state.entries.get(nodeId);
  if (!entry) {
    throw new InvalidPointerError(nodeId, `Node "${nodeId}" does not exist in the document.`);
  }

  return entry.node;
}

function getChildHashAggregate<TTypes extends NodeTypeMap>(
  state: MutableTreeState<TTypes>,
  nodeId: NodeId,
  childIds: readonly NodeId[],
): ChildHashAggregate | undefined {
  if (childIds.length === 0) {
    return undefined;
  }

  const cached = state.cache.childHashByParentId.get(nodeId);
  if (cached?.matches(childIds)) {
    return cached;
  }

  const subtreeHashes = state.cache.subtreeHashById;
  const childHashes = new Array<string>(childIds.length);
  for (let index = 0; index < childIds.length; index += 1) {
    const childId = childIds[index]!;
    const childHash = subtreeHashes.get(childId);
    if (!childHash) {
      throw new InvalidPointerError(
        childId,
        `Node "${childId}" cannot be aggregated before its subtree is hashed.`,
      );
    }
    childHashes[index] = childHash;
  }
  const aggregate = ChildHashAggregate.build(childIds, childHashes);
  state.cache.childHashByParentId.set(nodeId, aggregate);
  return aggregate;
}

function updateCachedParentAggregate<TTypes extends NodeTypeMap>(
  state: MutableTreeState<TTypes>,
  nodeId: NodeId,
  subtreeHash: string,
): void {
  const entry = state.entries.get(nodeId);
  const parentId = entry?.parentId;
  if (parentId == null) {
    return;
  }

  // During bulk bottom-up hashing no parent aggregate exists yet, so probe the
  // (small) aggregate cache before touching the full node map.
  const cached = state.cache.childHashByParentId.get(parentId);
  if (!cached) {
    return;
  }

  const parent = state.entries.get(parentId)?.node;
  if (!parent || !cached.matches(parent.childIds)) {
    return;
  }

  const position = entry!.position;
  if (
    parent.childIds[position] !== nodeId ||
    cached.get(position) === subtreeHash
  ) {
    return;
  }

  const aggregate = ensureMutableMapValue(
    state.cache.childHashByParentId,
    parentId,
    (current) =>
      current?.matches(parent.childIds)
        ? current.fork()
        : ChildHashAggregate.build(
            parent.childIds,
            parent.childIds.map((childId) => {
              const childHash = state.cache.subtreeHashById.get(childId);
              if (!childHash) {
                throw new InvalidPointerError(
                  childId,
                  `Node "${childId}" cannot be aggregated before its subtree is hashed.`,
                );
              }
              return childHash;
            }),
          ),
  );
  aggregate.update(position, subtreeHash);
}

function hashRuntimeValueAtPointer<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
  pointer: JsonPointer,
): string {
  const node = getNodeOrThrow(getTreeState(tree), nodeId);
  const resolution = resolvePointer(node.attrs, pointer);
  if (!resolution.ok) {
    throw new InvalidPointerError(
      pointer,
      `Pointer "${pointer}" does not resolve on node "${nodeId}".`,
    );
  }

  return hashStructuredValue(
    resolution.value,
    String(node.type),
    pointer,
    tree as IndexedTree<NodeTypeMap>,
  );
}

function getNodeHashWithState<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  state: MutableTreeState<TTypes>,
  nodeId: string,
): string {
  const cached = state.cache.nodeHashById.get(nodeId);
  if (cached) {
    return cached;
  }

  const node = getNodeOrThrow(state, nodeId);
  const attrsHash = hashStructuredValue(
    node.attrs,
    String(node.type),
    "",
    tree as IndexedTree<NodeTypeMap>,
  );
  const nodeHash = versionHash(
    hashStableParts(["node", node.id, String(node.type), attrsHash]),
  );
  state.cache.nodeHashById.set(nodeId, nodeHash);
  return nodeHash;
}

export function getNodeHash<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
): string {
  return getNodeHashWithState(tree, getTreeState(tree), nodeId);
}

export function getSubtreeHash<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
): string {
  const state = getTreeState(tree);
  const subtreeCache = state.cache.subtreeHashById;
  const cached = subtreeCache.get(nodeId);
  if (cached) {
    return cached;
  }

  // During a fully cold pass (plain-Map caches with no aggregates yet), no
  // ancestor aggregate can exist while its descendants finalize (post-order),
  // so parent-aggregate maintenance is guaranteed to be a no-op.
  const aggregates = state.cache.childHashByParentId;
  const maintainParentAggregates = !(
    aggregates instanceof Map && aggregates.size === 0
  );
  type SubtreeFrame = {
    nodeId: string;
    node: ReturnType<typeof getNodeOrThrow<TTypes>> | null;
    exit: boolean;
  };
  const stack: SubtreeFrame[] = [{ nodeId, node: null, exit: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      const node = frame.node!;
      const childAggregate = getChildHashAggregate(
        state,
        frame.nodeId,
        node.childIds,
      );
      const subtreeHash = versionHash(hashStableParts([
        "subtree",
        getNodeHashWithState(tree, state, frame.nodeId),
        String(node.childIds.length),
        childAggregate?.digest() ?? "",
      ]));
      subtreeCache.set(frame.nodeId, subtreeHash);
      if (maintainParentAggregates) {
        updateCachedParentAggregate(state, frame.nodeId, subtreeHash);
      }
      continue;
    }

    if (subtreeCache.has(frame.nodeId)) {
      continue;
    }

    const node = getNodeOrThrow(state, frame.nodeId);
    stack.push({ nodeId: frame.nodeId, node, exit: true });
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const childId = node.childIds[index]!;
      if (subtreeCache.has(childId)) {
        continue;
      }
      const child = state.entries.get(childId)?.node;
      if (child !== undefined && child.childIds.length === 0) {
        // Leaves have no aggregate; hash them in place without frames.
        const leafHash = versionHash(hashStableParts([
          "subtree",
          getNodeHashWithState(tree, state, childId),
          "0",
          "",
        ]));
        subtreeCache.set(childId, leafHash);
        if (maintainParentAggregates) {
          updateCachedParentAggregate(state, childId, leafHash);
        }
        continue;
      }
      stack.push({ nodeId: childId, node: null, exit: false });
    }
  }

  return subtreeCache.get(nodeId)!;
}

export function getTreeRevisionHash<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
): string {
  const state = getTreeState(tree);
  const hidden = [...state.explicitHidden].sort();
  const patchOwned = [...state.patchOwned].sort();
  const metadata = canonicalizeJsonValue(tree.metadata ?? null);
  const hiddenHash = hashStableParts(["explicit-hidden", ...hidden]);
  const patchOwnedHash = hashStableParts(["patch-owned", ...patchOwned]);
  return `tree:${HASH_VERSION}:${hashStableParts([
    "revision",
    getSubtreeHash(tree, tree.rootId),
    hiddenHash,
    patchOwnedHash,
    metadata,
  ])}`;
}

export function getChildOrderHash(childIds: Iterable<NodeId>): string {
  return versionHash(hashStableParts((function* () {
    yield "child-order";
    yield* childIds;
  })()));
}

export function getPathHash<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
  pointer: JsonPointer,
): string {
  const state = getTreeState(tree);
  const nodePathHashes = ensureMutableMapValue(state.cache.pathHashByNodeId, nodeId, (current) =>
    current ? new Map(current) : new Map<JsonPointer, string>(),
  );

  const cached = nodePathHashes.get(pointer);
  if (cached) {
    return cached;
  }

  const hash = hashRuntimeValueAtPointer(tree, nodeId, pointer);
  nodePathHashes.set(pointer, hash);
  return hash;
}

export function joinJsonPointer(base: JsonPointer, segment: string | number): JsonPointer {
  return joinPointer(base, segment);
}
