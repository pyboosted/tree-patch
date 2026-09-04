import type {
  IndexedNode,
  IndexedTree,
  JsonObject,
  NodeId,
  NodeTypeMap,
} from "./types.js";
import {
  createCopyOnWriteMap,
  createCopyOnWriteSet,
} from "./cow.js";
import { attachTreeState, getTreeState, type MutableTreeState } from "./state.js";

export interface OverlayState<TTypes extends NodeTypeMap> extends MutableTreeState<TTypes> {
  readonly rootId: NodeId;
  readonly metadata?: Readonly<JsonObject>;
  treeView: IndexedTree<TTypes>;
  readonly dirtyNodeIds: Set<NodeId>;
  readonly dirtyPathHashNodeIds: Set<NodeId>;
  readonly dirtySubtreeNodeIds: Set<NodeId>;
}

export function createOverlayState<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
): OverlayState<TTypes> {
  const sourceState = getTreeState(source);
  const state = {
    ownership: sourceState.ownership,
    schema: sourceState.schema,
    nodes: createCopyOnWriteMap(sourceState.nodes),
    index: {
      parentById: createCopyOnWriteMap(sourceState.index.parentById),
      positionById: createCopyOnWriteMap(sourceState.index.positionById),
      depthById: createCopyOnWriteMap(sourceState.index.depthById),
    },
    cache: {
      nodeHashById: createCopyOnWriteMap(sourceState.cache.nodeHashById),
      subtreeHashById: createCopyOnWriteMap(sourceState.cache.subtreeHashById),
      pathHashByNodeId: createCopyOnWriteMap(sourceState.cache.pathHashByNodeId),
      childHashByParentId: createCopyOnWriteMap(
        sourceState.cache.childHashByParentId,
      ),
    } as MutableTreeState<TTypes>["cache"],
    explicitHidden: createCopyOnWriteSet(sourceState.explicitHidden),
    patchOwned: createCopyOnWriteSet(sourceState.patchOwned),
    rootId: source.rootId,
    metadata: source.metadata,
    treeView: undefined as unknown as IndexedTree<TTypes>,
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
    ...(source.metadata !== undefined ? { metadata: source.metadata } : {}),
  } as IndexedTree<TTypes>;
  // Forward the source revision lazily: deriving it hashes the whole tree.
  Object.defineProperty(treeView, "revision", {
    enumerable: true,
    get: () => source.revision,
  });

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
    const alreadyDirty = overlay.dirtySubtreeNodeIds.has(current);
    overlay.cache.subtreeHashById.delete(current);
    overlay.dirtySubtreeNodeIds.add(current);
    if (alreadyDirty) {
      break;
    }
    current = overlay.index.parentById.get(current);
  }
}

export function invalidateSubtreeHashes<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
): void {
  let current: NodeId | null | undefined = nodeId;
  while (current != null) {
    const alreadyDirty = overlay.dirtySubtreeNodeIds.has(current);
    overlay.cache.subtreeHashById.delete(current);
    overlay.dirtySubtreeNodeIds.add(current);
    if (alreadyDirty) {
      break;
    }
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

export function reindexSubtreeDepths<TTypes extends NodeTypeMap>(
  overlay: OverlayState<TTypes>,
  nodeId: NodeId,
  depth: number,
  getChildIds: (
    nodeId: NodeId,
    node: IndexedNode<TTypes>,
  ) => readonly NodeId[] = (_currentId, node) => node.childIds,
): void {
  const stack: Array<{ nodeId: NodeId; depth: number }> = [{ nodeId, depth }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    overlay.index.depthById.set(current.nodeId, current.depth);
    const node = overlay.nodes.get(current.nodeId);
    if (!node) {
      continue;
    }
    const childIds = getChildIds(current.nodeId, node);
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      stack.push({
        nodeId: childIds[index]!,
        depth: current.depth + 1,
      });
    }
  }
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
  overlay.cache.childHashByParentId.delete(nodeId);
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
