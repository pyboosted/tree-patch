import type {
  IndexedNode,
  IndexedTree,
  JsonPointer,
  NodeId,
  NodeTypeMap,
} from "./types.js";
import type { CompiledTreeSchema } from "../schema/schema.js";

export interface MutableTreeCache {
  nodeHashById: Map<NodeId, string>;
  subtreeHashById: Map<NodeId, string>;
  pathHashByNodeId: Map<NodeId, Map<JsonPointer, string>>;
}

export interface MutableTreeState<TTypes extends NodeTypeMap> {
  ownership: "clone" | "assumeImmutable";
  schema: CompiledTreeSchema<TTypes>;
  nodes: Map<NodeId, IndexedNode<TTypes>>;
  index: {
    parentById: Map<NodeId, NodeId | null>;
    positionById: Map<NodeId, number>;
    depthById: Map<NodeId, number>;
  };
  cache: MutableTreeCache;
  explicitHidden: Set<NodeId>;
  patchOwned: Set<NodeId>;
}

const TREE_STATE = new WeakMap<object, MutableTreeState<NodeTypeMap>>();

export function attachTreeState<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
  state: MutableTreeState<TTypes>,
): void {
  TREE_STATE.set(tree as object, state as MutableTreeState<NodeTypeMap>);
}

export function getTreeState<TTypes extends NodeTypeMap>(
  tree: IndexedTree<TTypes>,
): MutableTreeState<TTypes> {
  const state = TREE_STATE.get(tree as object);
  if (!state) {
    throw new Error("IndexedTree internal state is missing.");
  }

  return state as MutableTreeState<TTypes>;
}
