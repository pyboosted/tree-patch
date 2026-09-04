import type {
  IndexedNode,
  IndexedTree,
  JsonPointer,
  NodeId,
  NodeTypeMap,
} from "./types.js";
import type { MutableMapLike, MutableSetLike } from "./cow.js";
import type { CompiledTreeSchema } from "../schema/schema.js";
import type { ChildHashAggregate } from "./child-hash.js";

/**
 * One record per node: the indexed node plus its structural index. Keeping
 * these together means one map write per node when building a snapshot and
 * one lookup when a caller needs several of them.
 */
export interface NodeEntry<TTypes extends NodeTypeMap> {
  node: IndexedNode<TTypes>;
  parentId: NodeId | null;
  position: number;
  depth: number;
  /** The state layer that created this entry and may update it in place. */
  owner: object | null;
}

export interface MutableTreeCache {
  nodeHashById: MutableMapLike<NodeId, string>;
  subtreeHashById: MutableMapLike<NodeId, string>;
  pathHashByNodeId: MutableMapLike<NodeId, MutableMapLike<JsonPointer, string>>;
  childHashByParentId: MutableMapLike<NodeId, ChildHashAggregate>;
}

export interface TreeEntryHost<TTypes extends NodeTypeMap> {
  entries: MutableMapLike<NodeId, NodeEntry<TTypes>>;
  /**
   * Identity stamped on entries this layer creates. `null` for immutable
   * snapshots: every write must copy the entry first.
   */
  entryOwner: object | null;
}

export interface MutableTreeState<TTypes extends NodeTypeMap>
  extends TreeEntryHost<TTypes> {
  ownership: "clone" | "assumeImmutable";
  schema: CompiledTreeSchema<TTypes>;
  /** Field views over `entries`; they share the map-like contract. */
  readonly nodes: MutableMapLike<NodeId, IndexedNode<TTypes>>;
  readonly index: {
    readonly parentById: MutableMapLike<NodeId, NodeId | null>;
    readonly positionById: MutableMapLike<NodeId, number>;
    readonly depthById: MutableMapLike<NodeId, number>;
  };
  cache: MutableTreeCache;
  explicitHidden: MutableSetLike<NodeId>;
  patchOwned: MutableSetLike<NodeId>;
}

/**
 * Map-like views over `entries`. Each field gets its own class so every call
 * site stays monomorphic; shared iteration lives in the base class.
 */
abstract class NodeEntryView<TTypes extends NodeTypeMap, TValue>
  implements MutableMapLike<NodeId, TValue>
{
  constructor(protected readonly host: TreeEntryHost<TTypes>) {}

  protected abstract read(entry: NodeEntry<TTypes>): TValue;

  abstract get(key: NodeId): TValue | undefined;
  abstract set(key: NodeId, value: TValue): this;

  get size(): number {
    return this.host.entries.size;
  }

  has(key: NodeId): boolean {
    return this.host.entries.has(key);
  }

  delete(key: NodeId): boolean {
    throw new Error("Node index fields cannot be deleted independently.");
  }

  clear(): void {
    throw new Error("Node index fields cannot be cleared independently.");
  }

  forEach(
    callbackfn: (value: TValue, key: NodeId, map: ReadonlyMap<NodeId, TValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, entry] of this.host.entries) {
      callbackfn.call(thisArg, this.read(entry), key, this);
    }
  }

  *entries(): MapIterator<[NodeId, TValue]> {
    for (const [key, entry] of this.host.entries) {
      yield [key, this.read(entry)];
    }
  }

  keys(): MapIterator<NodeId> {
    return this.host.entries.keys();
  }

  *values(): MapIterator<TValue> {
    for (const entry of this.host.entries.values()) {
      yield this.read(entry);
    }
  }

  [Symbol.iterator](): MapIterator<[NodeId, TValue]> {
    return this.entries();
  }

  readonly [Symbol.toStringTag] = "Map";
}

class NodesView<TTypes extends NodeTypeMap>
  extends NodeEntryView<TTypes, IndexedNode<TTypes>>
{
  protected read(entry: NodeEntry<TTypes>): IndexedNode<TTypes> {
    return entry.node;
  }

  get(key: NodeId): IndexedNode<TTypes> | undefined {
    const entry = this.host.entries.get(key);
    return entry === undefined ? undefined : entry.node;
  }

  set(key: NodeId, node: IndexedNode<TTypes>): this {
    const entry = this.host.entries.get(key);
    if (entry === undefined) {
      this.host.entries.set(key, {
        node,
        parentId: null,
        position: 0,
        depth: 0,
        owner: this.host.entryOwner,
      });
    } else {
      ensureOwnedEntry(this.host, entry).node = node;
    }
    return this;
  }

  override delete(key: NodeId): boolean {
    return this.host.entries.delete(key);
  }

  override clear(): void {
    this.host.entries.clear();
  }
}

