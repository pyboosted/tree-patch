import type {
  ChildPosition,
  DiffOptions,
  Guard,
  HideNodeOp,
  IndexedTree,
  InsertNodeOp,
  JsonPointer,
  MoveNodeOp,
  NodeId,
  NodeTypeMap,
  PatchOp,
  RemoveAttrOp,
  RemoveNodeOp,
  ReorderChildrenOp,
  RebaseOptions,
  RebaseResult,
  ReplaceSubtreeOp,
  SetAttrOp,
  SerializedPatchNode,
  ShowNodeOp,
  TreePatch,
} from "./types.js";
import {
  InvalidResolutionInputError,
  UnsupportedTransformError,
} from "./errors.js";
import { executePatchInternal } from "./apply.js";
import { assertPatchEnvelope } from "./patch-validation.js";
import {
  getChildOrderHash,
  getNodeHash,
  getPathHash,
  getSubtreeHash,
  getTreeRevisionHash,
  joinJsonPointer,
} from "./hash.js";
import { attachTreeState, getTreeState } from "./state.js";
import { isPlainObject } from "./snapshot.js";
import type { CompiledTreeSchema } from "../schema/schema.js";
import {
  compileTreeSchema,
} from "../schema/schema.js";
import { resolvePointer } from "../schema/pointers.js";
import {
  type CompiledSchemas,
  encodeRuntimeValueForPointer,
  getSemanticComparisonNodeTypes,
  getValueAdapterForSchemas,
  isAtomicForSchemas,
} from "../schema/runtime-values.js";
import { hashStableParts } from "./stable-hash.js";
import { cloneJsonValue, deepEqual } from "../schema/adapters.js";
import { compareStrings } from "./order.js";

interface DiffContext<TTypes extends NodeTypeMap> {
  readonly base: IndexedTree<TTypes>;
  readonly target: IndexedTree<TTypes>;
  readonly baseState: ReturnType<typeof getTreeState<TTypes>>;
  readonly targetState: ReturnType<typeof getTreeState<TTypes>>;
  readonly schemas: CompiledSchemas<TTypes>;
  readonly semanticComparisonNodeTypes: ReadonlySet<string>;
  readonly options: DiffOptions<TTypes>;
  readonly targetPatchOwned: ReadonlySet<NodeId>;
  readonly replacementRoots: ReadonlySet<NodeId>;
  readonly replacementCoveredInBase: ReadonlySet<NodeId>;
  readonly replacementCoveredInTarget: ReadonlySet<NodeId>;
  readonly opIds: ReturnType<typeof createOpIdFactory>;
}

function createRawTreeView<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
): IndexedTree<TTypes> {
  const state = getTreeState(tree);
  const rawTree = {
    ...tree,
    nodes: state.nodes,
    index: state.index,
    cache: state.cache,
  } as IndexedTree<TTypes>;
  attachTreeState(rawTree, state);
  return rawTree;
}

interface ThresholdPrecomputation {
  readonly baseNodeCounts: ReadonlyMap<NodeId, number>;
  readonly targetNodeCounts: ReadonlyMap<NodeId, number>;
  readonly changedNodeCounts: ReadonlyMap<NodeId, number>;
}

function createOpIdFactory() {
  const counters = new Map<string, number>();

  return (prefix: string, nodeId: string, pointer?: JsonPointer): string => {
    const base = pointer ? `${prefix}:${nodeId}:${pointer}` : `${prefix}:${nodeId}`;
    const count = counters.get(base) ?? 0;
    counters.set(base, count + 1);
    return count === 0 ? base : `${base}:${count + 1}`;
  };
}

function getCompiledSchemas<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  options: DiffOptions<TTypes>,
): CompiledSchemas<TTypes> {
  const schemas: CompiledTreeSchema<TTypes>[] = [];
  if (options.schema) {
    schemas.push(compileTreeSchema(options.schema));
  }

  const targetSchema = getTreeState(target).schema;
  if (!schemas.includes(targetSchema)) {
    schemas.push(targetSchema);
  }

  const baseSchema = getTreeState(base).schema;
  if (!schemas.includes(baseSchema)) {
    schemas.push(baseSchema);
  }

  return schemas;
}

function getEffectivePatchOwnedSet<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
): ReadonlySet<NodeId> {
  const targetState = getTreeState(target);
  const effective = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; inheritedPatchOwned: boolean }> = [{
    nodeId: target.rootId,
    inheritedPatchOwned: false,
  }];

  while (stack.length > 0) {
    const { nodeId, inheritedPatchOwned } = stack.pop()!;
    const targetNode = target.nodes.get(nodeId);
    if (!targetNode) {
      continue;
    }

    const currentPatchOwned =
      inheritedPatchOwned ||
      targetState.patchOwned.has(nodeId) ||
      !base.nodes.has(nodeId);
    if (currentPatchOwned) {
      effective.add(nodeId);
    }

    for (let index = targetNode.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: targetNode.childIds[index]!,
        inheritedPatchOwned: currentPatchOwned,
      });
    }
  }

  return effective;
}

function collectExplicitHiddenSignature<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
): string {
  const hidden = [...getTreeState(tree).explicitHidden].sort();
  return hidden.join("|");
}

function buildPatchId<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
): string {
  return `diff:${hashStableParts([
    getTreeRevisionHash(base),
    getTreeRevisionHash(target),
  ])}`;
}

function collectNodesCoveredByRoots<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  roots: ReadonlySet<NodeId>,
): ReadonlySet<NodeId> {
  const covered = new Set<NodeId>();
  const stack = [...roots];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (covered.has(nodeId)) {
      continue;
    }
    const node = tree.nodes.get(nodeId);
    if (!node) {
      continue;
    }
    covered.add(nodeId);
    stack.push(...node.childIds);
  }
  return covered;
}

function findNearestViableReplacementRoot<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  basePatchOwned: ReadonlySet<NodeId>,
  nodeId: NodeId,
): NodeId | undefined {
  let current: NodeId | null = nodeId;

  while (current != null) {
    if (base.nodes.has(current) && !basePatchOwned.has(current)) {
      const baseParentId = base.index.parentById.get(current) ?? null;
      const targetParentId = target.index.parentById.get(current) ?? null;
      const basePosition = base.index.positionById.get(current) ?? 0;
      const targetPosition = target.index.positionById.get(current) ?? 0;

      if (baseParentId === targetParentId && basePosition === targetPosition) {
        return current;
      }
    }

    current = target.index.parentById.get(current) ?? null;
  }

  return undefined;
}

