import type {
  ApplyOptions,
  ApplyResult,
  ChildPosition,
  Guard,
  IndexedNode,
  IndexedTree,
  InsertNodeOp,
  JsonPointer,
  MaterializeOptions,
  MaterializeResult,
  MaterializedNode,
  NodeId,
  NodeTypeMap,
  PatchConflict,
  PatchOp,
  PersistedValue,
  RemoveAttrOp,
  RevisionStatus,
  SerializedPatchNode,
  SetAttrOp,
  ShowNodeOp,
  TreePatch,
  ValidateOptions,
  ValidationResult,
} from "./types.js";
import { materializeMap, materializeSet } from "./cow.js";
import { InvalidPointerError, MissingCodecError } from "./errors.js";
import { createReadonlyMapView, deepFreezePlainData, isPlainObject } from "./snapshot.js";
import { attachTreeState } from "./state.js";
import { getPathHash, getSubtreeHash, joinJsonPointer } from "./hash.js";
import {
  cloneJsonValue,
  cloneRuntimeValue,
  deepEqual,
  isEncodedValue,
} from "../schema/adapters.js";
import { parseJsonPointer, resolvePointer } from "../schema/pointers.js";
import { getValueAdapterForPointer } from "../schema/schema.js";
import {
  clearSubtreeState,
  collectSubtreeNodeIds,
  createOverlayState,
  getNode,
  getParentChildIds,
  invalidateNodeCaches,
  invalidateSubtreeHashes,
  reindexSubtreeDepths,
  resolvePositionAgainstChildIds,
  setNode,
  type OverlayState,
  updateSiblingPositions,
} from "./overlay.js";
import {
  assertPatchEnvelope,
  collectSerializedNodeIds,
  normalizePosition,
} from "./patch-validation.js";

interface ExecutionContext<TTypes extends NodeTypeMap> {
  readonly overlay: OverlayState<TTypes>;
}

type OperationResult = { ok: true } | { ok: false; conflict: PatchConflict };

export interface PatchExecutionSession<TTypes extends NodeTypeMap> {
  readonly overlay: OverlayState<TTypes>;
  readonly tree: IndexedTree<TTypes>;
}

export interface ExecutePatchInternalResult<TTypes extends NodeTypeMap> {
  revision: RevisionStatus;
  conflicts: PatchConflict[];
  appliedOps: PatchOp[];
  appliedOpIds: string[];
  skippedOpIds: string[];
  tree?: IndexedTree<TTypes>;
  materialized?: MaterializedNode<TTypes>;
}

function toConflict(
  opId: string,
  kind: PatchConflict["kind"],
  message: string,
  extras: Omit<PatchConflict, "opId" | "kind" | "message"> = {},
): PatchConflict {
  const conflict: PatchConflict = {
    opId,
    kind,
    message,
  };

  if (extras.nodeId !== undefined) {
    conflict.nodeId = extras.nodeId;
  }
  if (extras.path !== undefined) {
    conflict.path = extras.path;
  }
  if (extras.expected !== undefined) {
    conflict.expected = extras.expected;
  }
  if (extras.actual !== undefined) {
    conflict.actual = extras.actual;
  }

  return conflict;
}

function computeRevisionStatus(
  source: IndexedTree<NodeTypeMap>,
  patch: TreePatch,
): RevisionStatus {
  const sourceRevision = source.revision;
  const patchBaseRevision = patch.baseRevision;
  const revision: RevisionStatus = {
    status:
      sourceRevision === undefined || patchBaseRevision === undefined
        ? "unknown"
        : sourceRevision === patchBaseRevision
          ? "match"
          : "mismatch",
  };

  if (sourceRevision !== undefined) {
    revision.sourceRevision = sourceRevision;
  }
  if (patchBaseRevision !== undefined) {
    revision.patchBaseRevision = patchBaseRevision;
  }

  return revision;
}
function getAdapterForPointer<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
) {
  return getValueAdapterForPointer(overlay.schema, nodeType, pointer);
}

function decodePersistedForPointer<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
  value: PersistedValue,
): unknown {
  if (!isEncodedValue(value)) {
    return cloneJsonValue(value);
  }

  const adapter = getAdapterForPointer(overlay, nodeType, pointer);
  const codec = adapter?.codec;
  if (!codec || codec.codecId !== value.$codec) {
    throw new MissingCodecError(
      `Codec "${value.$codec}" is not available for node type "${nodeType}" at pointer "${pointer}".`,
      {
        details: { nodeType, pointer, codecId: value.$codec },
      },
    );
  }

  return codec.deserialize(value.value);
}

