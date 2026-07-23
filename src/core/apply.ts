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
import { finalizeMap, finalizeSet } from "./cow.js";
import { InvalidPointerError, MissingCodecError } from "./errors.js";
import {
  createReadonlyMapView,
  deepFreezePlainData,
  isPlainObject,
  setOwnEnumerableValue,
} from "./snapshot.js";
import { attachTreeState, getTreeState } from "./state.js";
import {
  getPathHash,
  getSubtreeHash,
  getTreeRevisionHash,
  joinJsonPointer,
} from "./hash.js";
import {
  cloneRuntimeValue,
  deepEqual,
  isEncodedValue,
} from "../schema/adapters.js";
import { parseJsonPointer, resolvePointer } from "../schema/pointers.js";
import { getValueAdapterForPointer } from "../schema/schema.js";
import {
  exposeIndexedNode,
  exposeRuntimeAttrs,
} from "../schema/runtime-clone.js";
import {
  clearSubtreeState,
  createOverlayState,
  getNode,
  getParentChildIds,
  invalidateNodeCaches,
  invalidateSubtreeHashes,
  reindexSubtreeDepths,
  setNode,
  type OverlayState,
} from "./overlay.js";
import {
  assertPatchEnvelope,
  collectSerializedNodeIds,
  normalizePosition,
} from "./patch-validation.js";

interface ExecutionContext<TTypes extends NodeTypeMap> {
  readonly overlay: OverlayState<TTypes>;
  readonly siblingOrders: Map<NodeId, MutableSiblingOrder>;
  readonly ownedAttrContainers: WeakSet<object>;
}

interface MutableSiblingOrder {
  first: NodeId | null;
  last: NodeId | null;
  readonly previous: Map<NodeId, NodeId | null>;
  readonly next: Map<NodeId, NodeId | null>;
  dirty: boolean;
}

type OperationResult = { ok: true } | { ok: false; conflict: PatchConflict };

export interface PatchExecutionSession<TTypes extends NodeTypeMap> {
  readonly overlay: OverlayState<TTypes>;
  readonly tree: IndexedTree<TTypes>;
  readonly siblingOrders: Map<NodeId, MutableSiblingOrder>;
  readonly ownedAttrContainers: WeakSet<object>;
}

export interface SessionNodePosition {
  readonly parentId: NodeId;
  readonly previousId: NodeId | null;
  readonly nextId: NodeId | null;
}

export interface ExecutePatchInternalResult<TTypes extends NodeTypeMap> {
  revision: RevisionStatus;
  conflicts: PatchConflict[];
  appliedOps: PatchOp[];
  appliedOpIds: string[];
  skippedOpIds: string[];
  tree?: IndexedTree<TTypes>;
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

function getSiblingOrder<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  parentId: NodeId,
): MutableSiblingOrder {
  const cached = context.siblingOrders.get(parentId);
  if (cached) {
    return cached;
  }

  const childIds = getParentChildIds(context.overlay, parentId);
  const previous = new Map<NodeId, NodeId | null>();
  const next = new Map<NodeId, NodeId | null>();
  for (let index = 0; index < childIds.length; index += 1) {
    const childId = childIds[index]!;
    previous.set(childId, childIds[index - 1] ?? null);
    next.set(childId, childIds[index + 1] ?? null);
  }
  const order: MutableSiblingOrder = {
    first: childIds[0] ?? null,
    last: childIds.at(-1) ?? null,
    previous,
    next,
    dirty: false,
  };
  context.siblingOrders.set(parentId, order);
  return order;
}

function unlinkSibling(
  order: MutableSiblingOrder,
  nodeId: NodeId,
): void {
  const previous = order.previous.get(nodeId) ?? null;
  const next = order.next.get(nodeId) ?? null;
  if (previous === null) {
    order.first = next;
  } else {
    order.next.set(previous, next);
  }
  if (next === null) {
    order.last = previous;
  } else {
    order.previous.set(next, previous);
  }
  order.previous.delete(nodeId);
  order.next.delete(nodeId);
  order.dirty = true;
}