function collapseReplacementRoots<TTypes extends NodeTypeMap>(
  target: IndexedTree<TTypes>,
  candidates: ReadonlySet<NodeId>,
): ReadonlySet<NodeId> {
  if (candidates.size === 0) {
    return candidates;
  }

  const collapsed = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; covered: boolean }> = [{
    nodeId: target.rootId,
    covered: false,
  }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const node = target.nodes.get(current.nodeId);
    if (!node) {
      continue;
    }
    const isCandidate = candidates.has(current.nodeId);
    if (isCandidate && !current.covered) {
      collapsed.add(current.nodeId);
    }
    const covered = current.covered || isCandidate;
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ nodeId: node.childIds[index]!, covered });
    }
  }

  return collapsed;
}

function computeSubtreeNodeCounts<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
): ReadonlyMap<NodeId, number> {
  const order: NodeId[] = [];
  const stack = [tree.rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    const node = tree.nodes.get(nodeId);
    if (!node) {
      continue;
    }
    order.push(nodeId);
    stack.push(...node.childIds);
  }

  const counts = new Map<NodeId, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const nodeId = order[index]!;
    const node = tree.nodes.get(nodeId)!;
    let count = 1;
    for (const childId of node.childIds) {
      count += counts.get(childId) ?? 0;
    }
    counts.set(nodeId, count);
  }
  return counts;
}

function countAttrChanges<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string,
  baseValue: unknown,
  targetValue: unknown,
  pointer: JsonPointer,
): number {
  let total = 0;
  const stack: Array<{
    baseValue: unknown;
    targetValue: unknown;
    pointer: JsonPointer;
  }> = [{ baseValue, targetValue, pointer }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const adapter = getValueAdapterForSchemas(
      schemas,
      nodeType,
      current.pointer,
    );
    if (
      adapter
        ? adapter.equals(
            current.baseValue as never,
            current.targetValue as never,
          )
        : Object.is(current.baseValue, current.targetValue)
    ) {
      continue;
    }
    if (
      isAtomicForSchemas(schemas, nodeType, current.pointer) ||
      adapter ||
      Array.isArray(current.baseValue) ||
      Array.isArray(current.targetValue) ||
      !isPlainObject(current.baseValue) ||
      !isPlainObject(current.targetValue)
    ) {
      if (!adapter && deepEqual(current.baseValue, current.targetValue)) {
        continue;
      }
      total += 1;
      continue;
    }

    const keys = [...new Set([
      ...Object.keys(current.baseValue),
      ...Object.keys(current.targetValue),
    ])].sort();
    for (const key of keys) {
      if (
        !Object.hasOwn(current.baseValue, key) ||
        !Object.hasOwn(current.targetValue, key)
      ) {
        total += 1;
      } else {
        stack.push({
          baseValue: current.baseValue[key],
          targetValue: current.targetValue[key],
          pointer: joinJsonPointer(current.pointer, key),
        });
      }
    }
  }
  return total;
}

function computeChangedNodeCounts<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
): ReadonlyMap<NodeId, number> {
  const order: NodeId[] = [];
  const stack = [target.rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    const node = target.nodes.get(nodeId);
    if (!node) {
      continue;
    }
    order.push(nodeId);
    stack.push(...node.childIds);
  }

  const changedCounts = new Map<NodeId, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const nodeId = order[index]!;
    const baseNode = base.nodes.get(nodeId);
    const targetNode = target.nodes.get(nodeId)!;
    if (!baseNode) {
      changedCounts.set(nodeId, 1);
      continue;
    }
    if (getSubtreeHash(base, nodeId) === getSubtreeHash(target, nodeId)) {
      changedCounts.set(nodeId, 0);
      continue;
    }

    let changed =
      getNodeHash(base, nodeId) !== getNodeHash(target, nodeId) ||
      !hasSameNodeOrder(baseNode.childIds, targetNode.childIds)
        ? 1
        : 0;
    const baseChildIds = new Set(baseNode.childIds);
    const targetChildIds = new Set(targetNode.childIds);
    for (const childId of new Set([
      ...baseNode.childIds,
      ...targetNode.childIds,
    ])) {
      changed +=
        baseChildIds.has(childId) && targetChildIds.has(childId)
          ? changedCounts.get(childId) ?? 0
          : 1;
    }
    changedCounts.set(nodeId, changed);
  }

  return changedCounts;
}

function precomputeThresholds<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  options: DiffOptions<TTypes>,
): ThresholdPrecomputation | undefined {
  if (options.replaceSubtreeWhen?.subtreeChangeRatioGte === undefined) {
    return undefined;
  }

  return {
    baseNodeCounts: computeSubtreeNodeCounts(base),
    targetNodeCounts: computeSubtreeNodeCounts(target),
    changedNodeCounts: computeChangedNodeCounts(base, target),
  };
}

function shouldReplaceSubtreeByThresholds<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  schemas: CompiledSchemas<TTypes>,
  nodeId: NodeId,
  options: DiffOptions<TTypes>,
  precomputed: ThresholdPrecomputation | undefined,
): boolean {
  const thresholds = options.replaceSubtreeWhen;
  if (!thresholds) {
    return false;
  }

  const baseNode = base.nodes.get(nodeId);
  const targetNode = target.nodes.get(nodeId);
  if (!baseNode || !targetNode || baseNode.type !== targetNode.type) {
    return false;
  }

  if (
    thresholds.changedAttrCountGte !== undefined &&
    countAttrChanges(
      schemas,
      String(baseNode.type),
      baseNode.attrs,
      targetNode.attrs,
      "",
    ) >= thresholds.changedAttrCountGte
  ) {
    return true;
  }

  if (thresholds.changedChildCountGte !== undefined) {
    const baseChildPositions = new Map(
      baseNode.childIds.map((childId, index) => [childId, index]),
    );
    const targetChildPositions = new Map(
      targetNode.childIds.map((childId, index) => [childId, index]),
    );
    const changedChildCount = [...new Set([
      ...baseNode.childIds,
      ...targetNode.childIds,
    ])].filter((childId) => {
      const baseIndex = baseChildPositions.get(childId);
      const targetIndex = targetChildPositions.get(childId);
      return baseIndex === undefined || targetIndex === undefined || baseIndex !== targetIndex;
    }).length;
    if (changedChildCount >= thresholds.changedChildCountGte) {
      return true;
    }
  }

  if (thresholds.subtreeChangeRatioGte !== undefined && precomputed) {
    const subtreeChangeRatio =
      (precomputed.changedNodeCounts.get(nodeId) ?? 0) /
      Math.max(
        precomputed.baseNodeCounts.get(nodeId) ?? 0,
        precomputed.targetNodeCounts.get(nodeId) ?? 0,
        1,
      );
    return subtreeChangeRatio >= thresholds.subtreeChangeRatioGte;
  }

  return false;
}

