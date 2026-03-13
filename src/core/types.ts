export type NodeTypeMap = Record<string, unknown>;

export type NodeId = string;

type NodeTypeKey<TTypes extends NodeTypeMap> = Extract<keyof TTypes, string>;

type Primitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

type Terminal =
  | Primitive
  | Date
  | RegExp
  | Function
  | Map<unknown, unknown>
  | Set<unknown>;

type TuplePath<
  THead extends string | number,
  TTail extends readonly (string | number)[],
> = readonly [THead, ...TTail];

type DeepPathImpl<T, TDepth extends readonly unknown[]> = TDepth["length"] extends 5
  ? readonly []
  : T extends readonly (infer TItem)[]
    ? readonly [] | TuplePath<number, DeepPathImpl<NonNullable<TItem>, [...TDepth, 1]>>
    : T extends object
      ? T extends Terminal
        ? readonly []
        : readonly [] | {
            [K in Extract<keyof T, string>]-?: TuplePath<
              K,
              DeepPathImpl<NonNullable<T[K]>, [...TDepth, 1]>
            >;
          }[Extract<keyof T, string>]
      : readonly [];

type PropAt<T, TKey extends string | number> = T extends readonly (infer TItem)[]
  ? TKey extends number
    ? TItem
    : never
  : TKey extends keyof T
    ? T[TKey]
    : TKey extends string
      ? T extends Record<string, unknown>
        ? T[TKey & keyof T]
        : never
      : never;

export type DeepPath<T> = DeepPathImpl<NonNullable<T>, []>;

export type DeepValue<
  T,
  TPath extends readonly (string | number)[],
> = TPath extends readonly []
  ? T
  : TPath extends readonly [
        infer THead extends string | number,
        ...infer TTail extends readonly (string | number)[],
      ]
    ? DeepValue<NonNullable<PropAt<T, THead>>, TTail>
    : T;

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export interface EncodedValue {
  $codec: string;
  value: JsonValue;
}

export type PersistedValue = JsonValue | EncodedValue;

export interface ValueCodec<T = unknown> {
  codecId: string;
  serialize(value: T): JsonValue;
  deserialize(value: JsonValue): T;
}

export interface ValueAdapter<T = unknown> {
  equals(a: T, b: T): boolean;
  hash?(value: T): string;
  clone?(value: T): T;
  codec?: ValueCodec<T>;
}

export type JsonPointer = `/${string}` | "";

export type AttrPath<T> = DeepPath<T>;

export interface TreeNode<
  TTypes extends NodeTypeMap,
  TType extends NodeTypeKey<TTypes> = NodeTypeKey<TTypes>,
> {
  id: NodeId;
  type: TType;
  attrs: TTypes[TType];
  children: readonly AnyTreeNode<TTypes>[];
}

export type AnyTreeNode<TTypes extends NodeTypeMap> = {
  [K in NodeTypeKey<TTypes>]: TreeNode<TTypes, K>;
}[NodeTypeKey<TTypes>];

export interface TreeDocument<TTypes extends NodeTypeMap> {
  root: AnyTreeNode<TTypes>;
  revision?: string;
  metadata?: Record<string, unknown>;
}

export interface NodeRuntimeSpec<TAttrs> {
  atomicPaths?: readonly AttrPath<TAttrs>[];
  adapters?: Partial<Record<JsonPointer, ValueAdapter<unknown>>>;
}

export interface TreeSchema<TTypes extends NodeTypeMap> {
  types: {
    [K in NodeTypeKey<TTypes>]?: NodeRuntimeSpec<TTypes[K]>;
  };
}

export interface TreeIndex {
  parentById: ReadonlyMap<NodeId, NodeId | null>;
  positionById: ReadonlyMap<NodeId, number>;
  depthById: ReadonlyMap<NodeId, number>;
}

export interface TreeCache {
  nodeHashById: ReadonlyMap<NodeId, string>;
  subtreeHashById: ReadonlyMap<NodeId, string>;
  pathHashByNodeId: ReadonlyMap<NodeId, ReadonlyMap<JsonPointer, string>>;
}

export interface IndexedNode<
  TTypes extends NodeTypeMap,
  TType extends NodeTypeKey<TTypes> = NodeTypeKey<TTypes>,