function linkSiblingAfter(
  order: MutableSiblingOrder,
  nodeId: NodeId,
  previousId: NodeId | null,
): void {
  if (previousId === null) {
    const first = order.first;
    order.first = nodeId;
    order.previous.set(nodeId, null);
    order.next.set(nodeId, first);
    if (first === null) {
      order.last = nodeId;
    } else {
      order.previous.set(first, nodeId);
    }
    order.dirty = true;
    return;
  }

  const next = order.next.get(previousId) ?? null;
  order.next.set(previousId, nodeId);
  order.previous.set(nodeId, previousId);
  order.next.set(nodeId, next);
  if (next === null) {
    order.last = nodeId;
  } else {
    order.previous.set(next, nodeId);
  }
  order.dirty = true;
}

function resolvePreviousSibling<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  parentId: NodeId,
  position: ChildPosition | undefined,
  opId: string,
): { ok: true; previousId: NodeId | null } | { ok: false; conflict: PatchConflict } {
  const order = getSiblingOrder(context, parentId);
  if (!position || "atEnd" in position) {
    return { ok: true, previousId: order.last };
  }
  if ("atStart" in position) {
    return { ok: true, previousId: null };
  }
  const anchorId = "afterId" in position ? position.afterId : position.beforeId;
  if (context.overlay.index.parentById.get(anchorId) !== parentId) {
    return {
      ok: false,
      conflict: toConflict(
        opId,
        "AnchorMissing",
        `Anchor node "${anchorId}" is not a child of "${parentId}".`,
        { nodeId: parentId },
      ),
    };
  }
  return {
    ok: true,
    previousId:
      "afterId" in position
        ? position.afterId
        : order.previous.get(position.beforeId) ?? null,
  };
}

function collectCurrentSubtreeNodeIds<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
  nodeId: NodeId,
): NodeId[] {
  const collected: NodeId[] = [];
  const stack = [nodeId];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    const node = context.overlay.nodes.get(currentId);
    if (!node) {
      continue;
    }
    collected.push(currentId);
    const order = context.siblingOrders.get(currentId);
    if (!order) {
      for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
        stack.push(node.childIds[index]!);
      }
      continue;
    }
    const childIds: NodeId[] = [];
    let childId = order.first;
    while (childId !== null) {
      childIds.push(childId);
      childId = order.next.get(childId) ?? null;
    }
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push(childIds[index]!);
    }
  }
  return collected;
}

function flushSiblingOrders<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
): void {
  for (const [parentId, order] of context.siblingOrders) {
    if (!order.dirty) {
      continue;
    }
    const childIds: NodeId[] = [];
    let current = order.first;
    while (current !== null) {
      childIds.push(current);
      current = order.next.get(current) ?? null;
    }
    setParentChildIds(context.overlay, parentId, childIds);
    childIds.forEach((childId, index) => {
      context.overlay.index.positionById.set(childId, index);
    });
    order.dirty = false;
  }
}

export function flushPatchExecutionSession<TTypes extends NodeTypeMap>(
  session: PatchExecutionSession<TTypes>,
): void {
  flushSiblingOrders({
    overlay: session.overlay,
    siblingOrders: session.siblingOrders,
    ownedAttrContainers: session.ownedAttrContainers,
  });
}

export function getSessionNodePosition<TTypes extends NodeTypeMap>(
  session: PatchExecutionSession<TTypes>,
  nodeId: NodeId,
): SessionNodePosition | undefined {
  const parentId = session.overlay.index.parentById.get(nodeId);
  if (parentId == null) {
    return undefined;
  }
  const order = getSiblingOrder({
    overlay: session.overlay,
    siblingOrders: session.siblingOrders,
    ownedAttrContainers: session.ownedAttrContainers,
  }, parentId);
  if (!order.previous.has(nodeId) || !order.next.has(nodeId)) {
    return undefined;
  }
  return {
    parentId,
    previousId: order.previous.get(nodeId) ?? null,
    nextId: order.next.get(nodeId) ?? null,
  };
}