function isEffectivelyHidden<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: NodeId,
): boolean {
  const state = getTreeState(tree);
  let current: NodeId | null = nodeId;

  while (current != null) {
    if (state.explicitHidden.has(current)) {
      return true;
    }
    current = tree.index.parentById.get(current) ?? null;
  }

  return false;
}

function serializeReplacementSubtree<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  nodeId: NodeId,
): SerializedPatchNode {
  const targetNode = context.target.nodes.get(nodeId);
  if (!targetNode) {
    throw new UnsupportedTransformError(`Cannot serialize missing target node "${nodeId}" for replacement.`, {
      details: { nodeId },
    });
  }

  const baseDescendants = new Set<NodeId>();
  const baseNode = context.base.nodes.get(nodeId);
  if (baseNode) {
    const stack = [...baseNode.childIds];
    while (stack.length > 0) {
      const descendantId = stack.pop()!;
      baseDescendants.add(descendantId);
      const descendant = context.base.nodes.get(descendantId);
      if (descendant) {
        stack.push(...descendant.childIds);
      }
    }
  }

  function shouldIncludeChildDescendant(childId: NodeId): boolean {
    return !baseDescendants.has(childId) || context.baseState.patchOwned.has(childId);
  }

  let root: SerializedPatchNode | undefined;
  const stack: Array<{
    currentId: NodeId;
    isRoot: boolean;
    assign: (node: SerializedPatchNode) => void;
  }> = [{
    currentId: nodeId,
    isRoot: true,
    assign: (node) => {
      root = node;
    },
  }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const currentId = frame.currentId;
    const current = context.target.nodes.get(currentId);
    if (!current) {
      throw new UnsupportedTransformError(`Replacement subtree target node "${currentId}" is missing.`, {
        details: { nodeId: currentId },
      });
    }

    if (
      !frame.isRoot &&
      baseDescendants.has(currentId) &&
      !context.baseState.patchOwned.has(currentId)
    ) {
      throw new UnsupportedTransformError(
        `Replacement subtree for "${nodeId}" would reuse source-backed descendant id "${currentId}".`,
        {
          details: { nodeId, reusedNodeId: currentId },
        },
      );
    }

    const childIds = current.childIds.filter((childId) =>
      shouldIncludeChildDescendant(childId)
    );
    const serialized: SerializedPatchNode = {
      id: current.id,
      type: String(current.type),
      attrs: encodeRuntimeValueForPointer(context.schemas, String(current.type), "", current.attrs),
      children: new Array<SerializedPatchNode>(childIds.length),
    };
    frame.assign(serialized);
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        currentId: childIds[index]!,
        isRoot: false,
        assign: (child) => {
          (serialized.children as SerializedPatchNode[])[index] = child;
        },
      });
    }
  }

  return root!;
}

function serializeInsertedSubtree<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  nodeId: NodeId,
): SerializedPatchNode {
  let root: SerializedPatchNode | undefined;
  const stack: Array<{
    nodeId: NodeId;
    assign: (node: SerializedPatchNode) => void;
  }> = [{
    nodeId,
    assign: (node) => {
      root = node;
    },
  }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const targetNode = context.target.nodes.get(frame.nodeId);
    if (!targetNode) {
      throw new UnsupportedTransformError(
        `Cannot serialize missing target node "${frame.nodeId}" for insert.`,
        { details: { nodeId: frame.nodeId } },
      );
    }
    const childIds = targetNode.childIds.filter(
      (childId) => !context.base.nodes.has(childId),
    );
    const serialized: SerializedPatchNode = {
      id: targetNode.id,
      type: String(targetNode.type),
      attrs: encodeRuntimeValueForPointer(
        context.schemas,
        String(targetNode.type),
        "",
        targetNode.attrs,
      ),
      children: new Array<SerializedPatchNode>(childIds.length),
    };
    frame.assign(serialized);
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: childIds[index]!,
        assign: (child) => {
          (serialized.children as SerializedPatchNode[])[index] = child;
        },
      });
    }
  }

  return root!;
}

function makePositionFromTarget<TTypes extends NodeTypeMap>(
  target: IndexedTree<TTypes>,
  nodeId: NodeId,
): ChildPosition | undefined {
  const parentId = target.index.parentById.get(nodeId);
  if (parentId == null) {
    return undefined;
  }

  const parent = target.nodes.get(parentId);
  if (!parent) {
    return undefined;
  }

  const index = parent.childIds.indexOf(nodeId);
  if (index <= 0) {
    return { atStart: true };
  }

  return { afterId: parent.childIds[index - 1]! };
}

function guardsForAnchor(parentId: NodeId, position: ChildPosition | undefined): Guard[] {
  const guards: Guard[] = [{ kind: "nodeExists", nodeId: parentId }];

  if (position && "afterId" in position) {
    guards.push({ kind: "nodeExists", nodeId: position.afterId });
    guards.push({ kind: "parentIs", nodeId: position.afterId, parentId });
  }
  if (position && "beforeId" in position) {
    guards.push({ kind: "nodeExists", nodeId: position.beforeId });
    guards.push({ kind: "parentIs", nodeId: position.beforeId, parentId });
  }

  return guards;
}

function guardsForCurrentPosition(
  nodeId: NodeId,
  siblings: readonly NodeId[],
  index: number,
): Guard[] {
  if (index < 0) {
    return [];
  }

  const guards: Guard[] = [];
  if (index === 0) {
    guards.push({ kind: "positionAtStart", nodeId });
  } else {
    guards.push({
      kind: "positionAfter",
      nodeId,
      afterId: siblings[index - 1]!,
    });
  }

  if (index === siblings.length - 1) {
    guards.push({ kind: "positionAtEnd", nodeId });
  } else {
    guards.push({
      kind: "positionBefore",
      nodeId,
      beforeId: siblings[index + 1]!,
    });
  }

  return guards;
}