function compareValues<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
  actual: unknown,
  expected: unknown,
): boolean {
  const adapter = getAdapterForPointer(overlay, nodeType, pointer);
  if (adapter?.equals) {
    return adapter.equals(actual as never, expected as never);
  }

  return deepEqual(actual, expected);
}

function cloneOwnedRuntimeValue<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
  value: unknown,
): unknown {
  const adapter = getAdapterForPointer(overlay, nodeType, pointer);
  return cloneRuntimeValue(value, adapter, pointer);
}

function decodeSerializedAttrs<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
  value: PersistedValue,
): unknown {
  if (isEncodedValue(value)) {
    return cloneOwnedRuntimeValue(
      overlay,
      nodeType,
      pointer,
      decodePersistedForPointer(overlay, nodeType, pointer, value),
    );
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      decodeSerializedAttrs(
        overlay,
        nodeType,
        joinJsonPointer(pointer, index),
        item as PersistedValue,
      ),
    );
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = decodeSerializedAttrs(
        overlay,
        nodeType,
        joinJsonPointer(pointer, key),
        value[key] as PersistedValue,
      );
    }
    return result;
  }

  return cloneJsonValue(value);
}

function setObjectValue(
  current: unknown,
  segments: readonly string[],
  value: unknown,
): { ok: true; next: unknown } | { ok: false } {
  if (segments.length === 0) {
    return { ok: true, next: value };
  }

  const segment = segments[0]!;
  const rest = segments.slice(1);
  const isLast = rest.length === 0;

  if (Array.isArray(current)) {
    if (!/^(0|[1-9]\d*)$/.test(segment)) {
      return { ok: false };
    }

    const index = Number(segment);
    if (index < 0 || index >= current.length) {
      return { ok: false };
    }

    const clone = current.slice();
    if (isLast) {
      clone[index] = value;
      return { ok: true, next: clone };
    }

    const nested = setObjectValue(current[index], rest, value);
    if (!nested.ok) {
      return nested;
    }

    clone[index] = nested.next;
    return { ok: true, next: clone };
  }

  if (!isPlainObject(current)) {
    return { ok: false };
  }

  const key = segment;
  const clone: Record<string, unknown> = { ...current };
  if (isLast) {
    clone[key] = value;
    return { ok: true, next: clone };
  }

  const existing = clone[key];
  const nextTarget =
    existing === undefined
      ? {}
      : existing;

  if (existing !== undefined && !isPlainObject(existing) && !Array.isArray(existing)) {
    return { ok: false };
  }

  const nested = setObjectValue(nextTarget, rest, value);
  if (!nested.ok) {
    return nested;
  }

  clone[key] = nested.next;
  return { ok: true, next: clone };
}

function removeObjectValue(
  current: unknown,
  segments: readonly string[],
): { ok: true; next: unknown } | { ok: false } {
  if (segments.length === 0) {
    return { ok: false };
  }

  const segment = segments[0]!;
  const rest = segments.slice(1);
  const isLast = rest.length === 0;

  if (Array.isArray(current)) {
    if (!/^(0|[1-9]\d*)$/.test(segment)) {
      return { ok: false };
    }

    const index = Number(segment);
    if (index < 0 || index >= current.length) {
      return { ok: false };
    }

    const clone = current.slice();
    if (isLast) {
      clone.splice(index, 1);
      return { ok: true, next: clone };
    }

    const nested = removeObjectValue(current[index], rest);
    if (!nested.ok) {
      return nested;
    }

    clone[index] = nested.next;
    return { ok: true, next: clone };
  }

  if (!isPlainObject(current)) {
    return { ok: false };
  }

  const key = segment;
  if (!(key in current)) {
    return { ok: false };
  }

  const clone: Record<string, unknown> = { ...current };
  if (isLast) {
    delete clone[key];
    return { ok: true, next: clone };
  }

  const nested = removeObjectValue(clone[key], rest);
  if (!nested.ok) {
    return nested;
  }

  clone[key] = nested.next;
  return { ok: true, next: clone };
}

function evaluateGuards<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  opId: string,
  guards: readonly Guard[] | undefined,
): OperationResult {
  if (!guards || guards.length === 0) {
    return { ok: true };
  }

  for (const guard of guards) {
    const result = evaluateGuard(context, opId, guard);
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true };
}