function clearSiblingOrders<TTypes extends NodeTypeMap>(
  context: ExecutionContext<TTypes>,
): void {
  flushSiblingOrders(context);
  context.siblingOrders.clear();
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
    return value;
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
  let root: unknown;
  const stack: Array<{
    value: PersistedValue;
    pointer: JsonPointer;
    assign: (value: unknown) => void;
  }> = [{
    value,
    pointer,
    assign: (decoded) => {
      root = decoded;
    },
  }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (isEncodedValue(frame.value)) {
      frame.assign(cloneOwnedRuntimeValue(
        overlay,
        nodeType,
        frame.pointer,
        decodePersistedForPointer(
          overlay,
          nodeType,
          frame.pointer,
          frame.value,
        ),
      ));
      continue;
    }
    if (Array.isArray(frame.value)) {
      const decoded = new Array<unknown>(frame.value.length);
      frame.assign(decoded);
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: frame.value[index] as PersistedValue,
          pointer: joinJsonPointer(frame.pointer, index),
          assign: (child) => {
            decoded[index] = child;
          },
        });
      }
      continue;
    }
    if (isPlainObject(frame.value)) {
      const decoded: Record<string, unknown> = {};
      frame.assign(decoded);
      const keys = Object.keys(frame.value);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        stack.push({
          value: frame.value[key] as PersistedValue,
          pointer: joinJsonPointer(frame.pointer, key),
          assign: (child) => {
            setOwnEnumerableValue(decoded, key, child);
          },
        });
      }
      continue;
    }
    frame.assign(frame.value);
  }

  return root;
}

function cloneAttrContainer(
  container: unknown[] | Record<string, unknown>,
  ownedContainers: WeakSet<object>,
): unknown[] | Record<string, unknown> {
  if (Array.isArray(container)) {
    const clone = container.slice();
    ownedContainers.add(clone);
    return clone;
  }

  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(container)) {
    setOwnEnumerableValue(clone, key, container[key]);
  }
  ownedContainers.add(clone);
  return clone;
}

function ensureOwnedAttrContainer(
  container: unknown[] | Record<string, unknown>,
  ownedContainers: WeakSet<object>,
): unknown[] | Record<string, unknown> {
  return ownedContainers.has(container)
    ? container
    : cloneAttrContainer(container, ownedContainers);
}

function readArrayIndex(
  segment: string,
  array: readonly unknown[],
): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(segment)) {
    return undefined;
  }
  const index = Number(segment);
  return index >= 0 && index < array.length ? index : undefined;
}

