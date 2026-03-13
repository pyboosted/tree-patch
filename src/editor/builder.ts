import type {
  AnyTreeNode,
  AttrPath,
  ChildPosition,
  DeepValue,
  Guard,
  IndexedTree,
  JsonPointer,
  NodeId,
  NodeTypeMap,
  PatchOp,
  SerializedPatchNode,
  TreePatch,
  TreeSchema,
} from "../core/types.js";
import {
  createPatchExecutionSession,
  applyOperationInSession,
  type PatchExecutionSession,
} from "../core/apply.js";
import {
  EditorNodeMissingError,
  EditorNodeTypeMismatchError,
  MalformedPatchError,
  MissingPatchIdError,
} from "../core/errors.js";
import { getPathHash, getSubtreeHash } from "../core/hash.js";
import { assertPatchEnvelope, normalizePosition } from "../core/patch-validation.js";
import { isPlainObject } from "../core/snapshot.js";
import { getTreeState } from "../core/state.js";
import { deepEqual } from "../schema/adapters.js";
import { pathToPointer, resolvePointer } from "../schema/pointers.js";
import type { CompiledTreeSchema } from "../schema/schema.js";
import { compileTreeSchema } from "../schema/schema.js";
import {
  type CompiledSchemas,
  encodeRuntimeValueForPointer,
  getValueAdapterForSchemas,
  isAtomicForSchemas,
} from "../schema/runtime-values.js";

type NodeTypeKey<TTypes extends NodeTypeMap> = Extract<keyof TTypes, string>;

export interface PatchBuilderFieldOptions<TValue> {
  expect?: TValue;
}

export interface PatchBuilderOptions<TTypes extends NodeTypeMap> {
  schema?: TreeSchema<TTypes>;
  source?: IndexedTree<TTypes>;
  patchId?: string;
  baseRevision?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateEditorOptions<TTypes extends NodeTypeMap> {
  schema?: TreeSchema<TTypes>;
  patchId?: string;
  baseRevision?: string;
  metadata?: Record<string, unknown>;
}

type PatchBuilderChainMethods<TTypes extends NodeTypeMap> = Pick<
  PatchBuilder<TTypes>,
  | "patchId"
  | "baseRevision"
  | "metadata"
  | "node"
  | "hideNode"
  | "showNode"
  | "insertNode"
  | "moveNode"
  | "replaceSubtree"
  | "removeNode"
  | "build"
>;

export interface NodeEditor<
  TTypes extends NodeTypeMap,
  TType extends NodeTypeKey<TTypes>,
> extends PatchBuilderChainMethods<TTypes> {
  set<TPath extends AttrPath<TTypes[TType]>>(
    path: TPath,
    value: DeepValue<TTypes[TType], TPath>,
    options?: PatchBuilderFieldOptions<DeepValue<TTypes[TType], TPath>>,
  ): NodeEditor<TTypes, TType>;
  remove<TPath extends AttrPath<TTypes[TType]>>(
    path: TPath,
    options?: PatchBuilderFieldOptions<DeepValue<TTypes[TType], TPath>>,
  ): NodeEditor<TTypes, TType>;
  hide(): NodeEditor<TTypes, TType>;
  show(): NodeEditor<TTypes, TType>;
  insert<TChildType extends NodeTypeKey<TTypes>>(
    node: AnyTreeNode<TTypes> & { type: TChildType },
    position?: ChildPosition,
  ): NodeEditor<TTypes, TType>;
  move(newParentId: NodeId, position?: ChildPosition): NodeEditor<TTypes, TType>;
  replace(node: AnyTreeNode<TTypes>): NodeEditor<TTypes, TType>;
  removeNode(): NodeEditor<TTypes, TType>;
}

export interface PatchBuilder<TTypes extends NodeTypeMap> {
  patchId(patchId: string): PatchBuilder<TTypes>;
  baseRevision(baseRevision?: string): PatchBuilder<TTypes>;
  metadata(metadata?: Record<string, unknown>): PatchBuilder<TTypes>;
  node<TType extends NodeTypeKey<TTypes>>(
    nodeId: NodeId,
    claimedType: TType,
  ): NodeEditor<TTypes, TType>;
  hideNode(nodeId: NodeId): PatchBuilder<TTypes>;
  showNode(nodeId: NodeId): PatchBuilder<TTypes>;
  insertNode<TType extends NodeTypeKey<TTypes>>(
    parentId: NodeId,
    node: AnyTreeNode<TTypes> & { type: TType },
    position?: ChildPosition,
  ): PatchBuilder<TTypes>;
  moveNode(
    nodeId: NodeId,
    newParentId: NodeId,
    position?: ChildPosition,
  ): PatchBuilder<TTypes>;
  replaceSubtree(
    nodeId: NodeId,
    node: AnyTreeNode<TTypes>,
  ): PatchBuilder<TTypes>;
  removeNode(nodeId: NodeId): PatchBuilder<TTypes>;
  build(): TreePatch;
}

export interface TreeEditor<TTypes extends NodeTypeMap> extends PatchBuilder<TTypes> {}

function createOpIdFactory() {
  const counters = new Map<string, number>();

  return (prefix: string, nodeId: string, pointer?: JsonPointer): string => {
    const base = pointer ? `${prefix}:${nodeId}:${pointer}` : `${prefix}:${nodeId}`;
    const count = counters.get(base) ?? 0;
    counters.set(base, count + 1);
    return count === 0 ? base : `${base}:${count + 1}`;
  };
}

function cloneMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  return { ...metadata };
}