> {
  id: NodeId;
  type: TType;
  attrs: TTypes[TType];
  childIds: readonly NodeId[];
}

export interface IndexedTree<TTypes extends NodeTypeMap> {
  rootId: NodeId;
  nodes: ReadonlyMap<NodeId, IndexedNode<TTypes>>;
  revision?: string;
  metadata?: Record<string, unknown>;
  index: TreeIndex;
  cache: TreeCache;
}

export interface SerializedPatchNode {
  id: NodeId;
  type: string;
  attrs: PersistedValue;
  children: readonly SerializedPatchNode[];
}

export type ChildPosition =
  | { beforeId: NodeId }
  | { afterId: NodeId }
  | { atStart: true }
  | { atEnd: true };

export type Guard =
  | { kind: "nodeExists"; nodeId: NodeId }
  | { kind: "nodeAbsent"; nodeId: NodeId }
  | { kind: "nodeTypeIs"; nodeId: NodeId; nodeType: string }
  | { kind: "attrEquals"; nodeId: NodeId; path: JsonPointer; value: PersistedValue }
  | { kind: "attrHash"; nodeId: NodeId; path: JsonPointer; hash: string }
  | { kind: "subtreeHash"; nodeId: NodeId; hash: string }
  | { kind: "parentIs"; nodeId: NodeId; parentId: NodeId | null }
  | { kind: "positionAfter"; nodeId: NodeId; afterId: NodeId }
  | { kind: "positionBefore"; nodeId: NodeId; beforeId: NodeId };

export interface SetAttrOp {
  kind: "setAttr";
  opId: string;
  nodeId: NodeId;
  path: JsonPointer;
  value: PersistedValue;
  guards?: readonly Guard[];
}

export interface RemoveAttrOp {
  kind: "removeAttr";
  opId: string;
  nodeId: NodeId;
  path: JsonPointer;
  guards?: readonly Guard[];
}

export interface HideNodeOp {
  kind: "hideNode";
  opId: string;
  nodeId: NodeId;
  guards?: readonly Guard[];
}

export interface ShowNodeOp {
  kind: "showNode";
  opId: string;
  nodeId: NodeId;
  guards?: readonly Guard[];
}

export interface InsertNodeOp {
  kind: "insertNode";
  opId: string;
  parentId: NodeId;
  position?: ChildPosition;
  node: SerializedPatchNode;
  guards?: readonly Guard[];
}

export interface MoveNodeOp {
  kind: "moveNode";
  opId: string;
  nodeId: NodeId;
  newParentId: NodeId;
  position?: ChildPosition;
  guards?: readonly Guard[];
}

export interface ReplaceSubtreeOp {
  kind: "replaceSubtree";
  opId: string;
  nodeId: NodeId;
  node: SerializedPatchNode;
  guards?: readonly Guard[];
}

export interface RemoveNodeOp {
  kind: "removeNode";
  opId: string;
  nodeId: NodeId;
  guards?: readonly Guard[];
}

export type PatchOp =
  | SetAttrOp
  | RemoveAttrOp
  | HideNodeOp
  | ShowNodeOp
  | InsertNodeOp
  | MoveNodeOp
  | ReplaceSubtreeOp
  | RemoveNodeOp;

export interface TreePatch {
  format: "tree-patch/v1";
  patchId: string;
  baseRevision?: string;
  metadata?: Record<string, unknown>;
  ops: readonly PatchOp[];
}

