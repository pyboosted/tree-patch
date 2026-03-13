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
  RebaseOptions,
  RebaseResult,
  ReplaceSubtreeOp,
  SetAttrOp,
  SerializedPatchNode,
  ShowNodeOp,
  TreePatch,
} from "./types.js";
import { UnsupportedTransformError } from "./errors.js";
import { executePatchInternal } from "./apply.js";
import { getNodeHash, getPathHash, getSubtreeHash, joinJsonPointer } from "./hash.js";
import { getTreeState } from "./state.js";
import { isPlainObject } from "./snapshot.js";
import {
  deepEqual,
} from "../schema/adapters.js";
import type { CompiledTreeSchema } from "../schema/schema.js";
import {
  compileTreeSchema,
} from "../schema/schema.js";
import { resolvePointer } from "../schema/pointers.js";
import {
  type CompiledSchemas,
  encodeRuntimeValueForPointer,
  getValueAdapterForSchemas,
  isAtomicForSchemas,
} from "../schema/runtime-values.js";
import { hashStableParts } from "./stable-hash.js";

interface DiffContext<TTypes extends NodeTypeMap> {
  readonly base: IndexedTree<TTypes>;
  readonly target: IndexedTree<TTypes>;
  readonly baseState: ReturnType<typeof getTreeState<TTypes>>;
  readonly targetState: ReturnType<typeof getTreeState<TTypes>>;
  readonly schemas: CompiledSchemas<TTypes>;
  readonly options: DiffOptions<TTypes>;
  readonly targetPatchOwned: ReadonlySet<NodeId>;
  readonly replacementRoots: ReadonlySet<NodeId>;
  readonly opIds: ReturnType<typeof createOpIdFactory>;
}

interface ThresholdStats {
  changedAttrCount: number;
  changedChildCount: number;
  changedNodeCount: number;
  baseNodeCount: number;
  targetNodeCount: number;
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

  function visit(nodeId: NodeId, inheritedPatchOwned: boolean): void {
    const targetNode = target.nodes.get(nodeId);
    if (!targetNode) {
      return;
    }

    const currentPatchOwned =
      inheritedPatchOwned ||
      targetState.patchOwned.has(nodeId) ||
      !base.nodes.has(nodeId);
    if (currentPatchOwned) {
      effective.add(nodeId);
    }

    targetNode.childIds.forEach((childId) => {
      visit(childId, currentPatchOwned);
    });
  }