function evaluateGuard<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  opId: string,
  guard: Guard,
): OperationResult {
  const overlay = context.overlay;

  switch (guard.kind) {
    case "nodeExists":
      if (!overlay.nodes.has(guard.nodeId)) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard nodeExists failed for "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: true, actual: false },
          ),
        };
      }
      return { ok: true };
    case "nodeAbsent":
      if (overlay.nodes.has(guard.nodeId)) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard nodeAbsent failed for "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: false, actual: true },
          ),
        };
      }
      return { ok: true };
    case "nodeTypeIs": {
      const node = overlay.nodes.get(guard.nodeId);
      const actual = node?.type;
      if (!node || String(actual) !== guard.nodeType) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard nodeTypeIs failed for "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: guard.nodeType, actual },
          ),
        };
      }
      return { ok: true };
    }
    case "attrEquals": {
      const node = overlay.nodes.get(guard.nodeId);
      if (!node) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard attrEquals failed because node "${guard.nodeId}" is missing.`,
            { nodeId: guard.nodeId },
          ),
        };
      }

      const resolution = resolvePointer(node.attrs, guard.path);
      if (!resolution.ok) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "PathInvalid",
            `Guard path "${guard.path}" is invalid for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, path: guard.path },
          ),
        };
      }

      const expected = decodePersistedForPointer(
        overlay,
        String(node.type),
        guard.path,
        guard.value,
      );

      if (!compareValues(overlay, String(node.type), guard.path, resolution.value, expected)) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard attrEquals failed for node "${guard.nodeId}" at "${guard.path}".`,
            { nodeId: guard.nodeId, path: guard.path, expected, actual: resolution.value },
          ),
        };
      }
      return { ok: true };
    }
    case "attrHash": {
      const node = overlay.nodes.get(guard.nodeId);
      if (!node) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard attrHash failed because node "${guard.nodeId}" is missing.`,
            { nodeId: guard.nodeId },
          ),
        };
      }

      const resolution = resolvePointer(node.attrs, guard.path);
      if (!resolution.ok) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "PathInvalid",
            `Guard path "${guard.path}" is invalid for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, path: guard.path },
          ),
        };
      }

      const actual = getPathHash(overlay.treeView, guard.nodeId, guard.path);
      if (actual !== guard.hash) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard attrHash failed for node "${guard.nodeId}" at "${guard.path}".`,
            { nodeId: guard.nodeId, path: guard.path, expected: guard.hash, actual },
          ),
        };
      }
      return { ok: true };
    }
    case "subtreeHash": {
      const node = overlay.nodes.get(guard.nodeId);
      if (!node) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard subtreeHash failed because node "${guard.nodeId}" is missing.`,
            { nodeId: guard.nodeId },
          ),
        };
      }

      const actual = getSubtreeHash(overlay.treeView, node.id);
      if (actual !== guard.hash) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard subtreeHash failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: guard.hash, actual },
          ),
        };
      }
      return { ok: true };
    }
    case "parentIs": {
      const actual = overlay.index.parentById.get(guard.nodeId);
      if (!overlay.nodes.has(guard.nodeId) || actual !== guard.parentId) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard parentIs failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: guard.parentId, actual },
          ),
        };
      }
      return { ok: true };
    }
    case "positionAfter": {
      const actualParentId = overlay.index.parentById.get(guard.nodeId);
      const anchorParentId = overlay.index.parentById.get(guard.afterId);
      const parentId = actualParentId ?? undefined;
      if (
        !overlay.nodes.has(guard.nodeId) ||
        !overlay.nodes.has(guard.afterId) ||
        actualParentId == null ||
        actualParentId !== anchorParentId
      ) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionAfter failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: guard.afterId, actual: parentId },
          ),
        };
      }

      const siblings = getParentChildIds(overlay, actualParentId);
      const index = siblings.indexOf(guard.nodeId);
      if (index <= 0 || siblings[index - 1] !== guard.afterId) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionAfter failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: guard.afterId },
          ),
        };
      }
      return { ok: true };
    }
    case "positionBefore": {
      const actualParentId = overlay.index.parentById.get(guard.nodeId);
      const anchorParentId = overlay.index.parentById.get(guard.beforeId);
      if (
        !overlay.nodes.has(guard.nodeId) ||
        !overlay.nodes.has(guard.beforeId) ||
        actualParentId == null ||
        actualParentId !== anchorParentId
      ) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionBefore failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: guard.beforeId },
          ),
        };
      }

      const siblings = getParentChildIds(overlay, actualParentId);
      const index = siblings.indexOf(guard.nodeId);
      if (index === -1 || index + 1 >= siblings.length || siblings[index + 1] !== guard.beforeId) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionBefore failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: guard.beforeId },
          ),
        };
      }
      return { ok: true };
    }
  }
}

function applySetAttr<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: SetAttrOp,
): OperationResult {
  const node = getNode(context.overlay, op.nodeId);
  if (!node) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Node "${op.nodeId}" does not exist.`, {
        nodeId: op.nodeId,
      }),
    };
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  const decodedValue = cloneOwnedRuntimeValue(
    context.overlay,
    String(node.type),
    op.path,
    decodePersistedForPointer(context.overlay, String(node.type), op.path, op.value),
  );
  const result = setObjectValue(node.attrs, parseJsonPointer(op.path), decodedValue);
  if (!result.ok) {
    return {
      ok: false,
      conflict: toConflict(
        op.opId,
        "PathInvalid",
        `Path "${op.path}" is invalid for node "${op.nodeId}".`,
        { nodeId: op.nodeId, path: op.path },
      ),
    };
  }

  setNode(context.overlay, {
    ...node,
    attrs: result.next as IndexedNode<TTypes>["attrs"],
  });
  invalidateNodeCaches(context.overlay, op.nodeId);
  return { ok: true };
}