function hasSameNodeOrder(
  left: readonly NodeId[],
  right: readonly NodeId[],
): boolean {
  return (
    left.length === right.length &&
    left.every((nodeId, index) => nodeId === right[index])
  );
}

function getValueAtPointer<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: NodeId,
  pointer: JsonPointer,
): { ok: true; value: unknown } | { ok: false } {
  const node = tree.nodes.get(nodeId);
  if (!node) {
    return { ok: false };
  }

  const resolution = resolvePointer(node.attrs, pointer);
  if (!resolution.ok) {
    return { ok: false };
  }

  return { ok: true, value: resolution.value };
}

function createValueGuard<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  nodeId: NodeId,
  pointer: JsonPointer,
): Guard | undefined {
  const baseNode = context.base.nodes.get(nodeId);
  if (!baseNode) {
    return undefined;
  }

  const baseValue = getValueAtPointer(context.base, nodeId, pointer);
  if (!baseValue.ok) {
    return undefined;
  }

  const value = baseValue.value;
  const adapter = getValueAdapterForSchemas(
    context.schemas,
    String(baseNode.type),
    pointer,
  );
  if (
    (adapter !== undefined && adapter.hash === undefined) ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return {
      kind: "attrEquals",
      nodeId,
      path: pointer,
      value: encodeRuntimeValueForPointer(context.schemas, String(baseNode.type), pointer, value),
    };
  }

  return {
    kind: "attrHash",
    nodeId,
    path: pointer,
    hash: getPathHash(context.base, nodeId, pointer),
  };
}

function collectAttrOpsForNode<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  nodeId: NodeId,
  pointer: JsonPointer,
  baseValue: unknown,
  targetValue: unknown,
  collected: PatchOp[],
): void {
  const baseNode = context.base.nodes.get(nodeId);
  const targetNode = context.target.nodes.get(nodeId);
  if (!baseNode || !targetNode) {
    return;
  }

  const nodeType = String(targetNode.type);
  const stack: Array<{
    pointer: JsonPointer;
    baseValue: unknown;
    targetValue: unknown;
  }> = [{ pointer, baseValue, targetValue }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const adapter = getValueAdapterForSchemas(
      context.schemas,
      nodeType,
      current.pointer,
    );
    if (
      adapter
        ? adapter.equals(
            current.baseValue as never,
            current.targetValue as never,
          )
        : Object.is(current.baseValue, current.targetValue)
    ) {
      continue;
    }

    if (
      current.pointer === "" &&
      !isPlainObject(current.baseValue) &&
      !isPlainObject(current.targetValue)
    ) {
      collected.push({
        kind: "setAttr",
        opId: context.opIds("set", nodeId, ""),
        nodeId,
        path: "",
        value: encodeRuntimeValueForPointer(
          context.schemas,
          nodeType,
          "",
          current.targetValue,
        ),
        guards: [createValueGuard(context, nodeId, "")].filter(
          (guard): guard is Guard => guard !== undefined,
        ),
      });
      continue;
    }

    if (
      isAtomicForSchemas(context.schemas, nodeType, current.pointer) ||
      adapter ||
      Array.isArray(current.baseValue) ||
      Array.isArray(current.targetValue) ||
      !isPlainObject(current.baseValue) ||
      !isPlainObject(current.targetValue)
    ) {
      if (
        !adapter &&
        deepEqual(current.baseValue, current.targetValue)
      ) {
        continue;
      }
      collected.push({
        kind: "setAttr",
        opId: context.opIds("set", nodeId, current.pointer),
        nodeId,
        path: current.pointer,
        value: encodeRuntimeValueForPointer(
          context.schemas,
          nodeType,
          current.pointer,
          current.targetValue,
        ),
        guards: [createValueGuard(context, nodeId, current.pointer)].filter(
          (guard): guard is Guard => guard !== undefined,
        ),
      });
      continue;
    }

    const keys = [...new Set([
      ...Object.keys(current.baseValue),
      ...Object.keys(current.targetValue),
    ])].sort();
    for (const key of keys) {
      const nextPointer = joinJsonPointer(current.pointer, key);
      const hasBase = Object.hasOwn(current.baseValue, key);
      const hasTarget = Object.hasOwn(current.targetValue, key);
      if (!hasTarget) {
        collected.push({
          kind: "removeAttr",
          opId: context.opIds("remove-attr", nodeId, nextPointer),
          nodeId,
          path: nextPointer,
          guards: [createValueGuard(context, nodeId, nextPointer)].filter(
            (guard): guard is Guard => guard !== undefined,
          ),
        });
      } else if (!hasBase) {
        collected.push({
          kind: "setAttr",
          opId: context.opIds("set", nodeId, nextPointer),
          nodeId,
          path: nextPointer,
          value: encodeRuntimeValueForPointer(
            context.schemas,
            nodeType,
            nextPointer,
            current.targetValue[key],
          ),
          guards: [{ kind: "attrAbsent", nodeId, path: nextPointer }],
        });
      } else {
        stack.push({
          pointer: nextPointer,
          baseValue: current.baseValue[key],
          targetValue: current.targetValue[key],
        });
      }
    }
  }
}

