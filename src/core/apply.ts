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
import {
  AmbiguousPositionError,
  InvalidPointerError,
  MalformedPatchError,
  MissingCodecError,
  UnsupportedPatchOperationError,
} from "./errors.js";
import { createReadonlyMapView, deepFreezePlainData, isPlainObject } from "./snapshot.js";
import { attachTreeState, getTreeState, type MutableTreeState } from "./state.js";
import { getPathHash, getSubtreeHash, joinJsonPointer } from "./hash.js";
import {
  cloneJsonValue,
  cloneRuntimeValue,
  decodePersistedValue,
  deepEqual,
  isEncodedValue,
  isJsonValue,
} from "../schema/adapters.js";
import { parseJsonPointer, resolvePointer } from "../schema/pointers.js";
import { getValueAdapterForPointer } from "../schema/schema.js";

type SupportedPhase2Op = SetAttrOp | RemoveAttrOp | InsertNodeOp | ShowNodeOp | PatchOp;

interface OverlayState<TTypes extends NodeTypeMap> extends MutableTreeState<TTypes> {
  readonly rootId: NodeId;
  readonly metadata?: Record<string, unknown>;
  treeView: IndexedTree<TTypes>;
  readonly dirtyNodeIds: Set<NodeId>;
  readonly dirtyPathHashNodeIds: Set<NodeId>;
  readonly dirtySubtreeNodeIds: Set<NodeId>;
}

interface ExecutionContext<TTypes extends NodeTypeMap> {
  readonly source: IndexedTree<TTypes>;
  readonly patch: TreePatch;
  readonly overlay: OverlayState<TTypes>;
  readonly mode: "atomic" | "preview";
}

type OperationResult = { ok: true } | { ok: false; conflict: PatchConflict };

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

function validatePersistedValueShape(value: unknown, location: string): void {
  if (isEncodedValue(value as PersistedValue)) {
    return;
  }

  if (isJsonValue(value)) {
    return;
  }

  throw new MalformedPatchError(`${location} must be JSON-serializable or an encoded persisted value.`, {
    details: { location },
  });
}

function assertSerializedPatchNode(
  node: unknown,
  location: string,
  seenIds: Set<string>,
): asserts node is SerializedPatchNode {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new MalformedPatchError(`${location} must be a serialized patch node object.`, {
      details: { location },
    });
  }

  const candidate = node as Record<string, unknown>;
  if (typeof candidate.id !== "string") {
    throw new MalformedPatchError(`${location}.id must be a string.`, {
      details: { location },
    });
  }
  if (typeof candidate.type !== "string") {
    throw new MalformedPatchError(`${location}.type must be a string.`, {
      details: { location },
    });
  }
  if (!("attrs" in candidate)) {
    throw new MalformedPatchError(`${location}.attrs is required.`, {
      details: { location },
    });
  }
  if (!Array.isArray(candidate.children)) {
    throw new MalformedPatchError(`${location}.children must be an array.`, {
      details: { location },
    });
  }

  if (seenIds.has(candidate.id)) {
    throw new MalformedPatchError(
      `Serialized patch subtree at ${location} reuses node id "${candidate.id}".`,
      {
        details: { location, nodeId: candidate.id },
      },
    );
  }

  seenIds.add(candidate.id);
  validatePersistedValueShape(candidate.attrs, `${location}.attrs`);

  candidate.children.forEach((child, index) => {
    assertSerializedPatchNode(child, `${location}.children[${index}]`, seenIds);
  });
}

function normalizePosition(
  position: unknown,
  location: string,
): ChildPosition | undefined {
  if (position === undefined) {
    return undefined;
  }

  if (!position || typeof position !== "object" || Array.isArray(position)) {
    throw new MalformedPatchError(`${location} must be an object when provided.`, {
      details: { location },
    });
  }

  const entries = Object.entries(position as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length !== 1) {
    throw new AmbiguousPositionError(
      `${location} must contain exactly one of beforeId, afterId, atStart, or atEnd.`,
      {
        details: { location, providedKeys: Object.keys(position as Record<string, unknown>) },
      },
    );
  }

  const [key, value] = entries[0]!;
  switch (key) {
    case "beforeId":
      if (typeof value !== "string") {
        throw new MalformedPatchError(`${location}.beforeId must be a string.`, {
          details: { location },
        });
      }
      return { beforeId: value };
    case "afterId":
      if (typeof value !== "string") {
        throw new MalformedPatchError(`${location}.afterId must be a string.`, {
          details: { location },
        });
      }
      return { afterId: value };
    case "atStart":
      if (value !== true) {
        throw new MalformedPatchError(`${location}.atStart must be true when provided.`, {
          details: { location },
        });
      }
      return { atStart: true };
    case "atEnd":
      if (value !== true) {
        throw new MalformedPatchError(`${location}.atEnd must be true when provided.`, {
          details: { location },
        });
      }
      return { atEnd: true };
    default:
      throw new AmbiguousPositionError(
        `${location} contains unsupported key "${key}".`,
        {
          details: { location, key },
        },
      );
  }
}