function applyRemoveAttr<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: RemoveAttrOp,
): OperationResult {
  const node = getNode(context.overlay, op.nodeId);
  if (!node) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Node "${op.nodeId}" does not exist.`, {
        nodeId: op.nodeId,
      }),
    };
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  const result = removeObjectValue(node.attrs, parseJsonPointer(op.path));
  if (!result.ok) {
    return {
      ok: false,
      conflict: toConflict(
        op.opId,
        "PathInvalid",
        `Path "${op.path}" is invalid for node "${op.nodeId}".`,
        { nodeId: op.nodeId, path: op.path },
      ),
    };
  }

  setNode(context.overlay, {
    ...node,
    attrs: result.next as IndexedNode<TTypes>["attrs"],
  });
  invalidateNodeCaches(context.overlay, op.nodeId);
  return { ok: true };
}

function applyHideNode<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: Extract<PatchOp, { kind: "hideNode" }>,
): OperationResult {
  const node = getNode(context.overlay, op.nodeId);
  if (!node) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Node "${op.nodeId}" does not exist.`, {
        nodeId: op.nodeId,
      }),
    };
  }
  if (node.id === context.overlay.rootId) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "IllegalOperation", "The root node cannot be hidden.", {
        nodeId: node.id,
      }),
    };
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  context.overlay.explicitHidden.add(op.nodeId);
  return { ok: true };
}

function applyShowNode<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: Extract<PatchOp, { kind: "showNode" }>,
): OperationResult {
  const node = getNode(context.overlay, op.nodeId);
  if (!node) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Node "${op.nodeId}" does not exist.`, {
        nodeId: op.nodeId,
      }),
    };
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  context.overlay.explicitHidden.delete(op.nodeId);
  return { ok: true };
}

interface NormalizedSubtreeIndexEntry {
  nodeId: NodeId;
  parentId: NodeId | null;
  depth: number;
  position: number;
}

function normalizeSerializedSubtree<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  node: SerializedPatchNode,
  parentId: NodeId | null,
  depth: number,
  position: number,
): {
  nodes: IndexedNode<TTypes>[];
  index: NormalizedSubtreeIndexEntry[];
} {
  const attrs = decodeSerializedAttrs(
    overlay,
    node.type,
    "",
    node.attrs,
  ) as IndexedNode<TTypes>["attrs"];

  const normalizedChildren = node.children.map((child, childIndex) =>
    normalizeSerializedSubtree(overlay, child, node.id, depth + 1, childIndex),
  );

  const indexedNode = {
    id: node.id,
    type: node.type as IndexedNode<TTypes>["type"],
    attrs,
    childIds: normalizedChildren.map((child) => child.nodes[0]!.id),
  } satisfies IndexedNode<TTypes>;

  return {
    nodes: [indexedNode, ...normalizedChildren.flatMap((child) => child.nodes)],
    index: [
      { nodeId: node.id, parentId, depth, position },
      ...normalizedChildren.flatMap((child) => child.index),
    ],
  };
}

function setParentChildIds<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  parentId: NodeId,
  childIds: readonly NodeId[],
): void {
  const parent = getNode(overlay, parentId);
  if (!parent) {
    return;
  }

  setNode(overlay, {
    ...parent,
    childIds: [...childIds],
  });
  overlay.dirtyNodeIds.add(parentId);
}

function sameNodeIdOrder(left: readonly NodeId[], right: readonly NodeId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((nodeId, index) => nodeId === right[index]);
}

function isNodeWithinSubtree<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
  subtreeRootId: NodeId,
): boolean {
  let current: NodeId | null | undefined = nodeId;
  while (current != null) {
    if (current === subtreeRootId) {
      return true;
    }
    current = overlay.index.parentById.get(current);
  }

  return false;
}

function applyInsertNode<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: InsertNodeOp,
): OperationResult {
  const parent = getNode(context.overlay, op.parentId);
  if (!parent) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Parent node "${op.parentId}" does not exist.`, {
        nodeId: op.parentId,
      }),
    };
  }

  const position = normalizePosition(op.position, `patch.ops.${op.opId}.position`);
  const resolvedIndex = resolvePositionAgainstChildIds(
    parent.childIds,
    position,
    op.opId,
    op.parentId,
    toConflict,
  );
  if (!resolvedIndex.ok) {
    return resolvedIndex;
  }

  const subtreeIds = collectSerializedNodeIds(op.node);
  const conflictingId = subtreeIds.find((nodeId) => context.overlay.nodes.has(nodeId));
  if (conflictingId) {
    return {
      ok: false,
      conflict: toConflict(
        op.opId,
        "NodeAlreadyExists",
        `Inserted subtree reuses live node id "${conflictingId}".`,
        { nodeId: conflictingId },
      ),
    };
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  const parentDepth = context.overlay.index.depthById.get(parent.id) ?? 0;
  const normalized = normalizeSerializedSubtree(
    context.overlay,
    op.node,
    parent.id,
    parentDepth + 1,
    resolvedIndex.index,
  );

  const newChildIds = [...parent.childIds];
  newChildIds.splice(resolvedIndex.index, 0, op.node.id);
  setParentChildIds(context.overlay, parent.id, newChildIds);

  normalized.nodes.forEach((node) => {
    setNode(context.overlay, node);
    context.overlay.patchOwned.add(node.id);
  });

  normalized.index.forEach((entry) => {
    context.overlay.index.parentById.set(entry.nodeId, entry.parentId);
    context.overlay.index.depthById.set(entry.nodeId, entry.depth);
    context.overlay.index.positionById.set(entry.nodeId, entry.position);
  });

  updateSiblingPositions(context.overlay, parent.id);
  invalidateSubtreeHashes(context.overlay, parent.id);
  return { ok: true };
}