function collectReplacementRoots<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  options: DiffOptions<TTypes>,
  schemas: CompiledSchemas<TTypes>,
  targetPatchOwned: ReadonlySet<NodeId>,
): ReadonlySet<NodeId> {
  const baseState = getTreeState(base);
  const candidates = new Set<NodeId>();
  const precomputedThresholds = precomputeThresholds(base, target, options);

  for (const [nodeId, baseNode] of base.nodes) {
    const targetNode = target.nodes.get(nodeId);
    if (!targetNode) {
      continue;
    }

    if (baseNode.type !== targetNode.type) {
      candidates.add(nodeId);
    }
  }

  for (const [nodeId] of target.nodes) {
    if (!base.nodes.has(nodeId) || baseState.patchOwned.has(nodeId)) {
      continue;
    }

    const targetParentId = target.index.parentById.get(nodeId);
    if (targetParentId != null && targetPatchOwned.has(targetParentId)) {
      const fallbackRoot = findNearestViableReplacementRoot(base, target, baseState.patchOwned, nodeId);
      if (!fallbackRoot || options.unsupportedTransformPolicy === "error") {
        throw new UnsupportedTransformError(
          `Target shape for node "${nodeId}" requires moving a source-backed node under patch-owned parent "${targetParentId}".`,
          {
            details: { nodeId, parentId: targetParentId },
          },
        );
      }

      candidates.add(fallbackRoot);
    }
  }

  for (const [nodeId] of base.nodes) {
    const targetNode = target.nodes.get(nodeId);
    if (!targetNode || candidates.has(nodeId)) {
      continue;
    }

    const baseParentId = base.index.parentById.get(nodeId) ?? null;
    const targetParentId = target.index.parentById.get(nodeId) ?? null;
    const basePosition = base.index.positionById.get(nodeId) ?? 0;
    const targetPosition = target.index.positionById.get(nodeId) ?? 0;

    if (baseParentId !== targetParentId || basePosition !== targetPosition) {
      continue;
    }

    if (
      shouldReplaceSubtreeByThresholds(
        base,
        target,
        schemas,
        nodeId,
        options,
        precomputedThresholds,
      )
    ) {
      candidates.add(nodeId);
    }
  }

  return collapseReplacementRoots(target, candidates);
}

function buildPlanningState<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
) {
  const previousById = new Map<NodeId, NodeId | null>();
  const nextById = new Map<NodeId, NodeId | null>();
  const firstChildByParent = new Map<NodeId, NodeId | null>();
  const lastChildByParent = new Map<NodeId, NodeId | null>();
  const mutatedParents = new Set<NodeId>();
  for (const [parentId, node] of base.nodes) {
    const childIds = node.childIds.filter((childId) => target.nodes.has(childId));
    firstChildByParent.set(parentId, childIds[0] ?? null);
    lastChildByParent.set(parentId, childIds.at(-1) ?? null);
    for (let index = 0; index < childIds.length; index += 1) {
      const childId = childIds[index]!;
      previousById.set(childId, childIds[index - 1] ?? null);
      nextById.set(childId, childIds[index + 1] ?? null);
    }
    if (!hasSameNodeOrder(node.childIds, childIds)) {
      mutatedParents.add(parentId);
    }
  }

  return {
    parentById: new Map(base.index.parentById),
    previousById,
    nextById,
    firstChildByParent,
    lastChildByParent,
    mutatedParents,
  };
}

function linkPlanningNodeAfter<TTypes extends NodeTypeMap>(
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
  nodeId: NodeId,
  parentId: NodeId,
  previousId: NodeId | undefined,
): void {
  if (previousId === undefined) {
    const first = planning.firstChildByParent.get(parentId) ?? null;
    planning.previousById.set(nodeId, null);
    planning.nextById.set(nodeId, first);
    planning.firstChildByParent.set(parentId, nodeId);
    if (first === null) {
      planning.lastChildByParent.set(parentId, nodeId);
    } else {
      planning.previousById.set(first, nodeId);
    }
  } else {
    const next = planning.nextById.get(previousId) ?? null;
    planning.previousById.set(nodeId, previousId);
    planning.nextById.set(nodeId, next);
    planning.nextById.set(previousId, nodeId);
    if (next === null) {
      planning.lastChildByParent.set(parentId, nodeId);
    } else {
      planning.previousById.set(next, nodeId);
    }
  }
  planning.parentById.set(nodeId, parentId);
  planning.mutatedParents.add(parentId);
}

function initializePlanningChildren<TTypes extends NodeTypeMap>(
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
  parentId: NodeId,
  childIds: readonly NodeId[],
): void {
  planning.firstChildByParent.set(parentId, childIds[0] ?? null);
  planning.lastChildByParent.set(parentId, childIds.at(-1) ?? null);
  for (let index = 0; index < childIds.length; index += 1) {
    const childId = childIds[index]!;
    planning.previousById.set(childId, childIds[index - 1] ?? null);
    planning.nextById.set(childId, childIds[index + 1] ?? null);
  }
}

function insertPlanningSubtree<TTypes extends NodeTypeMap>(
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
  target: IndexedTree<TTypes>,
  base: IndexedTree<TTypes>,
  nodeId: NodeId,
  parentId: NodeId,
): void {
  const node = target.nodes.get(nodeId);
  if (!node) {
    return;
  }

  const targetParent = target.nodes.get(parentId);
  const targetIndex = target.index.positionById.get(nodeId) ?? 0;
  linkPlanningNodeAfter(
    planning,
    nodeId,
    parentId,
    targetIndex > 0 ? targetParent?.childIds[targetIndex - 1] : undefined,
  );

  const stack: Array<{ nodeId: NodeId; parentId: NodeId }> = [{
    nodeId,
    parentId,
  }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const currentNode = target.nodes.get(current.nodeId);
    if (!currentNode) {
      continue;
    }
    const insertedChildren = currentNode.childIds.filter(
      (childId) => !base.nodes.has(childId),
    );
    planning.parentById.set(current.nodeId, current.parentId);
    initializePlanningChildren(planning, current.nodeId, insertedChildren);
    for (let index = insertedChildren.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: insertedChildren[index]!,
        parentId: current.nodeId,
      });
    }
  }
}

function collectInsertOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
): InsertNodeOp[] {
  const inserts: InsertNodeOp[] = [];
  const stack: Array<{ nodeId: NodeId; childIndex: number }> = [{
    nodeId: context.target.rootId,
    childIndex: 0,
  }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const nodeId = frame.nodeId;
    if (context.replacementRoots.has(nodeId)) {
      continue;
    }

    const targetNode = context.target.nodes.get(nodeId);
    if (!targetNode) {
      continue;
    }
    if (frame.childIndex >= targetNode.childIds.length) {
      continue;
    }

    stack.push({ nodeId, childIndex: frame.childIndex + 1 });
    const childId = targetNode.childIds[frame.childIndex]!;
    if (context.replacementRoots.has(childId)) {
      continue;
    }
    if (!context.base.nodes.has(childId)) {
      const parentId = nodeId;
      const position = makePositionFromTarget(context.target, childId);
      const op: InsertNodeOp = {
        kind: "insertNode",
        opId: context.opIds("insert", childId),
        parentId,
        node: serializeInsertedSubtree(context, childId),
        guards: guardsForAnchor(parentId, position),
      };
      if (position !== undefined) {
        op.position = position;
      }
      inserts.push(op);
      insertPlanningSubtree(planning, context.target, context.base, childId, parentId);
      continue;
    }
    stack.push({ nodeId: childId, childIndex: 0 });
  }

  return inserts;
}

function collectMoveOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
): MoveNodeOp[] {
  const moves: MoveNodeOp[] = [];
  const {
    previousById,
    nextById,
    firstChildByParent,
    lastChildByParent,
    mutatedParents,
  } = planning;

  function orderMatches(parentId: NodeId, targetChildIds: readonly NodeId[]): boolean {
    let current = firstChildByParent.get(parentId) ?? null;
    for (const targetChildId of targetChildIds) {
      if (current !== targetChildId) {
        return false;
      }
      current = nextById.get(current) ?? null;
    }
    return current === null;
  }

  function movePlanningNodeLinked(
    nodeId: NodeId,
    oldParentId: NodeId | null,
    newParentId: NodeId,
    previousId: NodeId | undefined,
  ): void {
    if (oldParentId != null) {
      const previous = previousById.get(nodeId) ?? null;
      const next = nextById.get(nodeId) ?? null;
      if (previous === null) {
        firstChildByParent.set(oldParentId, next);
      } else {
        nextById.set(previous, next);
      }
      if (next === null) {
        lastChildByParent.set(oldParentId, previous);
      } else {
        previousById.set(next, previous);
      }
      mutatedParents.add(oldParentId);
    }

    if (previousId === undefined) {
      const first = firstChildByParent.get(newParentId) ?? null;
      previousById.set(nodeId, null);
      nextById.set(nodeId, first);
      firstChildByParent.set(newParentId, nodeId);
      if (first === null) {
        lastChildByParent.set(newParentId, nodeId);
      } else {
        previousById.set(first, nodeId);
      }
    } else {
      const next = nextById.get(previousId) ?? null;
      previousById.set(nodeId, previousId);
      nextById.set(nodeId, next);
      nextById.set(previousId, nodeId);
      if (next === null) {
        lastChildByParent.set(newParentId, nodeId);
      } else {
        previousById.set(next, nodeId);
      }
    }
    planning.parentById.set(nodeId, newParentId);
    mutatedParents.add(newParentId);
  }

  const stack: Array<{ parentId: NodeId; childIndex: number }> = [{
    parentId: context.target.rootId,
    childIndex: 0,
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const parentId = frame.parentId;
    if (context.replacementRoots.has(parentId)) {
      continue;
    }

    const parent = context.target.nodes.get(parentId);
    if (!parent) {
      continue;
    }

    if (
      frame.childIndex === 0 &&
      orderMatches(parentId, parent.childIds)
    ) {
      for (let index = parent.childIds.length - 1; index >= 0; index -= 1) {
        const childId = parent.childIds[index]!;
        if (!context.replacementRoots.has(childId)) {
          stack.push({ parentId: childId, childIndex: 0 });
        }
      }
      continue;
    }
    if (frame.childIndex >= parent.childIds.length) {
      continue;
    }

    stack.push({ parentId, childIndex: frame.childIndex + 1 });
    const index = frame.childIndex;
    const nodeId = parent.childIds[index]!;
    if (!context.base.nodes.has(nodeId)) {
      if (context.target.nodes.has(nodeId)) {
        stack.push({ parentId: nodeId, childIndex: 0 });
      }
      continue;
    }

    const targetParentId = parentId;
    const targetPreviousSibling = index > 0 ? parent.childIds[index - 1]! : undefined;
    const currentParentId = planning.parentById.get(nodeId) ?? null;
    const currentPreviousSibling = previousById.get(nodeId) ?? null;
    const sourceSiblings =
      currentParentId != null
        ? context.base.nodes.get(currentParentId)?.childIds
        : undefined;
    const currentPositionGuards =
      sourceSiblings &&
      currentParentId != null &&
      !mutatedParents.has(currentParentId)
        ? guardsForCurrentPosition(
            nodeId,
            sourceSiblings,
            context.base.index.positionById.get(nodeId) ?? -1,
          )
        : [];
    const alreadyCorrect =
      currentParentId === targetParentId &&
      currentPreviousSibling === (targetPreviousSibling ?? null);

    if (!alreadyCorrect) {
      const position: ChildPosition =
        targetPreviousSibling === undefined
          ? { atStart: true }
          : { afterId: targetPreviousSibling };
      moves.push({
        kind: "moveNode",
        opId: context.opIds("move", nodeId),
        nodeId,
        newParentId: targetParentId,
        position,
        guards: [
          { kind: "nodeExists", nodeId },
          { kind: "nodeExists", nodeId: targetParentId },
          {
            kind: "parentIs",
            nodeId,
            parentId: context.base.index.parentById.get(nodeId) ?? null,
          },
          ...currentPositionGuards,
          ...guardsForAnchor(targetParentId, position),
        ],
      });
      movePlanningNodeLinked(
        nodeId,
        currentParentId,
        targetParentId,
        targetPreviousSibling,
      );
    }

    if (!context.replacementRoots.has(nodeId)) {
      stack.push({ parentId: nodeId, childIndex: 0 });
    }
  }

  return moves;
}

function collectReorderOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
): ReorderChildrenOp[] {
  const reorders: ReorderChildrenOp[] = [];
  const parentIds = [...context.target.nodes.keys()].sort(compareStrings);

  for (const parentId of parentIds) {
    if (context.replacementCoveredInTarget.has(parentId)) {
      continue;
    }
    const baseParent = context.base.nodes.get(parentId);
    const targetParent = context.target.nodes.get(parentId);
    if (
      !baseParent ||
      !targetParent ||
      hasSameNodeOrder(baseParent.childIds, targetParent.childIds) ||
      baseParent.childIds.length !== targetParent.childIds.length
    ) {
      continue;
    }

    const baseChildIds = new Set(baseParent.childIds);
    if (!targetParent.childIds.every((childId) => baseChildIds.has(childId))) {
      continue;
    }

    reorders.push({
      kind: "reorderChildren",
      opId: context.opIds("reorder", parentId),
      parentId,
      childIds: [...targetParent.childIds],
      guards: [{
        kind: "childOrderHash",
        parentId,
        hash: getChildOrderHash(baseParent.childIds),
      }],
    });
    initializePlanningChildren(
      planning,
      parentId,
      targetParent.childIds,
    );
    planning.mutatedParents.add(parentId);
  }

  return reorders;
}

function collectAttrOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
): Array<SetAttrOp | RemoveAttrOp> {
  const ops: Array<SetAttrOp | RemoveAttrOp> = [];

  for (const [nodeId, baseNode] of context.base.nodes) {
    const targetNode = context.target.nodes.get(nodeId);
    if (
      !targetNode ||
      context.replacementCoveredInTarget.has(nodeId)
    ) {
      continue;
    }

    if (
      getSubtreeHash(context.base, nodeId) === getSubtreeHash(context.target, nodeId)
    ) {
      continue;
    }

    const requiresSemanticComparison =
      context.semanticComparisonNodeTypes.has(String(baseNode.type));
    if (
      requiresSemanticComparison ||
      getNodeHash(context.base, nodeId) !== getNodeHash(context.target, nodeId)
    ) {
      collectAttrOpsForNode(context, nodeId, "", baseNode.attrs, targetNode.attrs, ops);
    }
  }

  return ops.sort((left, right) => {
    if (left.nodeId !== right.nodeId) {
      return compareStrings(left.nodeId, right.nodeId);
    }
    return compareStrings(left.path, right.path);
  });
}

function collectReplacementOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
): ReplaceSubtreeOp[] {
  return [...context.replacementRoots]
    .sort((left, right) => {
      const depthDiff = (context.target.index.depthById.get(left) ?? 0) - (context.target.index.depthById.get(right) ?? 0);
      return depthDiff === 0 ? compareStrings(left, right) : depthDiff;
    })
    .map((nodeId) => ({
      kind: "replaceSubtree" as const,
      opId: context.opIds("replace", nodeId),
      nodeId,
      node: serializeReplacementSubtree(context, nodeId),
      guards: [{ kind: "subtreeHash" as const, nodeId, hash: getSubtreeHash(context.base, nodeId) }],
    }));
}

function collectReplacementInsertOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
): InsertNodeOp[] {
  const inserts: InsertNodeOp[] = [];

  function isOmittedSourceBackedDescendant(replacementRootId: NodeId, nodeId: NodeId): boolean {
    return (
      nodeId !== replacementRootId &&
      context.base.nodes.has(nodeId) &&
      context.replacementCoveredInBase.has(nodeId) &&
      !context.baseState.patchOwned.has(nodeId)
    );
  }

  function visitReplacementRoot(replacementRootId: NodeId): void {
    const stack: Array<{ nodeId: NodeId; childIndex: number }> = [{
      nodeId: replacementRootId,
      childIndex: 0,
    }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const node = context.target.nodes.get(frame.nodeId);
      if (!node) {
        continue;
      }
      if (frame.childIndex >= node.childIds.length) {
        continue;
      }

      stack.push({
        nodeId: frame.nodeId,
        childIndex: frame.childIndex + 1,
      });
      const childId = node.childIds[frame.childIndex]!;
      if (!isOmittedSourceBackedDescendant(replacementRootId, childId)) {
        stack.push({ nodeId: childId, childIndex: 0 });
        continue;
      }

      const parentId = frame.nodeId;
      const position = makePositionFromTarget(context.target, childId);
      const op: InsertNodeOp = {
        kind: "insertNode",
        opId: context.opIds("insert", childId),
        parentId,
        node: serializeInsertedSubtree(
          {
            ...context,
            base: {
              ...context.base,
              nodes: new Map(),
            } as IndexedTree<TTypes>,
          },
          childId,
        ),
        guards: guardsForAnchor(parentId, position),
      };
      if (position !== undefined) {
        op.position = position;
      }
      inserts.push(op);
    }
  }

  [...context.replacementRoots]
    .sort((left, right) => {
      const depthDiff = (context.target.index.depthById.get(left) ?? 0) - (context.target.index.depthById.get(right) ?? 0);
      return depthDiff === 0 ? compareStrings(left, right) : depthDiff;
    })
    .forEach((replacementRootId) => {
      visitReplacementRoot(replacementRootId);
    });

  return inserts;
}

function collectVisibilityOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
): Array<HideNodeOp | ShowNodeOp> {
  const ops: Array<HideNodeOp | ShowNodeOp> = [];
  const baseHidden = context.baseState.explicitHidden;
  const targetHidden = context.targetState.explicitHidden;

  for (const [nodeId] of context.target.nodes) {
    if (nodeId === context.target.rootId) {
      continue;
    }

    const baseHasNode = context.base.nodes.has(nodeId);
    const targetExplicitlyHidden = targetHidden.has(nodeId);
    const baseExplicitlyHidden = baseHidden.has(nodeId);
    const coveredByReplacement = context.replacementCoveredInTarget.has(nodeId);

    if (targetExplicitlyHidden && !baseExplicitlyHidden) {
      ops.push({
        kind: "hideNode",
        opId: context.opIds("hide", nodeId),
        nodeId,
        guards: [{ kind: "nodeExists", nodeId }],
      });
    }

    const needsShow =
      baseHasNode &&
      !targetExplicitlyHidden &&
      baseExplicitlyHidden &&
      (!coveredByReplacement || context.replacementRoots.has(nodeId));

    if (needsShow) {
      ops.push({
        kind: "showNode",
        opId: context.opIds("show", nodeId),
        nodeId,
        guards: [{ kind: "nodeExists", nodeId }],
      });
    }
  }

  const missingSourceBackedRoots = [...context.base.nodes.keys()]
    .filter((nodeId) => {
      if (nodeId === context.base.rootId || context.baseState.patchOwned.has(nodeId) || context.target.nodes.has(nodeId)) {
        return false;
      }
      if (context.replacementCoveredInBase.has(nodeId)) {
        return false;
      }
      const parentId = context.base.index.parentById.get(nodeId);
      return !(parentId && !context.baseState.patchOwned.has(parentId) && !context.target.nodes.has(parentId));
    })
    .sort((left, right) => {
      const depthDiff = (context.base.index.depthById.get(left) ?? 0) - (context.base.index.depthById.get(right) ?? 0);
      return depthDiff === 0 ? compareStrings(left, right) : depthDiff;
    });

  for (const nodeId of missingSourceBackedRoots) {
    if (context.options.hideMissingSourceNodes === false) {
      throw new UnsupportedTransformError(
        `Target omits source-backed node "${nodeId}" while hideMissingSourceNodes is false.`,
        {
          details: { nodeId },
        },
      );
    }

    if (isEffectivelyHidden(context.base, nodeId)) {
      continue;
    }

    ops.push({
      kind: "hideNode",
      opId: context.opIds("hide", nodeId),
      nodeId,
      guards: [
        { kind: "nodeExists", nodeId },
        { kind: "nodeTypeIs", nodeId, nodeType: String(context.base.nodes.get(nodeId)!.type) },
      ],
    });
  }

  return ops;
}