function getCompiledSchemas<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes> | undefined,
  schema: TreeSchema<TTypes> | undefined,
): CompiledSchemas<TTypes> {
  const schemas: CompiledTreeSchema<TTypes>[] = [];
  if (schema) {
    schemas.push(compileTreeSchema(schema));
  }

  if (source) {
    const sourceSchema = getTreeState(source).schema;
    if (!schemas.includes(sourceSchema)) {
      schemas.push(sourceSchema);
    }
  }

  return schemas;
}

function shouldPreferHash<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string | undefined,
  pointer: JsonPointer,
  value: unknown,
): boolean {
  if (!nodeType) {
    return false;
  }

  return (
    getValueAdapterForSchemas(schemas, nodeType, pointer) !== undefined ||
    isAtomicForSchemas(schemas, nodeType, pointer) ||
    Array.isArray(value) ||
    isPlainObject(value)
  );
}

function serializeNodeSubtree<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  node: AnyTreeNode<TTypes>,
  seenIds: Set<string>,
): SerializedPatchNode {
  if (seenIds.has(node.id)) {
    throw new MalformedPatchError(`Serialized patch subtree reuses node id "${node.id}".`, {
      details: { nodeId: node.id },
    });
  }

  seenIds.add(node.id);
  return {
    id: node.id,
    type: String(node.type),
    attrs: encodeRuntimeValueForPointer(schemas, String(node.type), "", node.attrs),
    children: node.children.map((child) => serializeNodeSubtree(schemas, child, seenIds)),
  };
}

function createAnchorGuards(
  parentId: NodeId,
  position: ChildPosition | undefined,
): Guard[] {
  const guards: Guard[] = [];
  if (!position) {
    return guards;
  }

  if ("afterId" in position) {
    guards.push({ kind: "nodeExists", nodeId: position.afterId });
    guards.push({ kind: "parentIs", nodeId: position.afterId, parentId });
  }

  if ("beforeId" in position) {
    guards.push({ kind: "nodeExists", nodeId: position.beforeId });
    guards.push({ kind: "parentIs", nodeId: position.beforeId, parentId });
  }

  return guards;
}

class PatchBuilderController<TTypes extends NodeTypeMap> {
  private readonly schemas: CompiledSchemas<TTypes>;
  private readonly validationSession: PatchExecutionSession<TTypes> | undefined;
  private readonly currentTree: IndexedTree<TTypes> | undefined;
  private patchIdValue: string | undefined;
  private baseRevisionValue: string | undefined;
  private metadataValue: Record<string, unknown> | undefined;
  private readonly ops: PatchOp[] = [];
  private readonly opIds = createOpIdFactory();

  constructor(options: PatchBuilderOptions<TTypes>) {
    this.schemas = getCompiledSchemas(options.source, options.schema);
    this.validationSession = options.source
      ? createPatchExecutionSession(options.source)
      : undefined;
    this.currentTree = this.validationSession?.tree ?? options.source;
    this.patchIdValue = options.patchId;
    this.baseRevisionValue = options.baseRevision ?? options.source?.revision;
    this.metadataValue = cloneMetadata(options.metadata);
  }

  setPatchId(patchId: string): void {
    this.patchIdValue = patchId;
  }