function applyMoveNode<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: Extract<PatchOp, { kind: "moveNode" }>,
): OperationResult {
  const overlay = context.overlay;
  const node = getNode(overlay, op.nodeId);
  if (!node) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Node "${op.nodeId}" does not exist.`, {
        nodeId: op.nodeId,
      }),
    };
  }
  if (node.id === overlay.rootId) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "IllegalOperation", "The root node cannot be moved.", {
        nodeId: node.id,
      }),
    };
  }

  const newParent = getNode(overlay, op.newParentId);
  if (!newParent) {
    return {
      ok: false,
      conflict: toConflict(
        op.opId,
        "NodeMissing",
        `Parent node "${op.newParentId}" does not exist.`,
        { nodeId: op.newParentId },
      ),
    };
  }

  const currentParentId = overlay.index.parentById.get(op.nodeId);
  if (currentParentId == null) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "IllegalOperation", "The root node cannot be moved.", {
        nodeId: op.nodeId,
      }),
    };
  }

  const position = normalizePosition(op.position, `patch.ops.${op.opId}.position`);
  if (
    position &&
    (("beforeId" in position && position.beforeId === op.nodeId) ||
      ("afterId" in position && position.afterId === op.nodeId))
  ) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "IllegalOperation", "A node cannot use itself as a move anchor.", {
        nodeId: op.nodeId,
      }),
    };
  }

  if (isNodeWithinSubtree(overlay, op.newParentId, op.nodeId)) {
    return {
      ok: false,
      conflict: toConflict(
        op.opId,
        "IllegalOperation",
        `Moving node "${op.nodeId}" under "${op.newParentId}" would create a cycle.`,
        { nodeId: op.nodeId, expected: currentParentId, actual: op.newParentId },
      ),
    };
  }

  if (!overlay.patchOwned.has(op.nodeId) && overlay.patchOwned.has(op.newParentId)) {
    return {
      ok: false,
      conflict: toConflict(
        op.opId,
        "IllegalOperation",
        `Source-backed node "${op.nodeId}" cannot move under patch-owned parent "${op.newParentId}".`,
        { nodeId: op.nodeId, expected: "source-backed parent", actual: op.newParentId },
      ),
    };
  }

  const currentSiblingIds = getParentChildIds(overlay, currentParentId);
  const destinationSiblings =
    currentParentId === op.newParentId
      ? currentSiblingIds.filter((childId) => childId !== op.nodeId)
      : [...getParentChildIds(overlay, op.newParentId)];
  const resolvedIndex = resolvePositionAgainstChildIds(
    destinationSiblings,
    position,
    op.opId,
    op.newParentId,
    toConflict,
  );
  if (!resolvedIndex.ok) {
    return resolvedIndex;
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  const movedChildIds = [...destinationSiblings];
  movedChildIds.splice(resolvedIndex.index, 0, op.nodeId);
  if (currentParentId === op.newParentId && sameNodeIdOrder(movedChildIds, currentSiblingIds)) {
    return { ok: true };
  }

  if (currentParentId === op.newParentId) {
    setParentChildIds(overlay, currentParentId, movedChildIds);
    updateSiblingPositions(overlay, currentParentId);
    invalidateSubtreeHashes(overlay, currentParentId);
    return { ok: true };
  }

  const oldSiblingIds = currentSiblingIds.filter((childId) => childId !== op.nodeId);
  setParentChildIds(overlay, currentParentId, oldSiblingIds);
  setParentChildIds(overlay, newParent.id, movedChildIds);
  overlay.index.parentById.set(op.nodeId, newParent.id);

  const nextDepth = (overlay.index.depthById.get(newParent.id) ?? 0) + 1;
  reindexSubtreeDepths(overlay, op.nodeId, nextDepth);
  updateSiblingPositions(overlay, currentParentId);
  updateSiblingPositions(overlay, newParent.id);
  invalidateSubtreeHashes(overlay, currentParentId);
  invalidateSubtreeHashes(overlay, newParent.id);
  return { ok: true };
}

function applyReplaceSubtree<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: Extract<PatchOp, { kind: "replaceSubtree" }>,
): OperationResult {
  const overlay = context.overlay;
  const target = getNode(overlay, op.nodeId);
  if (!target) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Node "${op.nodeId}" does not exist.`, {
        nodeId: op.nodeId,
      }),
    };
  }

  const replacedSubtreeIds = new Set(collectSubtreeNodeIds(overlay, op.nodeId));
  const replacementIds = collectSerializedNodeIds(op.node);
  for (const replacementId of replacementIds) {
    if (replacementId === op.nodeId) {
      continue;
    }

    if (overlay.nodes.has(replacementId) && !replacedSubtreeIds.has(replacementId)) {
      return {
        ok: false,
        conflict: toConflict(
          op.opId,
          "NodeAlreadyExists",
          `Replacement subtree reuses live node id "${replacementId}".`,
          { nodeId: replacementId },
        ),
      };
    }

    if (replacedSubtreeIds.has(replacementId) && !overlay.patchOwned.has(replacementId)) {
      return {
        ok: false,
        conflict: toConflict(
          op.opId,
          "IllegalOperation",
          `Replacement subtree cannot reuse removed source-backed descendant id "${replacementId}".`,
          { nodeId: replacementId },
        ),
      };
    }
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  const parentId = overlay.index.parentById.get(op.nodeId) ?? null;
  const depth = overlay.index.depthById.get(op.nodeId) ?? 0;
  const position = overlay.index.positionById.get(op.nodeId) ?? 0;
  const rootWasPatchOwned = overlay.patchOwned.has(op.nodeId);
  const rootWasExplicitlyHidden = overlay.explicitHidden.has(op.nodeId);

  const removedDescendantIds = [...replacedSubtreeIds].filter((nodeId) => nodeId !== op.nodeId);
  clearSubtreeState(overlay, removedDescendantIds);

  const normalized = normalizeSerializedSubtree(
    overlay,
    op.node,
    parentId,
    depth,
    position,
  );

  normalized.nodes.forEach((node) => {
    setNode(overlay, node);
    if (node.id === op.nodeId) {
      if (rootWasPatchOwned) {
        overlay.patchOwned.add(node.id);
      } else {
        overlay.patchOwned.delete(node.id);
      }

      if (rootWasExplicitlyHidden) {
        overlay.explicitHidden.add(node.id);
      } else {
        overlay.explicitHidden.delete(node.id);
      }
      return;
    }

    overlay.patchOwned.add(node.id);
    overlay.explicitHidden.delete(node.id);
  });

  normalized.index.forEach((entry) => {
    overlay.index.parentById.set(entry.nodeId, entry.parentId);
    overlay.index.depthById.set(entry.nodeId, entry.depth);
    overlay.index.positionById.set(entry.nodeId, entry.position);
  });

  invalidateNodeCaches(overlay, op.nodeId);
  return { ok: true };
}