function collectRemoveOps<TTypes extends NodeTypeMap>(context: DiffContext<TTypes>): RemoveNodeOp[] {
  const roots = [...context.base.nodes.keys()]
    .filter((nodeId) => {
      if (nodeId === context.base.rootId || !context.baseState.patchOwned.has(nodeId) || context.target.nodes.has(nodeId)) {
        return false;
      }
      if (context.replacementCoveredInBase.has(nodeId)) {
        return false;
      }

      const parentId = context.base.index.parentById.get(nodeId);
      return !(parentId && context.baseState.patchOwned.has(parentId) && !context.target.nodes.has(parentId));
    })
    .sort((left, right) => {
      const depthDiff = (context.base.index.depthById.get(right) ?? 0) - (context.base.index.depthById.get(left) ?? 0);
      return depthDiff === 0 ? compareStrings(left, right) : depthDiff;
    });

  return roots.map((nodeId) => ({
    kind: "removeNode" as const,
    opId: context.opIds("remove-node", nodeId),
    nodeId,
    guards: [
      { kind: "nodeExists" as const, nodeId },
      { kind: "parentIs" as const, nodeId, parentId: context.base.index.parentById.get(nodeId) ?? null },
    ],
  }));
}

export function diffTrees<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  options: DiffOptions<TTypes> = {},
): TreePatch {
  if (base.rootId !== target.rootId) {
    throw new UnsupportedTransformError(
      `Cannot diff trees with different root ids "${base.rootId}" and "${target.rootId}".`,
      {
        details: { baseRootId: base.rootId, targetRootId: target.rootId },
      },
    );
  }

  base = createRawTreeView(base);
  target = createRawTreeView(target);
  const schemas = getCompiledSchemas(base, target, options);
  const baseHiddenSignature = collectExplicitHiddenSignature(base);
  const targetHiddenSignature = collectExplicitHiddenSignature(target);
  if (
    getSubtreeHash(base, base.rootId) === getSubtreeHash(target, target.rootId) &&
    baseHiddenSignature === targetHiddenSignature
  ) {
    return {
      format: "tree-patch/v1",
      patchId: buildPatchId(base, target),
      ...(base.revision !== undefined ? { baseRevision: base.revision } : {}),
      ops: [],
    };
  }

  const targetPatchOwned = getEffectivePatchOwnedSet(base, target);
  const replacementRoots = collectReplacementRoots(base, target, options, schemas, targetPatchOwned);
  const replacementCoveredInBase = collectNodesCoveredByRoots(base, replacementRoots);
  const replacementCoveredInTarget = collectNodesCoveredByRoots(target, replacementRoots);
  const context: DiffContext<TTypes> = {
    base,
    target,
    baseState: getTreeState(base),
    targetState: getTreeState(target),
    schemas,
    semanticComparisonNodeTypes: getSemanticComparisonNodeTypes(schemas),
    options,
    targetPatchOwned,
    replacementRoots,
    replacementCoveredInBase,
    replacementCoveredInTarget,
    opIds: createOpIdFactory(),
  };

  const planning = buildPlanningState(base, target);
  const inserts = collectInsertOps(context, planning);
  const reorders = collectReorderOps(context, planning);
  const moves = collectMoveOps(context, planning);
  const attrOps = collectAttrOps(context);
  const replacements = collectReplacementOps(context);
  const replacementInserts = collectReplacementInsertOps(context);
  const visibility = collectVisibilityOps(context);
  const removals = collectRemoveOps(context);

  return {
    format: "tree-patch/v1",
    patchId: buildPatchId(base, target),
    ...(base.revision !== undefined ? { baseRevision: base.revision } : {}),
    ops: [...inserts, ...reorders, ...moves, ...attrOps, ...replacements, ...replacementInserts, ...visibility, ...removals],
  };
}

export function rebasePatch<TTypes extends NodeTypeMap>(
  oldBase: IndexedTree<TTypes>,
  newBase: IndexedTree<TTypes>,
  patch: TreePatch,
  options: RebaseOptions = {},
): RebaseResult<TTypes> {
  assertPatchEnvelope(patch);
  const sourceValidation = executePatchInternal(oldBase, patch, {
    mode: "preview",
    produceTree: false,
    patchValidated: true,
  });
  if (
    sourceValidation.conflicts.length > 0 ||
    sourceValidation.revision.status === "mismatch"
  ) {
    throw new InvalidResolutionInputError(
      `Rebase requires a patch that applies cleanly to its original base; patch "${patch.patchId}" does not match the provided old base.`,
      {
        details: {
          patchId: patch.patchId,
          revision: sourceValidation.revision,
          conflicts: sourceValidation.conflicts,
        },
      },
    );
  }

  const execution = executePatchInternal(newBase, patch, {
    mode: "preview",
    produceTree: true,
    patchValidated: true,
  });

  const rebasedPatch =
    execution.appliedOps.length > 0 || execution.conflicts.length === 0
      ? {
          format: "tree-patch/v1" as const,
          patchId: patch.patchId,
          ...(newBase.revision !== undefined ? { baseRevision: newBase.revision } : {}),
          ...(patch.metadata !== undefined
            ? { metadata: cloneJsonValue(patch.metadata) }
            : {}),
          ops: execution.appliedOps,
        }
      : undefined;

  return {
    revision: execution.revision,
    conflicts: execution.conflicts,
    appliedOpIds: execution.appliedOpIds,
    skippedOpIds: execution.skippedOpIds,
    ...(rebasedPatch !== undefined ? { rebasedPatch } : {}),
    ...(execution.tree !== undefined ? { preview: execution.tree } : {}),
  };
}