function setObjectValue(
  current: unknown,
  segments: readonly string[],
  value: unknown,
  ownedContainers: WeakSet<object>,
): { ok: true; next: unknown } | { ok: false } {
  if (segments.length === 0) {
    return { ok: true, next: value };
  }

  // Validate the complete path before mutating an already-owned draft.
  let cursor = current;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const isLast = index === segments.length - 1;
    if (Array.isArray(cursor)) {
      const arrayIndex = readArrayIndex(segment, cursor);
      if (arrayIndex === undefined) {
        return { ok: false };
      }
      if (!isLast) {
        cursor = cursor[arrayIndex];
      }
      continue;
    }
    if (!isPlainObject(cursor)) {
      return { ok: false };
    }
    if (!isLast) {
      const existing = Object.hasOwn(cursor, segment)
        ? cursor[segment]
        : undefined;
      if (
        existing !== undefined &&
        !isPlainObject(existing) &&
        !Array.isArray(existing)
      ) {
        return { ok: false };
      }
      cursor = existing ?? {};
    }
  }

  if (!Array.isArray(current) && !isPlainObject(current)) {
    return { ok: false };
  }
  const root = ensureOwnedAttrContainer(current, ownedContainers);
  let draft = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const isLast = index === segments.length - 1;
    if (Array.isArray(draft)) {
      const arrayIndex = readArrayIndex(segment, draft)!;
      if (isLast) {
        draft[arrayIndex] = value;
        break;
      }
      const existing = draft[arrayIndex];
      if (existing === undefined) {
        const created: Record<string, unknown> = {};
        ownedContainers.add(created);
        draft[arrayIndex] = created;
        draft = created;
        continue;
      }
      const child = ensureOwnedAttrContainer(
        existing as unknown[] | Record<string, unknown>,
        ownedContainers,
      );
      draft[arrayIndex] = child;
      draft = child;
      continue;
    }

    if (isLast) {
      setOwnEnumerableValue(draft, segment, value);
      break;
    }
    const existing = Object.hasOwn(draft, segment)
      ? draft[segment]
      : undefined;
    if (existing === undefined) {
      const created: Record<string, unknown> = {};
      ownedContainers.add(created);
      setOwnEnumerableValue(draft, segment, created);
      draft = created;
      continue;
    }
    const child = ensureOwnedAttrContainer(
      existing as unknown[] | Record<string, unknown>,
      ownedContainers,
    );
    setOwnEnumerableValue(draft, segment, child);
    draft = child;
  }
  return { ok: true, next: root };
}