function applyRemoveNode<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: Extract<PatchOp, { kind: "removeNode" }>,
): OperationResult {
  const overlay = context.overlay;
  const node = getNode(overlay, op.nodeId);
  if (!node) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "NodeMissing", `Node "${op.nodeId}" does not exist.`, {
        nodeId: op.nodeId,
      }),
    };
  }
  if (node.id === overlay.rootId) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "IllegalOperation", "The root node cannot be removed.", {
        nodeId: node.id,
      }),
    };
  }
  if (!overlay.patchOwned.has(op.nodeId)) {
    return {
      ok: false,
      conflict: toConflict(
        op.opId,
        "IllegalOperation",
        `Source-backed node "${op.nodeId}" cannot be removed.`,
        { nodeId: op.nodeId },
      ),
    };
  }

  const parentId = overlay.index.parentById.get(op.nodeId);
  if (parentId == null) {
    return {
      ok: false,
      conflict: toConflict(op.opId, "IllegalOperation", "The root node cannot be removed.", {
        nodeId: op.nodeId,
      }),
    };
  }

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  const removedIds = collectSubtreeNodeIds(overlay, op.nodeId);
  const siblingIds = getParentChildIds(overlay, parentId).filter((childId) => childId !== op.nodeId);
  setParentChildIds(overlay, parentId, siblingIds);
  clearSubtreeState(overlay, removedIds);
  updateSiblingPositions(overlay, parentId);
  invalidateSubtreeHashes(overlay, parentId);
  return { ok: true };
}

