import type { IndexedTree, JsonPointer, NodeTypeMap } from "./types.js";
import { ensureMutableMapValue } from "./cow.js";
import { InvalidPointerError, UnsupportedRuntimeValueError } from "./errors.js";
import { isPlainObject } from "./snapshot.js";
import { getTreeState } from "./state.js";
import { hashStableParts } from "./stable-hash.js";
import { canonicalizeJsonValue, isJsonValue } from "../schema/adapters.js";
import { getValueAdapterForPointer, isAtomicPointer } from "../schema/schema.js";
import { resolvePointer } from "../schema/pointers.js";

function hashOpaqueValue(
  value: unknown,
  adapter: ReturnType<typeof getValueAdapterForPointer>,
  pointer: JsonPointer,
): string {
  if (adapter?.hash) {
    return hashStableParts(["adapter", adapter.hash(value as never)]);
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
  const adapter = getValueAdapterForPointer(state.schema, nodeType, pointer);

  if (adapter || isAtomicPointer(state.schema, nodeType, pointer)) {
    return hashOpaqueValue(value, adapter, pointer);
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return hashStableParts(["primitive", JSON.stringify(value)]);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new UnsupportedRuntimeValueError(
        `Non-finite number at pointer "${pointer}" is not supported.`,
        {
          details: { pointer },
        },
      );
    }

    return hashStableParts(["primitive", JSON.stringify(value)]);
  }

  if (Array.isArray(value)) {
    const childHashes = value.map((item, index) =>
      hashStructuredValue(item, nodeType, joinPointer(pointer, index), tree),
    );
    return hashStableParts(["array", ...childHashes]);
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const childHashes = keys.map((key) =>
      hashStableParts([
        "entry",
        JSON.stringify(key),
        hashStructuredValue(value[key], nodeType, joinPointer(pointer, key), tree),
      ]),
    );
    return hashStableParts(["object", ...childHashes]);
  }

  throw new UnsupportedRuntimeValueError(
    `Value at pointer "${pointer}" is not JSON-compatible and has no registered adapter.`,
    {
      details: { pointer },
    },
  );
}

function getNodeOrThrow<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
) {
  const node = tree.nodes.get(nodeId);
  if (!node) {
    throw new InvalidPointerError(nodeId, `Node "${nodeId}" does not exist in the document.`);
  }

  return node;
}

function hashRuntimeValueAtPointer<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
  pointer: JsonPointer,
): string {
  const node = getNodeOrThrow(tree, nodeId);
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

export function getNodeHash<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
): string {
  const state = getTreeState(tree);
  const cached = state.cache.nodeHashById.get(nodeId);
  if (cached) {
    return cached;
  }

  const node = getNodeOrThrow(tree, nodeId);
  const attrsHash = hashStructuredValue(
    node.attrs,
    String(node.type),
    "",
    tree as IndexedTree<NodeTypeMap>,
  );
  const nodeHash = hashStableParts(["node", node.id, String(node.type), attrsHash]);
  state.cache.nodeHashById.set(nodeId, nodeHash);
  return nodeHash;
}

export function getSubtreeHash<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: string,
): string {
  const state = getTreeState(tree);
  const cached = state.cache.subtreeHashById.get(nodeId);
  if (cached) {
    return cached;
  }

  const node = getNodeOrThrow(tree, nodeId);
  const childHashes = node.childIds.map((childId) => getSubtreeHash(tree, childId));
  const subtreeHash = hashStableParts(["subtree", getNodeHash(tree, nodeId), ...childHashes]);
  state.cache.subtreeHashById.set(nodeId, subtreeHash);
  return subtreeHash;
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