export interface PatchConflict {
  opId: string;
  kind:
    | "NodeMissing"
    | "NodeAlreadyExists"
    | "TypeMismatch"
    | "GuardFailed"
    | "AnchorMissing"
    | "ParentMismatch"
    | "IllegalOperation"
    | "PathInvalid";
  nodeId?: NodeId;
  path?: JsonPointer;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export interface CreateDocumentOptions<TTypes extends NodeTypeMap> {
  schema?: TreeSchema<TTypes>;
  ownership?: "clone" | "assumeImmutable";
}

export interface ValidateOptions {
  mode?: "atomic" | "preview";
}

export interface ApplyOptions extends ValidateOptions {
  includeHidden?: boolean;
}

export interface MaterializeOptions extends ApplyOptions {}

export interface RebaseOptions extends ApplyOptions {}

export interface DiffOptions<TTypes extends NodeTypeMap> {
  replaceSubtreeWhen?: {
    changedAttrCountGte?: number;
    changedChildCountGte?: number;
    subtreeChangeRatioGte?: number;
  };
  hideMissingSourceNodes?: boolean;
  unsupportedTransformPolicy?: "replaceSubtree" | "error";
  schema?: TreeSchema<TTypes>;
}

export interface ConflictResolutionOptions<TTypes extends NodeTypeMap> {
  includeHidden?: boolean;
  diff?: DiffOptions<TTypes>;
}

export type ConflictResolutionDecision = "takeBase" | "keepLocal";

export interface RevisionStatus {
  status: "match" | "mismatch" | "unknown";
  sourceRevision?: string;
  patchBaseRevision?: string;
}

export type ValidationResult =
  | {
      status: "valid";
      revision: RevisionStatus;
    }
  | {
      status: "conflict";
      revision: RevisionStatus;
      conflicts: readonly PatchConflict[];
    };

export interface MaterializedNodeState {
  hidden?: boolean;
  patchOwned?: boolean;
  explicitlyHidden?: boolean;
}

export interface MaterializedNode<
  TTypes extends NodeTypeMap,
  TType extends NodeTypeKey<TTypes> = NodeTypeKey<TTypes>,
> {
  id: NodeId;
  type: TType;
  attrs: TTypes[TType];
  children: readonly AnyMaterializedNode<TTypes>[];
  state?: MaterializedNodeState;
}

export type AnyMaterializedNode<TTypes extends NodeTypeMap> = {
  [K in NodeTypeKey<TTypes>]: MaterializedNode<TTypes, K>;
}[NodeTypeKey<TTypes>];

export type ApplyResult<TTypes extends NodeTypeMap> =
  | {
      status: "applied";
      revision: RevisionStatus;
      tree: IndexedTree<TTypes>;
      materialized: MaterializedNode<TTypes>;
    }
  | {
      status: "preview";
      revision: RevisionStatus;
      tree: IndexedTree<TTypes>;
      materialized: MaterializedNode<TTypes>;
      conflicts: readonly PatchConflict[];
    }
  | {
      status: "conflict";
      revision: RevisionStatus;
      conflicts: readonly PatchConflict[];
    };

export type MaterializeResult<TTypes extends NodeTypeMap> = ApplyResult<TTypes>;

export interface RebaseResult<TTypes extends NodeTypeMap> {
  revision: RevisionStatus;
  rebasedPatch?: TreePatch;
  conflicts: readonly PatchConflict[];
  appliedOpIds: readonly string[];
  skippedOpIds: readonly string[];
  preview?: IndexedTree<TTypes>;
}

export type ResolutionBuildResult<TTypes extends NodeTypeMap> =
  | {
      status: "resolved";
      resolvedPatch: TreePatch;
      preview: IndexedTree<TTypes>;
      appliedOpIds: readonly string[];
      skippedOpIds: readonly string[];
    }
  | {
      status: "unresolved";
      preview: IndexedTree<TTypes>;
      conflicts: readonly PatchConflict[];
      unresolvedConflicts: readonly PatchConflict[];
      replayConflicts: readonly PatchConflict[];
      appliedOpIds: readonly string[];
      skippedOpIds: readonly string[];
    };

export interface ConflictResolutionSession<TTypes extends NodeTypeMap> {
  readonly initialRebase: RebaseResult<TTypes>;
  readonly preview: IndexedTree<TTypes>;
  readonly conflicts: readonly PatchConflict[];
  readonly unresolvedConflicts: readonly PatchConflict[];
  readonly replayConflicts: readonly PatchConflict[];
  readonly appliedOpIds: readonly string[];
  readonly skippedOpIds: readonly string[];
  getDecision(opId: string): ConflictResolutionDecision | undefined;
  takeBase(opId: string): this;
  keepLocal(opId: string): this;
  reset(opId: string): this;
  takeBaseAll(): this;
  keepLocalAll(): this;
  build(): ResolutionBuildResult<TTypes>;
}