function applyOperation<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  op: PatchOp,
): OperationResult {
  switch (op.kind) {
    case "setAttr":
      return applySetAttr(context, op);
    case "removeAttr":
      return applyRemoveAttr(context, op);
    case "hideNode":
      return applyHideNode(context, op);
    case "showNode":
      return applyShowNode(context, op);
    case "insertNode":
      return applyInsertNode(context, op);
    case "moveNode":
      return applyMoveNode(context, op);
    case "replaceSubtree":
      return applyReplaceSubtree(context, op);
    case "removeNode":
      return applyRemoveNode(context, op);
  }
}

export function createPatchExecutionSession<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
): PatchExecutionSession<TTypes> {
  const overlay = createOverlayState(source);
  return {
    overlay,
    tree: overlay.treeView,
  };
}

export function applyOperationInSession<TTypes extends NodeTypeMap>(
  session: PatchExecutionSession<TTypes>,
  op: PatchOp,
): OperationResult {
  return applyOperation({ overlay: session.overlay }, op);
}

function freezeNodeForSnapshot<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  node: IndexedNode<TTypes>,
): IndexedNode<TTypes> {
  if (!overlay.dirtyNodeIds.has(node.id) && !overlay.patchOwned.has(node.id)) {
    return node;
  }

  return Object.freeze({
    ...node,
    attrs: deepFreezePlainData(node.attrs),
    childIds: Object.freeze([...node.childIds]),
  }) as IndexedNode<TTypes>;
}

function buildSnapshotFromOverlay<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
): IndexedTree<TTypes> {
  const frozenNodes = new Map<NodeId, IndexedNode<TTypes>>();
  for (const [nodeId, node] of overlay.nodes) {
    frozenNodes.set(nodeId, freezeNodeForSnapshot(overlay, node));
  }

  const pathHashByNodeId = new Map<NodeId, Map<JsonPointer, string>>();
  for (const [nodeId, hashes] of overlay.cache.pathHashByNodeId) {
    pathHashByNodeId.set(nodeId, materializeMap(hashes));
  }

  overlay.nodes = frozenNodes;
  overlay.index.parentById = materializeMap(overlay.index.parentById);
  overlay.index.positionById = materializeMap(overlay.index.positionById);
  overlay.index.depthById = materializeMap(overlay.index.depthById);
  overlay.cache.nodeHashById = materializeMap(overlay.cache.nodeHashById);
  overlay.cache.subtreeHashById = materializeMap(overlay.cache.subtreeHashById);
  overlay.cache.pathHashByNodeId = pathHashByNodeId;
  overlay.explicitHidden = materializeSet(overlay.explicitHidden);
  overlay.patchOwned = materializeSet(overlay.patchOwned);

  const tree = {
    rootId: overlay.rootId,
    nodes: createReadonlyMapView(overlay.nodes),
    index: Object.freeze({
      parentById: createReadonlyMapView(overlay.index.parentById),
      positionById: createReadonlyMapView(overlay.index.positionById),
      depthById: createReadonlyMapView(overlay.index.depthById),
    }),
    cache: Object.freeze({
      nodeHashById: createReadonlyMapView(overlay.cache.nodeHashById),
      subtreeHashById: createReadonlyMapView(overlay.cache.subtreeHashById),
      pathHashByNodeId: createReadonlyMapView(overlay.cache.pathHashByNodeId),
    }),
  } as IndexedTree<TTypes>;

  if (overlay.metadata !== undefined) {
    tree.metadata = overlay.metadata;
  }

  attachTreeState(tree, overlay);
  tree.revision = getSubtreeHash(tree, overlay.rootId);
  return Object.freeze(tree);
}