  setBaseRevision(baseRevision?: string): void {
    this.baseRevisionValue = baseRevision;
  }

  setMetadata(metadata?: Record<string, unknown>): void {
    this.metadataValue = cloneMetadata(metadata);
  }

  private getNode(nodeId: NodeId) {
    return this.currentTree?.nodes.get(nodeId);
  }

  ensureNodeHandle<TType extends NodeTypeKey<TTypes>>(
    nodeId: NodeId,
    claimedType: TType,
    requireExisting: boolean,
  ): void {
    const node = this.getNode(nodeId);
    if (!node) {
      if (requireExisting) {
        throw new EditorNodeMissingError(nodeId);
      }
      return;
    }

    const actualType = String(node.type);
    if (actualType !== claimedType) {
      throw new EditorNodeTypeMismatchError(nodeId, claimedType, actualType);
    }
  }

  private resolveNodeType(nodeId: NodeId, explicitNodeType?: string): string | undefined {
    const node = this.getNode(nodeId);
    if (!node) {
      return explicitNodeType;
    }

    const actualType = String(node.type);
    if (explicitNodeType && explicitNodeType !== actualType) {
      throw new EditorNodeTypeMismatchError(nodeId, explicitNodeType, actualType);
    }

    return actualType;
  }

  private createFieldGuards(
    nodeId: NodeId,
    pointer: JsonPointer,
    expected: unknown,
    nodeType: string | undefined,
  ): Guard[] {
    const currentNode = this.getNode(nodeId);
    if (currentNode) {
      const resolution = resolvePointer(currentNode.attrs, pointer);
      if (resolution.ok) {
        const encodedActual = encodeRuntimeValueForPointer(
          this.schemas,
          nodeType,
          pointer,
          resolution.value,
        );
        const encodedExpected = encodeRuntimeValueForPointer(
          this.schemas,
          nodeType,
          pointer,
          expected,
        );

        if (!deepEqual(encodedActual, encodedExpected)) {
          throw new MalformedPatchError(
            `Expected value for node "${nodeId}" at "${pointer}" does not match the current builder state.`,
            {
              details: {
                nodeId,
                path: pointer,
                actual: encodedActual,
                expected: encodedExpected,
              },
            },
          );
        }

        if (shouldPreferHash(this.schemas, nodeType, pointer, resolution.value)) {
          return [{
            kind: "attrHash",
            nodeId,
            path: pointer,
            hash: getPathHash(this.currentTree as IndexedTree<TTypes>, nodeId, pointer),
          }];
        }

        return [{
          kind: "attrEquals",
          nodeId,
          path: pointer,
          value: encodedActual,
        }];
      }
    }

    return [{
      kind: "attrEquals",
      nodeId,
      path: pointer,
      value: encodeRuntimeValueForPointer(this.schemas, nodeType, pointer, expected),
    }];
  }

  private commitOp(op: PatchOp): void {
    if (this.validationSession) {
      const result = applyOperationInSession(this.validationSession, op);
      if (!result.ok) {
        throw new MalformedPatchError(
          `Builder operation "${op.opId}" is invalid against the current builder state: ${result.conflict.message}`,
          {
            details: { opId: op.opId, conflict: result.conflict },
          },
        );
      }
    }

    this.ops.push(op);
  }

  addSetAttr(
    nodeId: NodeId,
    path: readonly (string | number)[],
    value: unknown,
    options: PatchBuilderFieldOptions<unknown> | undefined,
    explicitNodeType?: string,
  ): void {
    const pointer = pathToPointer(path as AttrPath<unknown>);
    const nodeType = this.resolveNodeType(nodeId, explicitNodeType);
    const guards = options?.expect === undefined
      ? undefined
      : this.createFieldGuards(nodeId, pointer, options.expect, nodeType);

    this.commitOp({
      kind: "setAttr",
      opId: this.opIds("set", nodeId, pointer),
      nodeId,
      path: pointer,
      value: encodeRuntimeValueForPointer(this.schemas, nodeType, pointer, value),
      ...(guards?.length ? { guards } : {}),
    });
  }

  addRemoveAttr(
    nodeId: NodeId,
    path: readonly (string | number)[],
    options: PatchBuilderFieldOptions<unknown> | undefined,
    explicitNodeType?: string,
  ): void {
    const pointer = pathToPointer(path as AttrPath<unknown>);
    const nodeType = this.resolveNodeType(nodeId, explicitNodeType);
    const guards = options?.expect === undefined
      ? undefined
      : this.createFieldGuards(nodeId, pointer, options.expect, nodeType);

    this.commitOp({
      kind: "removeAttr",
      opId: this.opIds("remove-attr", nodeId, pointer),
      nodeId,
      path: pointer,
      ...(guards?.length ? { guards } : {}),
    });
  }

