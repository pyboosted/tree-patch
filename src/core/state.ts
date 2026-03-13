import type {
  IndexedNode,
  IndexedTree,
  JsonPointer,
  NodeId,
  NodeTypeMap,
} from "./types.js";
import type { MutableMapLike, MutableSetLike } from "./cow.js";
import type { CompiledTreeSchema } from "../schema/schema.js";

export interface MutableTreeCache {
  nodeHashById: MutableMapLike<NodeId, string>;
  subtreeHashById: MutableMapLike<NodeId, string>;
  pathHashByNodeId: MutableMapLike<NodeId, MutableMapLike<JsonPointer, string>>;
}

export interface MutableTreeState<TTypes extends NodeTypeMap> {
  ownership: "clone" | "assumeImmutable";
  schema: CompiledTreeSchema<TTypes>;
  nodes: MutableMapLike<NodeId, IndexedNode<TTypes>>;
  index: {
    parentById: MutableMapLike<NodeId, NodeId | null>;
    positionById: MutableMapLike<NodeId, number>;
    depthById: MutableMapLike<NodeId, number>;
  };
  cache: MutableTreeCache;
  explicitHidden: MutableSetLike<NodeId>;
  patchOwned: MutableSetLike<NodeId>;
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