function buildMaterializedTree<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
  includeHidden: boolean,
  ancestorHidden: boolean,
): MaterializedNode<TTypes> | null {
  const node = overlay.nodes.get(nodeId);
  if (!node) {
    return null;
  }

  const explicitlyHidden = overlay.explicitHidden.has(nodeId);
  const hidden = ancestorHidden || explicitlyHidden;
  if (hidden && !includeHidden) {
    return null;
  }

  const children = node.childIds
    .map((childId) => buildMaterializedTree(overlay, childId, includeHidden, hidden))
    .filter((child): child is MaterializedNode<TTypes> => child !== null);

  const state: MaterializedNode<TTypes>["state"] = {};
  if (hidden) {
    state.hidden = true;
  }
  if (overlay.patchOwned.has(nodeId)) {
    state.patchOwned = true;
  }
  if (explicitlyHidden) {
    state.explicitlyHidden = true;
  }

  const materialized: MaterializedNode<TTypes> = {
    id: node.id,
    type: node.type,
    attrs: node.attrs,
    children,
  };
  if (Object.keys(state).length > 0) {
    materialized.state = state;
  }
  return materialized;
}

export function executePatchInternal<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: {
    mode: "atomic" | "preview";
    includeHidden: boolean;
    produceTree: boolean;
  },
): ExecutePatchInternalResult<TTypes> {
  assertPatchEnvelope(patch);

  const session = createPatchExecutionSession(source);
  const conflicts: PatchConflict[] = [];
  const appliedOps: PatchOp[] = [];
  const appliedOpIds: string[] = [];
  const skippedOpIds: string[] = [];

  for (const op of patch.ops) {
    const result = applyOperationInSession(session, op);
    if (!result.ok) {
      conflicts.push(result.conflict);
      skippedOpIds.push(op.opId);
      if (options.mode === "atomic") {
        break;
      }
      continue;
    }

    appliedOps.push(op);
    appliedOpIds.push(op.opId);
  }

  const revision = computeRevisionStatus(source as IndexedTree<NodeTypeMap>, patch);
  if (!options.produceTree || (conflicts.length > 0 && options.mode === "atomic")) {
    return { revision, conflicts, appliedOps, appliedOpIds, skippedOpIds };
  }

  const tree = buildSnapshotFromOverlay(session.overlay);
  const materialized = buildMaterializedTree(
    session.overlay,
    session.overlay.rootId,
    options.includeHidden,
    false,
  ) as MaterializedNode<TTypes>;

  return {
    revision,
    conflicts,
    appliedOps,
    appliedOpIds,
    skippedOpIds,
    tree,
    materialized,
  };
}

export function validatePatch<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: ValidateOptions = {},
): ValidationResult {
  const result = executePatchInternal(source, patch, {
    mode: options.mode ?? "atomic",
    includeHidden: true,
    produceTree: false,
  });

  if (result.conflicts.length > 0) {
    return {
      status: "conflict",
      revision: result.revision,
      conflicts: result.conflicts,
    };
  }

  return {
    status: "valid",
    revision: result.revision,
  };
}

export function applyPatch<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: ApplyOptions = {},
): ApplyResult<TTypes> {
  const result = executePatchInternal(source, patch, {
    mode: options.mode ?? "atomic",
    includeHidden: options.includeHidden ?? true,
    produceTree: true,
  });

  if (result.conflicts.length > 0 && (options.mode ?? "atomic") === "atomic") {
    return {
      status: "conflict",
      revision: result.revision,
      conflicts: result.conflicts,
    };
  }

  if (result.conflicts.length > 0) {
    return {
      status: "preview",
      revision: result.revision,
      tree: result.tree as IndexedTree<TTypes>,
      materialized: result.materialized as MaterializedNode<TTypes>,
      conflicts: result.conflicts,
    };
  }

  return {
    status: "applied",
    revision: result.revision,
    tree: result.tree as IndexedTree<TTypes>,
    materialized: result.materialized as MaterializedNode<TTypes>,
  };
}

export function materialize<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: MaterializeOptions = {},
): MaterializeResult<TTypes> {
  return applyPatch(source, patch, options);
}