  addHideNode(nodeId: NodeId, explicitNodeType?: string): void {
    const nodeType = this.resolveNodeType(nodeId, explicitNodeType);
    const guards: Guard[] = [{ kind: "nodeExists", nodeId }];
    if (nodeType) {
      guards.push({ kind: "nodeTypeIs", nodeId, nodeType });
    }

    this.commitOp({
      kind: "hideNode",
      opId: this.opIds("hide", nodeId),
      nodeId,
      guards,
    });
  }

  addShowNode(nodeId: NodeId, explicitNodeType?: string): void {
    const nodeType = this.resolveNodeType(nodeId, explicitNodeType);
    const guards: Guard[] = [{ kind: "nodeExists", nodeId }];
    if (nodeType) {
      guards.push({ kind: "nodeTypeIs", nodeId, nodeType });
    }

    this.commitOp({
      kind: "showNode",
      opId: this.opIds("show", nodeId),
      nodeId,
      guards,
    });
  }

  addInsertNode(
    parentId: NodeId,
    node: AnyTreeNode<TTypes>,
    position?: ChildPosition,
  ): void {
    const normalizedPosition = normalizePosition(position, "builder.insertNode.position");
    this.commitOp({
      kind: "insertNode",
      opId: this.opIds("insert", node.id),
      parentId,
      ...(normalizedPosition ? { position: normalizedPosition } : {}),
      node: serializeNodeSubtree(this.schemas, node, new Set<string>()),
      guards: [
        { kind: "nodeExists", nodeId: parentId },
        ...createAnchorGuards(parentId, normalizedPosition),
      ],
    });
  }

  addMoveNode(
    nodeId: NodeId,
    newParentId: NodeId,
    position?: ChildPosition,
    explicitNodeType?: string,
  ): void {
    const normalizedPosition = normalizePosition(position, "builder.moveNode.position");
    const nodeType = this.resolveNodeType(nodeId, explicitNodeType);
    const guards: Guard[] = [
      { kind: "nodeExists", nodeId },
      { kind: "nodeExists", nodeId: newParentId },
      ...createAnchorGuards(newParentId, normalizedPosition),
    ];

    if (nodeType) {
      guards.push({ kind: "nodeTypeIs", nodeId, nodeType });
    }

    if (this.getNode(nodeId)) {
      guards.push({
        kind: "parentIs",
        nodeId,
        parentId: this.currentTree?.index.parentById.get(nodeId) ?? null,
      });
    }

    this.commitOp({
      kind: "moveNode",
      opId: this.opIds("move", nodeId),
      nodeId,
      newParentId,
      ...(normalizedPosition ? { position: normalizedPosition } : {}),
      guards,
    });
  }

  addReplaceSubtree(
    nodeId: NodeId,
    node: AnyTreeNode<TTypes>,
  ): void {
    if (node.id !== nodeId) {
      throw new MalformedPatchError(
        `Replacement subtree node id "${node.id}" must equal target nodeId "${nodeId}".`,
        {
          details: { nodeId, replacementId: node.id },
        },
      );
    }

    const guards: Guard[] = [];
    if (this.getNode(nodeId)) {
      guards.push({
        kind: "subtreeHash",
        nodeId,
        hash: getSubtreeHash(this.currentTree as IndexedTree<TTypes>, nodeId),
      });
    }

    this.commitOp({
      kind: "replaceSubtree",
      opId: this.opIds("replace", nodeId),
      nodeId,
      node: serializeNodeSubtree(this.schemas, node, new Set<string>()),
      ...(guards.length ? { guards } : {}),
    });
  }

  addRemoveNode(nodeId: NodeId, explicitNodeType?: string): void {
    const guards: Guard[] = [{ kind: "nodeExists", nodeId }];
    const nodeType = this.resolveNodeType(nodeId, explicitNodeType);
    if (nodeType) {
      guards.push({ kind: "nodeTypeIs", nodeId, nodeType });
    }

    if (this.getNode(nodeId)) {
      guards.push({
        kind: "parentIs",
        nodeId,
        parentId: this.currentTree?.index.parentById.get(nodeId) ?? null,
      });
    }

    this.commitOp({
      kind: "removeNode",
      opId: this.opIds("remove-node", nodeId),
      nodeId,
      guards,
    });
  }

