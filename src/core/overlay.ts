import type {
  ChildPosition,
  IndexedNode,
  IndexedTree,
  JsonPointer,
  NodeId,
  NodeTypeMap,
  PatchConflict,
} from "./types.js";
import { attachTreeState, getTreeState, type MutableTreeState } from "./state.js";

export interface OverlayState<TTypes extends NodeTypeMap> extends MutableTreeState<TTypes> {
  readonly rootId: NodeId;
  readonly metadata?: Record<string, unknown>;
  treeView: IndexedTree<TTypes>;
  readonly dirtyNodeIds: Set<NodeId>;
  readonly dirtyPathHashNodeIds: Set<NodeId>;
  readonly dirtySubtreeNodeIds: Set<NodeId>;
}

function cloneCache(
  cache: MutableTreeState<NodeTypeMap>["cache"],
): MutableTreeState<NodeTypeMap>["cache"] {
  return {
    nodeHashById: new Map(cache.nodeHashById),
    subtreeHashById: new Map(cache.subtreeHashById),
    pathHashByNodeId: new Map(
      [...cache.pathHashByNodeId].map(([nodeId, hashes]) => [nodeId, new Map(hashes)]),
    ),
  };
}

export function createOverlayState<TTypes extends NodeTypeMap>(
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

export function invalidateNodeCaches<TTypes extends NodeTypeMap>(
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

export function invalidateSubtreeHashes<TTypes extends NodeTypeMap>(
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

export function getNode<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
): IndexedNode<TTypes> | undefined {
  return overlay.nodes.get(nodeId);
}

export function setNode<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  node: IndexedNode<TTypes>,
): void {
  overlay.nodes.set(node.id, node);
}

export function getParentChildIds<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  parentId: NodeId,
): readonly NodeId[] {
  const parent = overlay.nodes.get(parentId);
  return parent?.childIds ?? [];
}

export function updateSiblingPositions<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  parentId: NodeId,
): void {
  const childIds = getParentChildIds(overlay, parentId);
  childIds.forEach((childId, index) => {
    overlay.index.positionById.set(childId, index);
  });
}

export function resolvePositionAgainstChildIds(
  childIds: readonly NodeId[],
  position: ChildPosition | undefined,
  opId: string,
  parentId: NodeId,
  toConflict: (
    opId: string,
    kind: PatchConflict["kind"],
    message: string,
    extras?: Omit<PatchConflict, "opId" | "kind" | "message">,
  ) => PatchConflict,
): { ok: true; index: number } | { ok: false; conflict: PatchConflict } {
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

export function collectSubtreeNodeIds<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
  collected: NodeId[] = [],
): NodeId[] {
  const node = overlay.nodes.get(nodeId);
  if (!node) {
    return collected;
  }

  collected.push(nodeId);
  node.childIds.forEach((childId) => {
    collectSubtreeNodeIds(overlay, childId, collected);
  });
  return collected;
}

export function reindexSubtreeDepths<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
  depth: number,
): void {
  overlay.index.depthById.set(nodeId, depth);
  const node = overlay.nodes.get(nodeId);
  if (!node) {
    return;
  }

  node.childIds.forEach((childId) => {
    reindexSubtreeDepths(overlay, childId, depth + 1);
  });
}

function clearNodeState<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
): void {
  overlay.nodes.delete(nodeId);
  overlay.index.parentById.delete(nodeId);
  overlay.index.positionById.delete(nodeId);
  overlay.index.depthById.delete(nodeId);
  overlay.cache.nodeHashById.delete(nodeId);
  overlay.cache.subtreeHashById.delete(nodeId);
  overlay.cache.pathHashByNodeId.delete(nodeId);
  overlay.explicitHidden.delete(nodeId);
  overlay.patchOwned.delete(nodeId);
  overlay.dirtyNodeIds.delete(nodeId);
  overlay.dirtyPathHashNodeIds.delete(nodeId);
  overlay.dirtySubtreeNodeIds.delete(nodeId);
}

export function clearSubtreeState<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeIds: readonly NodeId[],
): void {
  nodeIds.forEach((nodeId) => {
    clearNodeState(overlay, nodeId);
  });
}
