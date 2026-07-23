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

  return hashes[0]!;
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

  const stack: Array<{ nodeId: string; exit?: true }> = [{ nodeId }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (state.cache.subtreeHashById.has(frame.nodeId)) {
      continue;
    }

    const node = getNodeOrThrow(tree, frame.nodeId);
    if (frame.exit) {
      state.cache.subtreeHashById.set(
        frame.nodeId,
        hashStableParts((function* () {
          yield "subtree";
          yield getNodeHash(tree, frame.nodeId);
          for (const childId of node.childIds) {
            const childHash = state.cache.subtreeHashById.get(childId);
            if (!childHash) {
              throw new InvalidPointerError(
                childId,
                `Node "${childId}" cannot be hashed before its descendants.`,
              );
            }
            yield childHash;
          }
        })()),
      );
      continue;
    }

    stack.push({ nodeId: frame.nodeId, exit: true });
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const childId = node.childIds[index]!;
      if (!state.cache.subtreeHashById.has(childId)) {
        stack.push({ nodeId: childId });
      }
    }
  }

  return state.cache.subtreeHashById.get(nodeId)!;
}

export function getTreeRevisionHash<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
): string {
  const state = getTreeState(tree);
  const hidden = [...state.explicitHidden].sort();
  const patchOwned = [...state.patchOwned].sort();
  const metadata = canonicalizeJsonValue(tree.metadata ?? null);
  return `tree:${hashStableParts([
    "revision",
    getSubtreeHash(tree, tree.rootId),
    hidden.join("\u0000"),
    patchOwned.join("\u0000"),
    metadata,
  ])}`;
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