  build(): TreePatch {
    if (!this.patchIdValue) {
      throw new MissingPatchIdError();
    }

    const patch: TreePatch = {
      format: "tree-patch/v1",
      patchId: this.patchIdValue,
      ...(this.baseRevisionValue !== undefined ? { baseRevision: this.baseRevisionValue } : {}),
      ...(this.metadataValue !== undefined
        ? { metadata: cloneMetadata(this.metadataValue)! }
        : {}),
      ops: this.ops.map((op) => structuredClone(op)),
    };

    assertPatchEnvelope(patch);
    return structuredClone(patch);
  }
}

function createNodeApi<
  TTypes extends NodeTypeMap,
  TType extends NodeTypeKey<TTypes>,
>(
  controller: PatchBuilderController<TTypes>,
  rootApi: PatchBuilderChainMethods<TTypes>,
  nodeId: NodeId,
  claimedType: TType,
): NodeEditor<TTypes, TType> {
  const nodeApi = { ...rootApi } as NodeEditor<TTypes, TType>;
  nodeApi.set = (path, value, options) => {
    controller.addSetAttr(nodeId, path, value, options, claimedType);
    return nodeApi;
  };
  nodeApi.remove = (path, options) => {
    controller.addRemoveAttr(nodeId, path, options, claimedType);
    return nodeApi;
  };
  nodeApi.hide = () => {
    controller.addHideNode(nodeId, claimedType);
    return nodeApi;
  };
  nodeApi.show = () => {
    controller.addShowNode(nodeId, claimedType);
    return nodeApi;
  };
  nodeApi.insert = (node, position) => {
    controller.addInsertNode(nodeId, node, position);
    return nodeApi;
  };
  nodeApi.move = (newParentId, position) => {
    controller.addMoveNode(nodeId, newParentId, position, claimedType);
    return nodeApi;
  };
  nodeApi.replace = (node) => {
    controller.addReplaceSubtree(nodeId, node);
    return nodeApi;
  };
  nodeApi.removeNode = () => {
    controller.addRemoveNode(nodeId, claimedType);
    return nodeApi;
  };

  return nodeApi;
}

function createBuilderApi<TTypes extends NodeTypeMap>(
  controller: PatchBuilderController<TTypes>,
  requireExistingNodeHandles: boolean,
): PatchBuilder<TTypes> {
  const api: PatchBuilder<TTypes> = {
    patchId(patchId) {
      controller.setPatchId(patchId);
      return api;
    },
    baseRevision(baseRevision) {
      controller.setBaseRevision(baseRevision);
      return api;
    },
    metadata(metadata) {
      controller.setMetadata(metadata);
      return api;
    },
    node(nodeId, claimedType) {
      controller.ensureNodeHandle(nodeId, claimedType, requireExistingNodeHandles);
      return createNodeApi(controller, api, nodeId, claimedType);
    },
    hideNode(nodeId) {
      controller.addHideNode(nodeId);
      return api;
    },
    showNode(nodeId) {
      controller.addShowNode(nodeId);
      return api;
    },
    insertNode(parentId, node, position) {
      controller.addInsertNode(parentId, node, position);
      return api;
    },
    moveNode(nodeId, newParentId, position) {
      controller.addMoveNode(nodeId, newParentId, position);
      return api;
    },
    replaceSubtree(nodeId, node) {
      controller.addReplaceSubtree(nodeId, node);
      return api;
    },
    removeNode(nodeId) {
      controller.addRemoveNode(nodeId);
      return api;
    },
    build() {
      return controller.build();
    },
  };

  return api;
}

export function patchBuilder<TTypes extends NodeTypeMap>(
  options: PatchBuilderOptions<TTypes> = {},
): PatchBuilder<TTypes> {
  return createBuilderApi(new PatchBuilderController(options), options.source !== undefined);
}

export function createEditor<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  options: CreateEditorOptions<TTypes> = {},
): TreeEditor<TTypes> {
  return createBuilderApi(
    new PatchBuilderController<TTypes>({
      source,
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.patchId !== undefined ? { patchId: options.patchId } : {}),
      ...(options.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    }),
    true,
  ) as TreeEditor<TTypes>;
}