class ParentIdView<TTypes extends NodeTypeMap>
  extends NodeEntryView<TTypes, NodeId | null>
{
  protected read(entry: NodeEntry<TTypes>): NodeId | null {
    return entry.parentId;
  }

  get(key: NodeId): NodeId | null | undefined {
    const entry = this.host.entries.get(key);
    return entry === undefined ? undefined : entry.parentId;
  }

  set(key: NodeId, parentId: NodeId | null): this {
    ensureOwnedEntry(this.host, requireEntry(this.host, key)).parentId = parentId;
    return this;
  }
}

class PositionView<TTypes extends NodeTypeMap>
  extends NodeEntryView<TTypes, number>
{
  protected read(entry: NodeEntry<TTypes>): number {
    return entry.position;
  }

  get(key: NodeId): number | undefined {
    const entry = this.host.entries.get(key);
    return entry === undefined ? undefined : entry.position;
  }

  set(key: NodeId, position: number): this {
    ensureOwnedEntry(this.host, requireEntry(this.host, key)).position = position;
    return this;
  }
}

class DepthView<TTypes extends NodeTypeMap>
  extends NodeEntryView<TTypes, number>
{
  protected read(entry: NodeEntry<TTypes>): number {
    return entry.depth;
  }

  get(key: NodeId): number | undefined {
    const entry = this.host.entries.get(key);
    return entry === undefined ? undefined : entry.depth;
  }

  set(key: NodeId, depth: number): this {
    ensureOwnedEntry(this.host, requireEntry(this.host, key)).depth = depth;
    return this;
  }
}

function requireEntry<TTypes extends NodeTypeMap>(
  host: TreeEntryHost<TTypes>,
  nodeId: NodeId,
): NodeEntry<TTypes> {
  const entry = host.entries.get(nodeId);
  if (entry === undefined) {
    throw new Error(`Cannot index unknown node "${nodeId}".`);
  }
  return entry;
}

export interface TreeStateInit<TTypes extends NodeTypeMap> {
  ownership: "clone" | "assumeImmutable";
  schema: CompiledTreeSchema<TTypes>;
  entries: MutableMapLike<NodeId, NodeEntry<TTypes>>;
  entryOwner: object | null;
  cache: MutableTreeCache;
  explicitHidden: MutableSetLike<NodeId>;
  patchOwned: MutableSetLike<NodeId>;
}

export function createTreeState<TTypes extends NodeTypeMap>(
  init: TreeStateInit<TTypes>,
): MutableTreeState<TTypes> {
  const state = {
    ownership: init.ownership,
    schema: init.schema,
    entries: init.entries,
    entryOwner: init.entryOwner,
    cache: init.cache,
    explicitHidden: init.explicitHidden,
    patchOwned: init.patchOwned,
  } as MutableTreeState<TTypes>;
  const mutable = state as {
    nodes: MutableTreeState<TTypes>["nodes"];
    index: MutableTreeState<TTypes>["index"];
  };
  mutable.nodes = new NodesView(state);
  mutable.index = {
    parentById: new ParentIdView(state),
    positionById: new PositionView(state),
    depthById: new DepthView(state),
  };
  return state;
}

/** Writes a complete entry in one map operation. */
export function setNodeEntry<TTypes extends NodeTypeMap>(
  state: TreeEntryHost<TTypes>,
  node: IndexedNode<TTypes>,
  parentId: NodeId | null,
  position: number,
  depth: number,
): void {
  state.entries.set(node.id, {
    node,
    parentId,
    position,
    depth,
    owner: state.entryOwner,
  });
}

export function getNodeEntry<TTypes extends NodeTypeMap>(
  state: TreeEntryHost<TTypes>,
  nodeId: NodeId,
): NodeEntry<TTypes> | undefined {
  return state.entries.get(nodeId);
}

/**
 * Returns an entry this layer may mutate in place, copying it into the layer
 * first when it still belongs to an underlying snapshot.
 */
export function ensureOwnedEntry<TTypes extends NodeTypeMap>(
  state: TreeEntryHost<TTypes>,
  entry: NodeEntry<TTypes>,
): NodeEntry<TTypes> {
  const owner = state.entryOwner;
  if (owner !== null && entry.owner === owner) {
    return entry;
  }
  const next: NodeEntry<TTypes> = {
    node: entry.node,
    parentId: entry.parentId,
    position: entry.position,
    depth: entry.depth,
    owner,
  };
  state.entries.set(entry.node.id, next);
  return next;
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