function removeObjectValue(
  current: unknown,
  segments: readonly string[],
  ownedContainers: WeakSet<object>,
): { ok: true; next: unknown } | { ok: false } {
  if (segments.length === 0) {
    return { ok: false };
  }

  // Validate first so a failed operation cannot partially mutate a draft.
  let cursor = current;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (Array.isArray(cursor)) {
      const arrayIndex = readArrayIndex(segment, cursor);
      if (arrayIndex === undefined) {
        return { ok: false };
      }
      cursor = cursor[arrayIndex];
      continue;
    }
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, segment)) {
      return { ok: false };
    }
    cursor = cursor[segment];
  }

  if (!Array.isArray(current) && !isPlainObject(current)) {
    return { ok: false };
  }
  const root = ensureOwnedAttrContainer(current, ownedContainers);
  let draft = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const isLast = index === segments.length - 1;
    if (Array.isArray(draft)) {
      const arrayIndex = readArrayIndex(segment, draft)!;
      if (isLast) {
        draft.splice(arrayIndex, 1);
        break;
      }
      const child = ensureOwnedAttrContainer(
        draft[arrayIndex] as unknown[] | Record<string, unknown>,
        ownedContainers,
      );
      draft[arrayIndex] = child;
      draft = child;
      continue;
    }

    if (isLast) {
      delete draft[segment];
      break;
    }
    const child = ensureOwnedAttrContainer(
      draft[segment] as unknown[] | Record<string, unknown>,
      ownedContainers,
    );
    setOwnEnumerableValue(draft, segment, child);
    draft = child;
  }
  return { ok: true, next: root };
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
    case "attrAbsent": {
      const node = overlay.nodes.get(guard.nodeId);
      if (!node) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard attrAbsent failed because node "${guard.nodeId}" is missing.`,
            { nodeId: guard.nodeId },
          ),
        };
      }

      const resolution = resolvePointer(node.attrs, guard.path);
      if (resolution.ok) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard attrAbsent failed for node "${guard.nodeId}" at "${guard.path}".`,
            {
              nodeId: guard.nodeId,
              path: guard.path,
              expected: "absent",
              actual: resolution.value,
            },
          ),
        };
      }

      if (resolution.reason !== "Missing") {
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
      flushSiblingOrders(context);
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
    case "positionAtStart": {
      const parentId = overlay.index.parentById.get(guard.nodeId);
      if (parentId == null || !overlay.nodes.has(guard.nodeId)) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionAtStart failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: "atStart" },
          ),
        };
      }

      if (getSiblingOrder(context, parentId).first !== guard.nodeId) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionAtStart failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: "atStart" },
          ),
        };
      }
      return { ok: true };
    }
    case "positionAtEnd": {
      const parentId = overlay.index.parentById.get(guard.nodeId);
      if (parentId == null || !overlay.nodes.has(guard.nodeId)) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionAtEnd failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: "atEnd" },
          ),
        };
      }

      if (getSiblingOrder(context, parentId).last !== guard.nodeId) {
        return {
          ok: false,
          conflict: toConflict(
            opId,
            "GuardFailed",
            `Guard positionAtEnd failed for node "${guard.nodeId}".`,
            { nodeId: guard.nodeId, expected: "atEnd" },
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

      if (
        getSiblingOrder(context, actualParentId).previous.get(guard.nodeId) !==
        guard.afterId
      ) {
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

      if (
        getSiblingOrder(context, actualParentId).next.get(guard.nodeId) !==
        guard.beforeId
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
  const result = setObjectValue(
    node.attrs,
    parseJsonPointer(op.path),
    decodedValue,
    context.ownedAttrContainers,
  );
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

  const result = removeObjectValue(
    node.attrs,
    parseJsonPointer(op.path),
    context.ownedAttrContainers,
  );
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
  const nodes: IndexedNode<TTypes>[] = [];
  const index: NormalizedSubtreeIndexEntry[] = [];
  const stack: Array<{
    node: SerializedPatchNode;
    parentId: NodeId | null;
    depth: number;
    position: number;
  }> = [{ node, parentId, depth, position }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes.push({
      id: current.node.id,
      type: current.node.type as IndexedNode<TTypes>["type"],
      attrs: decodeSerializedAttrs(
        overlay,
        current.node.type,
        "",
        current.node.attrs,
      ) as IndexedNode<TTypes>["attrs"],
      childIds: current.node.children.map((child) => child.id),
    });
    index.push({
      nodeId: current.node.id,
      parentId: current.parentId,
      depth: current.depth,
      position: current.position,
    });

    for (
      let childIndex = current.node.children.length - 1;
      childIndex >= 0;
      childIndex -= 1
    ) {
      stack.push({
        node: current.node.children[childIndex]!,
        parentId: current.node.id,
        depth: current.depth + 1,
        position: childIndex,
      });
    }
  }

  return { nodes, index };
}

function setParentChildIds<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  parentId: NodeId,
  childIds: NodeId[],
): void {
  const parent = getNode(overlay, parentId);
  if (!parent) {
    return;
  }

  setNode(overlay, {
    ...parent,
    childIds,
  });
  overlay.dirtyNodeIds.add(parentId);
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
  const resolvedPosition = resolvePreviousSibling(
    context,
    parent.id,
    position,
    op.opId,
  );
  if (!resolvedPosition.ok) {
    return resolvedPosition;
  }

  const parentDepth = context.overlay.index.depthById.get(parent.id) ?? 0;
  const normalized = normalizeSerializedSubtree(
    context.overlay,
    op.node,
    parent.id,
    parentDepth + 1,
    0,
  );

  normalized.nodes.forEach((node) => {
    setNode(context.overlay, node);
    context.overlay.dirtyNodeIds.add(node.id);
    context.overlay.patchOwned.add(node.id);
  });

  normalized.index.forEach((entry) => {
    context.overlay.index.parentById.set(entry.nodeId, entry.parentId);
    context.overlay.index.depthById.set(entry.nodeId, entry.depth);
    context.overlay.index.positionById.set(entry.nodeId, entry.position);
  });

  linkSiblingAfter(
    getSiblingOrder(context, parent.id),
    op.node.id,
    resolvedPosition.previousId,
  );
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

  const guards = evaluateGuards(context, op.opId, op.guards);
  if (!guards.ok) {
    return guards;
  }

  const currentOrder = getSiblingOrder(context, currentParentId);
  const destinationOrder = getSiblingOrder(context, op.newParentId);
  let targetPrevious: NodeId | null;
  if (!position || "atEnd" in position) {
    targetPrevious = destinationOrder.last;
    if (currentParentId === op.newParentId && targetPrevious === op.nodeId) {
      targetPrevious = destinationOrder.previous.get(op.nodeId) ?? null;
    }
  } else if ("atStart" in position) {
    targetPrevious = null;
  } else if ("afterId" in position) {
    if (overlay.index.parentById.get(position.afterId) !== op.newParentId) {
      return {
        ok: false,
        conflict: toConflict(
          op.opId,
          "AnchorMissing",
          `Anchor node "${position.afterId}" is not a child of "${op.newParentId}".`,
          { nodeId: op.newParentId },
        ),
      };
    }
    targetPrevious = position.afterId;
  } else {
    if (overlay.index.parentById.get(position.beforeId) !== op.newParentId) {
      return {
        ok: false,
        conflict: toConflict(
          op.opId,
          "AnchorMissing",
          `Anchor node "${position.beforeId}" is not a child of "${op.newParentId}".`,
          { nodeId: op.newParentId },
        ),
      };
    }
    targetPrevious = destinationOrder.previous.get(position.beforeId) ?? null;
    if (currentParentId === op.newParentId && targetPrevious === op.nodeId) {
      targetPrevious = currentOrder.previous.get(op.nodeId) ?? null;
    }
  }

  if (
    currentParentId === op.newParentId &&
    (currentOrder.previous.get(op.nodeId) ?? null) === targetPrevious
  ) {
    return { ok: true };
  }

  unlinkSibling(currentOrder, op.nodeId);
  linkSiblingAfter(destinationOrder, op.nodeId, targetPrevious);
  overlay.index.parentById.set(op.nodeId, newParent.id);

  if (currentParentId !== op.newParentId) {
    const nextDepth = (overlay.index.depthById.get(newParent.id) ?? 0) + 1;
    reindexSubtreeDepths(overlay, op.nodeId, nextDepth);
  }
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

  const replacedSubtreeIds = new Set(
    collectCurrentSubtreeNodeIds(context, op.nodeId),
  );
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
  for (const replacedNodeId of replacedSubtreeIds) {
    context.siblingOrders.delete(replacedNodeId);
  }

  const normalized = normalizeSerializedSubtree(
    overlay,
    op.node,
    parentId,
    depth,
    position,
  );

  normalized.nodes.forEach((node) => {
    setNode(overlay, node);
    overlay.dirtyNodeIds.add(node.id);
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

  const removedIds = collectCurrentSubtreeNodeIds(context, op.nodeId);
  unlinkSibling(getSiblingOrder(context, parentId), op.nodeId);
  clearSubtreeState(overlay, removedIds);
  for (const removedId of removedIds) {
    context.siblingOrders.delete(removedId);
  }
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
    siblingOrders: new Map(),
    ownedAttrContainers: new WeakSet(),
  };
}

export function applyOperationInSession<TTypes extends NodeTypeMap>(
  session: PatchExecutionSession<TTypes>,
  op: PatchOp,
): OperationResult {
  const context = {
    overlay: session.overlay,
    siblingOrders: session.siblingOrders,
    ownedAttrContainers: session.ownedAttrContainers,
  };
  return applyOperation(context, op);
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
    childIds: Object.isFrozen(node.childIds)
      ? node.childIds
      : Object.freeze(node.childIds),
  }) as IndexedNode<TTypes>;
}

function buildSnapshotFromOverlay<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  source: IndexedTree<TTypes>,
  sourceStateHash: string,
): IndexedTree<TTypes> {
  for (const nodeId of overlay.dirtyNodeIds) {
    const node = overlay.nodes.get(nodeId);
    if (node) {
      overlay.nodes.set(nodeId, freezeNodeForSnapshot(overlay, node));
    }
  }

  overlay.nodes = finalizeMap(overlay.nodes);
  overlay.index.parentById = finalizeMap(overlay.index.parentById);
  overlay.index.positionById = finalizeMap(overlay.index.positionById);
  overlay.index.depthById = finalizeMap(overlay.index.depthById);
  overlay.cache.nodeHashById = finalizeMap(overlay.cache.nodeHashById);
  overlay.cache.subtreeHashById = finalizeMap(overlay.cache.subtreeHashById);
  overlay.cache.pathHashByNodeId = finalizeMap(overlay.cache.pathHashByNodeId);
  overlay.cache.childHashByParentId = finalizeMap(
    overlay.cache.childHashByParentId,
  );
  overlay.explicitHidden = finalizeSet(overlay.explicitHidden);
  overlay.patchOwned = finalizeSet(overlay.patchOwned);

  const tree = {
    rootId: overlay.rootId,
    nodes: createReadonlyMapView(
      overlay.nodes,
      (node) => exposeIndexedNode(overlay.schema, overlay.ownership, node),
    ),
    index: Object.freeze({
      parentById: createReadonlyMapView(overlay.index.parentById),
      positionById: createReadonlyMapView(overlay.index.positionById),
      depthById: createReadonlyMapView(overlay.index.depthById),
    }),
    cache: Object.freeze({
      nodeHashById: createReadonlyMapView(overlay.cache.nodeHashById),
      subtreeHashById: createReadonlyMapView(overlay.cache.subtreeHashById),
      pathHashByNodeId: createReadonlyMapView(
        overlay.cache.pathHashByNodeId,
        (hashes) => createReadonlyMapView(hashes),
      ),
    }),
  } as IndexedTree<TTypes>;

  if (overlay.metadata !== undefined) {
    tree.metadata = overlay.metadata;
  }

  attachTreeState(tree, overlay);
  const derivedRevision = getTreeRevisionHash(tree);
  tree.revision =
    derivedRevision === sourceStateHash && source.revision !== undefined
      ? source.revision
      : derivedRevision;
  return Object.freeze(tree);
}

function buildMaterializedTree<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: NodeId,
  includeHidden: boolean,
  ancestorHidden: boolean,
): MaterializedNode<TTypes> | null {
  const state = getTreeState(tree);
  let root: MaterializedNode<TTypes> | null = null;
  type Frame =
    | {
        kind: "enter";
        nodeId: NodeId;
        ancestorHidden: boolean;
        assign: (node: MaterializedNode<TTypes> | null) => void;
      }
    | {
        kind: "exit";
        node: IndexedNode<TTypes>;
        hidden: boolean;
        explicitlyHidden: boolean;
        children: Array<MaterializedNode<TTypes> | null>;
        assign: (node: MaterializedNode<TTypes>) => void;
      };
  const stack: Frame[] = [{
    kind: "enter",
    nodeId,
    ancestorHidden,
    assign: (node) => {
      root = node;
    },
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      const materializedState: MaterializedNode<TTypes>["state"] = {};
      if (frame.hidden) {
        materializedState.hidden = true;
      }
      if (state.patchOwned.has(frame.node.id)) {
        materializedState.patchOwned = true;
      }
      if (frame.explicitlyHidden) {
        materializedState.explicitlyHidden = true;
      }

      const materialized: MaterializedNode<TTypes> = {
        id: frame.node.id,
        type: frame.node.type,
        attrs: exposeRuntimeAttrs(
          state.schema,
          state.ownership,
          String(frame.node.type),
          frame.node.attrs,
        ) as MaterializedNode<TTypes>["attrs"],
        children: frame.children.filter(
          (child): child is MaterializedNode<TTypes> => child !== null,
        ),
      };
      if (Object.keys(materializedState).length > 0) {
        materialized.state = materializedState;
      }
      frame.assign(materialized);
      continue;
    }

    const node = state.nodes.get(frame.nodeId);
    if (!node) {
      frame.assign(null);
      continue;
    }
    const explicitlyHidden = state.explicitHidden.has(frame.nodeId);
    const hidden = frame.ancestorHidden || explicitlyHidden;
    if (hidden && !includeHidden) {
      frame.assign(null);
      continue;
    }

    const children = new Array<MaterializedNode<TTypes> | null>(
      node.childIds.length,
    ).fill(null);
    stack.push({
      kind: "exit",
      node,
      hidden,
      explicitlyHidden,
      children,
      assign: frame.assign as (node: MaterializedNode<TTypes>) => void,
    });
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        kind: "enter",
        nodeId: node.childIds[index]!,
        ancestorHidden: hidden,
        assign: (child) => {
          children[index] = child;
        },
      });
    }
  }

  return root;
}