  visit(target.rootId, false);
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
    getSubtreeHash(base, base.rootId),
    collectExplicitHiddenSignature(base),
    getSubtreeHash(target, target.rootId),
    collectExplicitHiddenSignature(target),
  ])}`;
}

function isCoveredByRoots<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: NodeId,
  roots: ReadonlySet<NodeId>,
  includeSelf = false,
): boolean {
  let current = includeSelf ? nodeId : (tree.index.parentById.get(nodeId) ?? null);
  while (current != null) {
    if (roots.has(current)) {
      return true;
    }
    current = tree.index.parentById.get(current) ?? null;
  }

  return false;
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
  const sorted = [...candidates].sort((left, right) => {
    const depthDiff = (target.index.depthById.get(left) ?? 0) - (target.index.depthById.get(right) ?? 0);
    return depthDiff === 0 ? left.localeCompare(right) : depthDiff;
  });

  const collapsed = new Set<NodeId>();
  for (const nodeId of sorted) {
    if (!isCoveredByRoots(target, nodeId, collapsed, false)) {
      collapsed.add(nodeId);
    }
  }

  return collapsed;
}

function getSubtreeNodeCount<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  nodeId: NodeId,
): number {
  const node = tree.nodes.get(nodeId);
  if (!node) {
    return 0;
  }

  return 1 + node.childIds.reduce((total, childId) => total + getSubtreeNodeCount(tree, childId), 0);
}

function countAttrChanges<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string,
  baseValue: unknown,
  targetValue: unknown,
  pointer: JsonPointer,
): number {
  if (deepEqual(baseValue, targetValue)) {
    return 0;
  }

  if (
    isAtomicForSchemas(schemas, nodeType, pointer) ||
    getValueAdapterForSchemas(schemas, nodeType, pointer) ||
    Array.isArray(baseValue) ||
    Array.isArray(targetValue) ||
    !isPlainObject(baseValue) ||
    !isPlainObject(targetValue)
  ) {
    return 1;
  }

  const keys = [...new Set([...Object.keys(baseValue), ...Object.keys(targetValue)])].sort();
  return keys.reduce((total, key) => {
    const nextPointer = joinJsonPointer(pointer, key);
    const hasBase = key in baseValue;
    const hasTarget = key in targetValue;

    if (!hasBase || !hasTarget) {
      return total + 1;
    }

    return total + countAttrChanges(
      schemas,
      nodeType,
      baseValue[key],
      targetValue[key],
      nextPointer,
    );
  }, 0);
}

function collectChangedNodesWithinSubtree<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  nodeId: NodeId,
): number {
  const baseNode = base.nodes.get(nodeId);
  const targetNode = target.nodes.get(nodeId);
  if (!baseNode || !targetNode) {
    return 1;
  }
  if (getSubtreeHash(base, nodeId) === getSubtreeHash(target, nodeId)) {
    return 0;
  }

  let changed = 0;
  if (
    baseNode.type !== targetNode.type ||
    baseNode.childIds.length !== targetNode.childIds.length ||
    baseNode.childIds.some((childId, index) => childId !== targetNode.childIds[index])
  ) {
    changed += 1;
  }

  const baseChildIdSet = new Set(baseNode.childIds);
  const targetChildIdSet = new Set(targetNode.childIds);
  const childIds = new Set([...baseNode.childIds, ...targetNode.childIds]);
  for (const childId of childIds) {
    if (baseChildIdSet.has(childId) && targetChildIdSet.has(childId)) {
      changed += collectChangedNodesWithinSubtree(base, target, childId);
      continue;
    }

    if (base.nodes.has(childId) || target.nodes.has(childId)) {
      changed += 1;
    }
  }

  return changed;
}

function shouldReplaceSubtreeByThresholds<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
  schemas: CompiledSchemas<TTypes>,
  nodeId: NodeId,
  options: DiffOptions<TTypes>,
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

  const baseChildPositions = new Map(baseNode.childIds.map((childId, index) => [childId, index]));
  const targetChildPositions = new Map(
    targetNode.childIds.map((childId, index) => [childId, index]),
  );

  const stats: ThresholdStats = {
    changedAttrCount: countAttrChanges(schemas, String(baseNode.type), baseNode.attrs, targetNode.attrs, ""),
    changedChildCount: [...new Set([...baseNode.childIds, ...targetNode.childIds])].filter((childId) => {
      const baseIndex = baseChildPositions.get(childId);
      const targetIndex = targetChildPositions.get(childId);
      return baseIndex === undefined || targetIndex === undefined || baseIndex !== targetIndex;
    }).length,
    changedNodeCount: collectChangedNodesWithinSubtree(base, target, nodeId),
    baseNodeCount: getSubtreeNodeCount(base, nodeId),
    targetNodeCount: getSubtreeNodeCount(target, nodeId),
  };

  const subtreeChangeRatio =
    stats.changedNodeCount /
    Math.max(stats.baseNodeCount, stats.targetNodeCount, 1);

  return (
    (thresholds.changedAttrCountGte !== undefined &&
      stats.changedAttrCount >= thresholds.changedAttrCountGte) ||
    (thresholds.changedChildCountGte !== undefined &&
      stats.changedChildCount >= thresholds.changedChildCountGte) ||
    (thresholds.subtreeChangeRatioGte !== undefined &&
      subtreeChangeRatio >= thresholds.subtreeChangeRatioGte)
  );
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

  function visit(currentId: NodeId, isRoot: boolean): SerializedPatchNode {
    const current = context.target.nodes.get(currentId);
    if (!current) {
      throw new UnsupportedTransformError(`Replacement subtree target node "${currentId}" is missing.`, {
        details: { nodeId: currentId },
      });
    }

    if (!isRoot && baseDescendants.has(currentId) && !context.baseState.patchOwned.has(currentId)) {
      throw new UnsupportedTransformError(
        `Replacement subtree for "${nodeId}" would reuse source-backed descendant id "${currentId}".`,
        {
          details: { nodeId, reusedNodeId: currentId },
        },
      );
    }

    return {
      id: current.id,
      type: String(current.type),
      attrs: encodeRuntimeValueForPointer(context.schemas, String(current.type), "", current.attrs),
      children: current.childIds
        .filter((childId) => shouldIncludeChildDescendant(childId))
        .map((childId) => visit(childId, false)),
    };
  }

  return visit(nodeId, true);
}

function serializeInsertedSubtree<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  nodeId: NodeId,
): SerializedPatchNode {
  const targetNode = context.target.nodes.get(nodeId);
  if (!targetNode) {
    throw new UnsupportedTransformError(`Cannot serialize missing target node "${nodeId}" for insert.`, {
      details: { nodeId },
    });
  }

  return {
    id: targetNode.id,
    type: String(targetNode.type),
    attrs: encodeRuntimeValueForPointer(context.schemas, String(targetNode.type), "", targetNode.attrs),
    children: targetNode.childIds
      .filter((childId) => !context.base.nodes.has(childId))
      .map((childId) => serializeInsertedSubtree(context, childId)),
  };
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
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
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

  const baseAtPath = pointer === "" ? { ok: true as const } : getValueAtPointer(context.base, nodeId, pointer);
  const targetAtPath = pointer === "" ? { ok: true as const } : getValueAtPointer(context.target, nodeId, pointer);
  if (pointer !== "" && baseAtPath.ok && targetAtPath.ok) {
    try {
      if (getPathHash(context.base, nodeId, pointer) === getPathHash(context.target, nodeId, pointer)) {
        return;
      }
    } catch {
      // Fall through to structural comparison if either side cannot provide a path hash.
    }
  }

  if (deepEqual(baseValue, targetValue)) {
    return;
  }

  if (
    pointer === "" &&
    !isPlainObject(baseValue) &&
    !isPlainObject(targetValue)
  ) {
    collected.push({
      kind: "setAttr",
      opId: context.opIds("set", nodeId, ""),
      nodeId,
      path: "",
      value: encodeRuntimeValueForPointer(context.schemas, String(targetNode.type), "", targetValue),
      guards: [{ kind: "subtreeHash", nodeId, hash: getSubtreeHash(context.base, nodeId) }],
    });
    return;
  }

  if (
    isAtomicForSchemas(context.schemas, String(targetNode.type), pointer) ||
    getValueAdapterForSchemas(context.schemas, String(targetNode.type), pointer) ||
    Array.isArray(baseValue) ||
    Array.isArray(targetValue) ||
    !isPlainObject(baseValue) ||
    !isPlainObject(targetValue)
  ) {
    if (pointer === "") {
      collected.push({
        kind: "setAttr",
        opId: context.opIds("set", nodeId, ""),
        nodeId,
        path: "",
        value: encodeRuntimeValueForPointer(context.schemas, String(targetNode.type), "", targetValue),
        guards: [{ kind: "subtreeHash", nodeId, hash: getSubtreeHash(context.base, nodeId) }],
      });
      return;
    }

    collected.push({
      kind: "setAttr",
      opId: context.opIds("set", nodeId, pointer),
      nodeId,
      path: pointer,
      value: encodeRuntimeValueForPointer(context.schemas, String(targetNode.type), pointer, targetValue),
      guards: [createValueGuard(context, nodeId, pointer)].filter((guard): guard is Guard => guard !== undefined),
    });
    return;
  }

  const keys = [...new Set([...Object.keys(baseValue), ...Object.keys(targetValue)])].sort();
  for (const key of keys) {
    const nextPointer = joinJsonPointer(pointer, key);
    const hasBase = key in baseValue;
    const hasTarget = key in targetValue;

    if (!hasTarget) {
      collected.push({
        kind: "removeAttr",
        opId: context.opIds("remove-attr", nodeId, nextPointer),
        nodeId,
        path: nextPointer,
        guards: [createValueGuard(context, nodeId, nextPointer)].filter((guard): guard is Guard => guard !== undefined),
      });
      continue;
    }

    if (!hasBase) {
      collected.push({
        kind: "setAttr",
        opId: context.opIds("set", nodeId, nextPointer),
        nodeId,
        path: nextPointer,
        value: encodeRuntimeValueForPointer(
          context.schemas,
          String(targetNode.type),
          nextPointer,
          targetValue[key],
        ),
      });
      continue;
    }

    collectAttrOpsForNode(
      context,
      nodeId,
      nextPointer,
      baseValue[key],
      targetValue[key],
      collected,
    );
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

    if (shouldReplaceSubtreeByThresholds(base, target, schemas, nodeId, options)) {
      candidates.add(nodeId);
    }
  }

  return collapseReplacementRoots(target, candidates);
}

function buildPlanningState<TTypes extends NodeTypeMap>(
  base: IndexedTree<TTypes>,
  target: IndexedTree<TTypes>,
) {
  return {
    parentById: new Map(base.index.parentById),
    childIdsByParent: new Map(
      [...base.nodes].map(([nodeId, node]) => [
        nodeId,
        [...node.childIds].filter((childId) => target.nodes.has(childId)),
      ]),
    ),
    presentIds: new Set([...base.nodes.keys()].filter((nodeId) => target.nodes.has(nodeId))),
  };
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

  const siblings = planning.childIdsByParent.get(parentId) ?? [];
  const targetParent = target.nodes.get(parentId);
  const targetIndex = targetParent?.childIds.indexOf(nodeId) ?? siblings.length;
  const insertIndex =
    targetIndex <= 0
      ? 0
      : siblings.indexOf(targetParent!.childIds[targetIndex - 1]!) + 1;

  siblings.splice(Math.max(0, insertIndex), 0, nodeId);
  planning.childIdsByParent.set(parentId, siblings);

  planning.presentIds.add(nodeId);
  planning.parentById.set(nodeId, parentId);
  planning.childIdsByParent.set(nodeId, [...node.childIds.filter((childId) => !base.nodes.has(childId))]);

  node.childIds
    .filter((childId) => !base.nodes.has(childId))
    .forEach((childId) => {
      insertPlanningSubtree(planning, target, base, childId, nodeId);
    });
}

function movePlanningNode<TTypes extends NodeTypeMap>(
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
  nodeId: NodeId,
  newParentId: NodeId,
  position: ChildPosition | undefined,
): void {
  const oldParentId = planning.parentById.get(nodeId);
  if (oldParentId != null) {
    const oldSiblings = planning.childIdsByParent.get(oldParentId) ?? [];
    const oldIndex = oldSiblings.indexOf(nodeId);
    if (oldIndex >= 0) {
      oldSiblings.splice(oldIndex, 1);
    }
    planning.childIdsByParent.set(oldParentId, oldSiblings);
  }

  const siblings = planning.childIdsByParent.get(newParentId) ?? [];
  let insertIndex = siblings.length;
  if (position && "atStart" in position) {
    insertIndex = 0;
  } else if (position && "afterId" in position) {
    insertIndex = siblings.indexOf(position.afterId) + 1;
  } else if (position && "beforeId" in position) {
    insertIndex = siblings.indexOf(position.beforeId);
  }

  siblings.splice(Math.max(0, insertIndex), 0, nodeId);
  planning.childIdsByParent.set(newParentId, siblings);
  planning.parentById.set(nodeId, newParentId);
}

function collectInsertOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
): InsertNodeOp[] {
  const inserts: InsertNodeOp[] = [];

  function visit(nodeId: NodeId): void {
    if (context.replacementRoots.has(nodeId)) {
      return;
    }

    const targetNode = context.target.nodes.get(nodeId);
    if (!targetNode) {
      return;
    }

    for (const childId of targetNode.childIds) {
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

      visit(childId);
    }
  }

  visit(context.target.rootId);
  return inserts;
}

function collectMoveOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
  planning: ReturnType<typeof buildPlanningState<TTypes>>,
): MoveNodeOp[] {
  const moves: MoveNodeOp[] = [];

  function visit(parentId: NodeId): void {
    if (context.replacementRoots.has(parentId)) {
      return;
    }

    const parent = context.target.nodes.get(parentId);
    if (!parent) {
      return;
    }

    for (let index = 0; index < parent.childIds.length; index += 1) {
      const nodeId = parent.childIds[index]!;
      if (!context.base.nodes.has(nodeId) || context.replacementRoots.has(nodeId)) {
        if (context.target.nodes.has(nodeId)) {
          visit(nodeId);
        }
        continue;
      }

      const targetParentId = parentId;
      const targetPreviousSibling = index > 0 ? parent.childIds[index - 1]! : undefined;
      const currentParentId = planning.parentById.get(nodeId) ?? null;
      const currentSiblings = currentParentId != null ? planning.childIdsByParent.get(currentParentId) ?? [] : [];
      const currentIndex = currentSiblings.indexOf(nodeId);
      const alreadyCorrect =
        currentParentId === targetParentId &&
        ((targetPreviousSibling === undefined && currentIndex === 0) ||
          (targetPreviousSibling !== undefined && currentIndex > 0 && currentSiblings[currentIndex - 1] === targetPreviousSibling));

      if (!alreadyCorrect) {
        const position: ChildPosition =
          targetPreviousSibling === undefined ? { atStart: true } : { afterId: targetPreviousSibling };
        moves.push({
          kind: "moveNode",
          opId: context.opIds("move", nodeId),
          nodeId,
          newParentId: targetParentId,
          position,
          guards: [
            { kind: "nodeExists", nodeId },
            { kind: "nodeExists", nodeId: targetParentId },
            { kind: "parentIs", nodeId, parentId: context.base.index.parentById.get(nodeId) ?? null },
            ...guardsForAnchor(targetParentId, position),
          ],
        });
        movePlanningNode(planning, nodeId, targetParentId, position);
      }

      visit(nodeId);
    }
  }

  visit(context.target.rootId);
  return moves;
}

function collectAttrOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
): Array<SetAttrOp | RemoveAttrOp> {
  const ops: Array<SetAttrOp | RemoveAttrOp> = [];

  function visit(nodeId: NodeId): void {
    if (context.replacementRoots.has(nodeId)) {
      return;
    }

    const baseNode = context.base.nodes.get(nodeId);
    const targetNode = context.target.nodes.get(nodeId);
    if (!baseNode || !targetNode) {
      return;
    }

    if (getSubtreeHash(context.base, nodeId) === getSubtreeHash(context.target, nodeId)) {
      return;
    }

    if (getNodeHash(context.base, nodeId) !== getNodeHash(context.target, nodeId)) {
      collectAttrOpsForNode(context, nodeId, "", baseNode.attrs, targetNode.attrs, ops);
    }

    const targetChildIds = new Set(targetNode.childIds);
    for (const childId of baseNode.childIds) {
      if (!targetChildIds.has(childId)) {
        continue;
      }
      visit(childId);
    }
  }

  visit(context.base.rootId);

  return ops.sort((left, right) => {
    if (left.nodeId !== right.nodeId) {
      return left.nodeId.localeCompare(right.nodeId);
    }
    return left.path.localeCompare(right.path);
  });
}

function collectReplacementOps<TTypes extends NodeTypeMap>(
  context: DiffContext<TTypes>,
): ReplaceSubtreeOp[] {
  return [...context.replacementRoots]
    .sort((left, right) => {
      const depthDiff = (context.target.index.depthById.get(left) ?? 0) - (context.target.index.depthById.get(right) ?? 0);
      return depthDiff === 0 ? left.localeCompare(right) : depthDiff;
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
      isCoveredByRoots(context.base, nodeId, new Set([replacementRootId]), false) &&
      !context.baseState.patchOwned.has(nodeId)
    );
  }

  function visitReplacementRoot(replacementRootId: NodeId): void {
    const replacementRoot = context.target.nodes.get(replacementRootId);
    if (!replacementRoot) {
      return;
    }

    function visit(nodeId: NodeId): void {
      const node = context.target.nodes.get(nodeId);
      if (!node) {
        return;
      }

      for (const childId of node.childIds) {
        const childOmitted = isOmittedSourceBackedDescendant(replacementRootId, childId);
        if (childOmitted) {
          const parentId = nodeId;
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
          continue;
        }

        visit(childId);
      }
    }

    visit(replacementRootId);
  }

  [...context.replacementRoots]
    .sort((left, right) => {
      const depthDiff = (context.target.index.depthById.get(left) ?? 0) - (context.target.index.depthById.get(right) ?? 0);
      return depthDiff === 0 ? left.localeCompare(right) : depthDiff;
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
    const coveredByReplacement = isCoveredByRoots(context.target, nodeId, context.replacementRoots, true);

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
      if (isCoveredByRoots(context.base, nodeId, context.replacementRoots, true)) {
        return false;
      }
      const parentId = context.base.index.parentById.get(nodeId);
      return !(parentId && !context.baseState.patchOwned.has(parentId) && !context.target.nodes.has(parentId));
    })
    .sort((left, right) => {
      const depthDiff = (context.base.index.depthById.get(left) ?? 0) - (context.base.index.depthById.get(right) ?? 0);
      return depthDiff === 0 ? left.localeCompare(right) : depthDiff;
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
      if (isCoveredByRoots(context.base, nodeId, context.replacementRoots, true)) {
        return false;
      }

      const parentId = context.base.index.parentById.get(nodeId);
      return !(parentId && context.baseState.patchOwned.has(parentId) && !context.target.nodes.has(parentId));
    })
    .sort((left, right) => {
      const depthDiff = (context.base.index.depthById.get(right) ?? 0) - (context.base.index.depthById.get(left) ?? 0);
      return depthDiff === 0 ? left.localeCompare(right) : depthDiff;
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

  const schemas = getCompiledSchemas(base, target, options);
  const targetPatchOwned = getEffectivePatchOwnedSet(base, target);
  const replacementRoots = collectReplacementRoots(base, target, options, schemas, targetPatchOwned);
  const context: DiffContext<TTypes> = {
    base,
    target,
    baseState: getTreeState(base),
    targetState: getTreeState(target),
    schemas,
    options,
    targetPatchOwned,
    replacementRoots,
    opIds: createOpIdFactory(),
  };

  const planning = buildPlanningState(base, target);
  const inserts = collectInsertOps(context, planning);
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
    ops: [...inserts, ...moves, ...attrOps, ...replacements, ...replacementInserts, ...visibility, ...removals],
  };
}

export function rebasePatch<TTypes extends NodeTypeMap>(
  _oldBase: IndexedTree<TTypes>,
  newBase: IndexedTree<TTypes>,
  patch: TreePatch,
  options: RebaseOptions = {},
): RebaseResult<TTypes> {
  const execution = executePatchInternal(newBase, patch, {
    mode: "preview",
    includeHidden: options.includeHidden ?? true,
    produceTree: true,
  });

  const rebasedPatch =
    execution.appliedOps.length > 0 || execution.conflicts.length === 0
      ? {
          format: "tree-patch/v1" as const,
          patchId: patch.patchId,
          ...(newBase.revision !== undefined ? { baseRevision: newBase.revision } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
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