function assertGuard(guard: unknown, location: string): asserts guard is Guard {
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) {
    throw new MalformedPatchError(`${location} must be a guard object.`, {
      details: { location },
    });
  }

  const candidate = guard as Record<string, unknown>;
  if (typeof candidate.kind !== "string") {
    throw new MalformedPatchError(`${location}.kind must be a string.`, {
      details: { location },
    });
  }

  switch (candidate.kind) {
    case "nodeExists":
    case "nodeAbsent":
      if (typeof candidate.nodeId !== "string") {
        throw new MalformedPatchError(`${location}.nodeId must be a string.`, {
          details: { location },
        });
      }
      return;
    case "nodeTypeIs":
      if (typeof candidate.nodeId !== "string" || typeof candidate.nodeType !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and nodeType.`, {
          details: { location },
        });
      }
      return;
    case "attrEquals":
      if (typeof candidate.nodeId !== "string" || typeof candidate.path !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and path.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      validatePersistedValueShape(candidate.value, `${location}.value`);
      return;
    case "attrHash":
      if (
        typeof candidate.nodeId !== "string" ||
        typeof candidate.path !== "string" ||
        typeof candidate.hash !== "string"
      ) {
        throw new MalformedPatchError(`${location} must include string nodeId, path, and hash.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      return;
    case "subtreeHash":
      if (typeof candidate.nodeId !== "string" || typeof candidate.hash !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and hash.`, {
          details: { location },
        });
      }
      return;
    case "parentIs":
      if (
        typeof candidate.nodeId !== "string" ||
        (candidate.parentId !== null && typeof candidate.parentId !== "string")
      ) {
        throw new MalformedPatchError(`${location} must include string nodeId and string|null parentId.`, {
          details: { location },
        });
      }
      return;
    case "positionAfter":
      if (typeof candidate.nodeId !== "string" || typeof candidate.afterId !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and afterId.`, {
          details: { location },
        });
      }
      return;
    case "positionBefore":
      if (typeof candidate.nodeId !== "string" || typeof candidate.beforeId !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and beforeId.`, {
          details: { location },
        });
      }
      return;
    default:
      throw new UnsupportedPatchOperationError(`Unsupported guard kind "${candidate.kind}".`, {
        details: { location, kind: candidate.kind },
      });
  }
}

function assertPatchOp(op: unknown, index: number): asserts op is PatchOp {
  const location = `patch.ops[${index}]`;
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new MalformedPatchError(`${location} must be an operation object.`, {
      details: { location },
    });
  }

  const candidate = op as Record<string, unknown>;
  if (typeof candidate.kind !== "string") {
    throw new MalformedPatchError(`${location}.kind must be a string.`, {
      details: { location },
    });
  }
  if (typeof candidate.opId !== "string") {
    throw new MalformedPatchError(`${location}.opId must be a string.`, {
      details: { location },
    });
  }

  if (candidate.guards !== undefined) {
    if (!Array.isArray(candidate.guards)) {
      throw new MalformedPatchError(`${location}.guards must be an array when provided.`, {
        details: { location },
      });
    }
    candidate.guards.forEach((guard, guardIndex) => {
      assertGuard(guard, `${location}.guards[${guardIndex}]`);
    });
  }

  switch (candidate.kind) {
    case "setAttr":
      if (
        typeof candidate.nodeId !== "string" ||
        typeof candidate.path !== "string"
      ) {
        throw new MalformedPatchError(`${location} must include string nodeId and path.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      validatePersistedValueShape(candidate.value, `${location}.value`);
      return;
    case "removeAttr":
      if (
        typeof candidate.nodeId !== "string" ||
        typeof candidate.path !== "string"
      ) {
        throw new MalformedPatchError(`${location} must include string nodeId and path.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      return;
    case "hideNode":
    case "showNode":
      if (typeof candidate.nodeId !== "string") {
        throw new MalformedPatchError(`${location}.nodeId must be a string.`, {
          details: { location },
        });
      }
      return;
    case "insertNode": {
      if (typeof candidate.parentId !== "string") {
        throw new MalformedPatchError(`${location}.parentId must be a string.`, {
          details: { location },
        });
      }
      normalizePosition(candidate.position, `${location}.position`);
      assertSerializedPatchNode(candidate.node, `${location}.node`, new Set<string>());
      return;
    }
    case "moveNode":
    case "replaceSubtree":
    case "removeNode":
      throw new UnsupportedPatchOperationError(
        `Patch operation "${candidate.kind}" is not implemented in Phase 2.`,
        {
          details: { location, kind: candidate.kind },
        },
      );
    default:
      throw new UnsupportedPatchOperationError(`Unsupported patch operation kind "${candidate.kind}".`, {
        details: { location, kind: candidate.kind },
      });
  }
}

function assertPatchEnvelope(patch: unknown): asserts patch is TreePatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new MalformedPatchError("Patch must be an object.", {
      details: { patch },
    });
  }

  const candidate = patch as Record<string, unknown>;
  if (candidate.format !== "tree-patch/v1") {
    throw new MalformedPatchError('Patch format must be "tree-patch/v1".', {
      details: { format: candidate.format },
    });
  }
  if (typeof candidate.patchId !== "string") {
    throw new MalformedPatchError("Patch patchId must be a string.", {
      details: { patchId: candidate.patchId },
    });
  }
  if (candidate.baseRevision !== undefined && typeof candidate.baseRevision !== "string") {
    throw new MalformedPatchError("Patch baseRevision must be a string when provided.", {
      details: { baseRevision: candidate.baseRevision },
    });
  }
  if (!Array.isArray(candidate.ops)) {
    throw new MalformedPatchError("Patch ops must be an array.", {
      details: { ops: candidate.ops },
    });
  }

  const seenOpIds = new Set<string>();
  candidate.ops.forEach((op, index) => {
    assertPatchOp(op, index);
    if (seenOpIds.has(op.opId)) {
      throw new MalformedPatchError(`Duplicate opId "${op.opId}" detected in patch.`, {
        details: { opId: op.opId },
      });
    }
    seenOpIds.add(op.opId);
  });
}

function cloneCache(cache: MutableTreeState<NodeTypeMap>["cache"]): MutableTreeState<NodeTypeMap>["cache"] {
  return {
    nodeHashById: new Map(cache.nodeHashById),
    subtreeHashById: new Map(cache.subtreeHashById),
    pathHashByNodeId: new Map(
      [...cache.pathHashByNodeId].map(([nodeId, hashes]) => [nodeId, new Map(hashes)]),
    ),
  };
}

function createOverlayState<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
): OverlayState<TTypes> {
  const sourceState = getTreeState(source);
  const state = {
    ownership: sourceState.ownership,
    schema: sourceState.schema,
    nodes: new Map(sourceState.nodes),
    index: {
      parentById: new Map(sourceState.index.parentById),
      positionById: new Map(sourceState.index.positionById),
      depthById: new Map(sourceState.index.depthById),
    },
    cache: cloneCache(sourceState.cache) as MutableTreeState<TTypes>["cache"],
    explicitHidden: new Set(sourceState.explicitHidden),
    patchOwned: new Set(sourceState.patchOwned),
    rootId: source.rootId,
    metadata: source.metadata,
    dirtyNodeIds: new Set<NodeId>(),
    dirtyPathHashNodeIds: new Set<NodeId>(),
    dirtySubtreeNodeIds: new Set<NodeId>(),
  } as OverlayState<TTypes>;

  const treeView = {
    rootId: source.rootId,
    nodes: state.nodes,
    index: {
      parentById: state.index.parentById,
      positionById: state.index.positionById,
      depthById: state.index.depthById,
    },
    cache: {
      nodeHashById: state.cache.nodeHashById,
      subtreeHashById: state.cache.subtreeHashById,
      pathHashByNodeId: state.cache.pathHashByNodeId,
    },
  } as IndexedTree<TTypes>;

  if (source.revision !== undefined) {
    treeView.revision = source.revision;
  }
  if (source.metadata !== undefined) {
    treeView.metadata = source.metadata;
  }

  state.treeView = treeView;
  attachTreeState(treeView, state);
  return state;
}

function invalidateNodeCaches<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
): void {
  overlay.cache.nodeHashById.delete(nodeId);
  overlay.cache.pathHashByNodeId.delete(nodeId);
  overlay.dirtyNodeIds.add(nodeId);
  overlay.dirtyPathHashNodeIds.add(nodeId);

  let current: NodeId | null | undefined = nodeId;
  while (current != null) {
    overlay.cache.subtreeHashById.delete(current);
    overlay.dirtySubtreeNodeIds.add(current);
    current = overlay.index.parentById.get(current);
  }
}

function invalidateSubtreeHashes<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
): void {
  let current: NodeId | null | undefined = nodeId;
  while (current != null) {
    overlay.cache.subtreeHashById.delete(current);
    overlay.dirtySubtreeNodeIds.add(current);
    current = overlay.index.parentById.get(current);
  }
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

function getNode<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
): IndexedNode<TTypes> | undefined {
  return overlay.nodes.get(nodeId);
}

function setNode<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  node: IndexedNode<TTypes>,
): void {
  overlay.nodes.set(node.id, node);
}

function getParentChildIds<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  parentId: NodeId,
): readonly NodeId[] {
  const parent = overlay.nodes.get(parentId);
  return parent?.childIds ?? [];
}

function updateSiblingPositions<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  parentId: NodeId,
): void {
  const childIds = getParentChildIds(overlay, parentId);
  childIds.forEach((childId, index) => {
    overlay.index.positionById.set(childId, index);
  });
}

function resolveInsertIndex<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  parentId: NodeId,
  position: ChildPosition | undefined,
  opId: string,
): { ok: true; index: number } | { ok: false; conflict: PatchConflict } {
  const childIds = getParentChildIds(overlay, parentId);

  if (!position || "atEnd" in position) {
    return { ok: true, index: childIds.length };
  }

  if ("atStart" in position) {
    return { ok: true, index: 0 };
  }

  if ("beforeId" in position) {
    const index = childIds.indexOf(position.beforeId);
    if (index === -1) {
      return {
        ok: false,
        conflict: toConflict(
          opId,
          "AnchorMissing",
          `Anchor node "${position.beforeId}" is not a child of "${parentId}".`,
          { nodeId: parentId },
        ),
      };
    }
    return { ok: true, index };
  }

  const index = childIds.indexOf(position.afterId);
  if (index === -1) {
    return {
      ok: false,
      conflict: toConflict(
        opId,
        "AnchorMissing",
        `Anchor node "${position.afterId}" is not a child of "${parentId}".`,
        { nodeId: parentId },
      ),
    };
  }
  return { ok: true, index: index + 1 };
}

function collectSerializedNodeIds(node: SerializedPatchNode, collected: NodeId[] = []): NodeId[] {
  collected.push(node.id);
  node.children.forEach((child) => collectSerializedNodeIds(child, collected));
  return collected;
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

function normalizeInsertedSubtree<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  node: SerializedPatchNode,
  parentId: NodeId,
  depth: number,
  position: number,
): {
  nodes: IndexedNode<TTypes>[];
  index: Array<{ nodeId: NodeId; parentId: NodeId; depth: number; position: number }>;
} {
  const attrs = decodeSerializedAttrs(
    overlay,
    node.type,
    "",
    node.attrs,
  ) as IndexedNode<TTypes>["attrs"];

  const normalizedChildren = node.children.map((child, childIndex) =>
    normalizeInsertedSubtree(overlay, child, node.id, depth + 1, childIndex),
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
  const resolvedIndex = resolveInsertIndex(context.overlay, op.parentId, position, op.opId);
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
  const normalized = normalizeInsertedSubtree(
    context.overlay,
    op.node,
    parent.id,
    parentDepth + 1,
    resolvedIndex.index,
  );

  const newChildIds = [...parent.childIds];
  newChildIds.splice(resolvedIndex.index, 0, op.node.id);
  setNode(context.overlay, {
    ...parent,
    childIds: newChildIds,
  });
  context.overlay.dirtyNodeIds.add(parent.id);

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
    case "replaceSubtree":
    case "removeNode":
      throw new UnsupportedPatchOperationError(
        `Patch operation "${op.kind}" is not implemented in Phase 2.`,
        {
          details: { kind: op.kind, opId: op.opId },
        },
      );
  }
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

  overlay.nodes = frozenNodes;

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

function executePatch<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: {
    mode: "atomic" | "preview";
    includeHidden: boolean;
    produceTree: boolean;
  },
): {
  revision: RevisionStatus;
  conflicts: PatchConflict[];
  tree?: IndexedTree<TTypes>;
  materialized?: MaterializedNode<TTypes>;
} {
  assertPatchEnvelope(patch);

  const overlay = createOverlayState(source);
  const context: ExecutionContext<TTypes> = {
    source,
    patch,
    overlay,
    mode: options.mode,
  };
  const conflicts: PatchConflict[] = [];

  for (const op of patch.ops) {
    const result = applyOperation(context, op);
    if (!result.ok) {
      conflicts.push(result.conflict);
      if (options.mode === "atomic") {
        break;
      }
    }
  }

  const revision = computeRevisionStatus(source as IndexedTree<NodeTypeMap>, patch);
  if (!options.produceTree || (conflicts.length > 0 && options.mode === "atomic")) {
    return { revision, conflicts };
  }

  const tree = buildSnapshotFromOverlay(overlay);
  const materialized = buildMaterializedTree(
    overlay,
    overlay.rootId,
    options.includeHidden,
    false,
  ) as MaterializedNode<TTypes>;

  return {
    revision,
    conflicts,
    tree,
    materialized,
  };
}

export function validatePatch<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: ValidateOptions = {},
): ValidationResult {
  const result = executePatch(source, patch, {
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
  const result = executePatch(source, patch, {
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