export function executePatchInternal<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: {
    mode: "atomic" | "preview";
    produceTree: boolean;
  },
): ExecutePatchInternalResult<TTypes> {
  assertPatchEnvelope(patch);

  const session = createPatchExecutionSession(source);
  const context: ExecutionContext<TTypes> = {
    overlay: session.overlay,
    siblingOrders: session.siblingOrders,
    ownedAttrContainers: session.ownedAttrContainers,
  };
  const conflicts: PatchConflict[] = [];
  const appliedOps: PatchOp[] = [];
  const appliedOpIds: string[] = [];
  const skippedOpIds: string[] = [];

  for (const op of patch.ops) {
    const result = applyOperation(context, op);
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
  clearSiblingOrders(context);

  const revision = computeRevisionStatus(source as IndexedTree<NodeTypeMap>, patch);
  if (!options.produceTree || (conflicts.length > 0 && options.mode === "atomic")) {
    return { revision, conflicts, appliedOps, appliedOpIds, skippedOpIds };
  }

  const tree =
    appliedOps.length === 0
      ? source
      : buildSnapshotFromOverlay(
          session.overlay,
          source,
          getTreeRevisionHash(source),
        );

  return {
    revision,
    conflicts,
    appliedOps,
    appliedOpIds,
    skippedOpIds,
    tree,
  };
}

function withLazyMaterialized<
  TTypes extends NodeTypeMap,
  TResult extends object,
>(
  result: TResult,
  tree: IndexedTree<TTypes>,
  includeHidden: boolean,
): TResult & { readonly materialized: MaterializedNode<TTypes> } {
  let cached: MaterializedNode<TTypes> | undefined;
  Object.defineProperty(result, "materialized", {
    enumerable: true,
    get() {
      cached ??= buildMaterializedTree(
        tree,
        tree.rootId,
        includeHidden,
        false,
      ) as MaterializedNode<TTypes>;
      return cached;
    },
  });
  return result as TResult & { readonly materialized: MaterializedNode<TTypes> };
}

export function validatePatch<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: ValidateOptions = {},
): ValidationResult {
  const result = executePatchInternal(source, patch, {
    mode: options.mode ?? "atomic",
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
  const includeHidden = options.includeHidden ?? true;
  const result = executePatchInternal(source, patch, {
    mode: options.mode ?? "atomic",
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
    return withLazyMaterialized({
      status: "preview",
      revision: result.revision,
      tree: result.tree as IndexedTree<TTypes>,
      conflicts: result.conflicts,
    }, result.tree as IndexedTree<TTypes>, includeHidden);
  }

  return withLazyMaterialized({
    status: "applied",
    revision: result.revision,
    tree: result.tree as IndexedTree<TTypes>,
  }, result.tree as IndexedTree<TTypes>, includeHidden);
}

export function materialize<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  patch: TreePatch,
  options: MaterializeOptions = {},
): MaterializeResult<TTypes> {
  return applyPatch(source, patch, options);
}
