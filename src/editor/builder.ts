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
  PersistedValue,
  SerializedPatchNode,
  TreePatch,
  TreeSchema,
} from "../core/types.js";
import {
  EditorNodeMissingError,
  EditorNodeTypeMismatchError,
  MalformedPatchError,
  MissingPatchIdError,
} from "../core/errors.js";
import { applyPatch } from "../core/apply.js";
import { getPathHash, getSubtreeHash, joinJsonPointer } from "../core/hash.js";
import { normalizePosition, assertPatchEnvelope } from "../core/patch-validation.js";
import { isPlainObject } from "../core/snapshot.js";
import { getTreeState } from "../core/state.js";
import {
  cloneJsonValue,
  deepEqual,
  encodePersistedValue,
  isJsonValue,
} from "../schema/adapters.js";
import { pathToPointer, resolvePointer } from "../schema/pointers.js";
import type { CompiledTreeSchema } from "../schema/schema.js";
import {
  compileTreeSchema,
  getValueAdapterForPointer,
  isAtomicPointer,
} from "../schema/schema.js";

type NodeTypeKey<TTypes extends NodeTypeMap> = Extract<keyof TTypes, string>;

type BuilderAttrPath<TTypes extends NodeTypeMap> = {
  [K in NodeTypeKey<TTypes>]: AttrPath<TTypes[K]>;
}[NodeTypeKey<TTypes>];

type BuilderAttrValue<
  TTypes extends NodeTypeMap,
  TPath extends BuilderAttrPath<TTypes>,
> = {
  [K in NodeTypeKey<TTypes>]:
    TPath extends AttrPath<TTypes[K]>
      ? DeepValue<TTypes[K], Extract<TPath, AttrPath<TTypes[K]>>>
      : never;
}[NodeTypeKey<TTypes>];

type CompiledSchemas<TTypes extends NodeTypeMap> = readonly CompiledTreeSchema<TTypes>[];

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

export interface PatchBuilder<TTypes extends NodeTypeMap> {
  patchId(patchId: string): PatchBuilder<TTypes>;
  baseRevision(baseRevision?: string): PatchBuilder<TTypes>;
  metadata(metadata?: Record<string, unknown>): PatchBuilder<TTypes>;
  setAttr<TPath extends BuilderAttrPath<TTypes>>(
    nodeId: NodeId,
    path: TPath,
    value: BuilderAttrValue<TTypes, TPath>,
    options?: PatchBuilderFieldOptions<BuilderAttrValue<TTypes, TPath>>,
  ): PatchBuilder<TTypes>;
  removeAttr<TPath extends BuilderAttrPath<TTypes>>(
    nodeId: NodeId,
    path: TPath,
    options?: PatchBuilderFieldOptions<BuilderAttrValue<TTypes, TPath>>,
  ): PatchBuilder<TTypes>;
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

export interface NodeEditor<
  TTypes extends NodeTypeMap,
  TType extends NodeTypeKey<TTypes>,
> {
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

export interface TreeEditor<TTypes extends NodeTypeMap> extends PatchBuilder<TTypes> {
  node<TType extends NodeTypeKey<TTypes>>(
    nodeId: NodeId,
    claimedType: TType,
  ): NodeEditor<TTypes, TType>;
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

function getAdapterForSchemas<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
) {
  for (const schema of schemas) {
    const adapter = getValueAdapterForPointer(schema, nodeType, pointer);
    if (adapter) {
      return adapter;
    }
  }

  return undefined;
}

function isAtomicForSchemas<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
): boolean {
  return schemas.some((schema) => isAtomicPointer(schema, nodeType, pointer));
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
    getAdapterForSchemas(schemas, nodeType, pointer) !== undefined ||
    isAtomicForSchemas(schemas, nodeType, pointer) ||
    Array.isArray(value) ||
    isPlainObject(value)
  );
}

function encodeRuntimeValueForPointer<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string | undefined,
  pointer: JsonPointer,
  value: unknown,
): PersistedValue {
  if (!nodeType) {
    if (!isJsonValue(value)) {
      throw new MalformedPatchError(
        `Cannot serialize non-JSON value at pointer "${pointer}" without a source-backed node type.`,
        {
          details: { pointer },
        },
      );
    }

    return cloneJsonValue(value);
  }

  const adapter = getAdapterForSchemas(schemas, nodeType, pointer);
  if (isJsonValue(value)) {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        encodeRuntimeValueForPointer(
          schemas,
          nodeType,
          joinJsonPointer(pointer, index),
          item,
        ),
      ) as PersistedValue;
    }

    if (isPlainObject(value)) {
      const encoded: Record<string, PersistedValue> = {};
      for (const key of Object.keys(value)) {
        encoded[key] = encodeRuntimeValueForPointer(
          schemas,
          nodeType,
          joinJsonPointer(pointer, key),
          value[key],
        );
      }
      return encoded as PersistedValue;
    }

    return encodePersistedValue(value, adapter as never);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      encodeRuntimeValueForPointer(
        schemas,
        nodeType,
        joinJsonPointer(pointer, index),
        item,
      ),
    ) as PersistedValue;
  }

  if (isPlainObject(value)) {
    const encoded: Record<string, PersistedValue> = {};
    for (const key of Object.keys(value)) {
      encoded[key] = encodeRuntimeValueForPointer(
        schemas,
        nodeType,
        joinJsonPointer(pointer, key),
        value[key],
      );
    }
    return encoded as PersistedValue;
  }

  return encodePersistedValue(value, adapter as never);
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
    attrs: encodeRuntimeValueForPointer(
      schemas,
      String(node.type),
      "",
      node.attrs,
    ),
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
  private currentTree: IndexedTree<TTypes> | undefined;
  private patchIdValue: string | undefined;
  private baseRevisionValue: string | undefined;
  private metadataValue: Record<string, unknown> | undefined;
  private readonly ops: PatchOp[] = [];
  private readonly opIds = createOpIdFactory();

  constructor(options: PatchBuilderOptions<TTypes>) {
    this.schemas = getCompiledSchemas(options.source, options.schema);
    this.currentTree = options.source;
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

  getCurrentTree(): IndexedTree<TTypes> | undefined {
    return this.currentTree;
  }

  ensureEditorNode<TType extends NodeTypeKey<TTypes>>(
    nodeId: NodeId,
    claimedType: TType,
  ): void {
    const node = this.currentTree?.nodes.get(nodeId);
    if (!node) {
      throw new EditorNodeMissingError(nodeId);
    }

    const actualType = String(node.type);
    if (actualType !== claimedType) {
      throw new EditorNodeTypeMismatchError(nodeId, claimedType, actualType);
    }
  }

  private resolveNodeType(nodeId: NodeId, explicitNodeType?: string): string | undefined {
    const node = this.currentTree?.nodes.get(nodeId);
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
    const currentTree = this.currentTree;
    if (currentTree) {
      const currentNode = currentTree.nodes.get(nodeId);
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
              hash: getPathHash(currentTree, nodeId, pointer),
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
    }

    return [{
      kind: "attrEquals",
      nodeId,
      path: pointer,
      value: encodeRuntimeValueForPointer(this.schemas, nodeType, pointer, expected),
    }];
  }

  private commitOp(op: PatchOp): void {
    if (this.currentTree) {
      const validationPatch: TreePatch = {
        format: "tree-patch/v1",
        patchId: this.patchIdValue ?? "__builder__",
        ops: [op],
      };
      const result = applyPatch(this.currentTree, validationPatch);
      if (result.status === "conflict") {
        throw new MalformedPatchError(
          `Builder operation "${op.opId}" is invalid against the current builder state: ${result.conflicts[0]?.message ?? "unknown conflict"}`,
          {
            details: { opId: op.opId, conflict: result.conflicts[0] },
          },
        );
      }

      this.currentTree = result.tree;
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

    const currentParentId = this.currentTree?.index.parentById.get(nodeId);
    if (this.currentTree?.nodes.has(nodeId)) {
      guards.push({ kind: "parentIs", nodeId, parentId: currentParentId ?? null });
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
    if (this.currentTree?.nodes.has(nodeId)) {
      guards.push({
        kind: "subtreeHash",
        nodeId,
        hash: getSubtreeHash(this.currentTree, nodeId),
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

    const currentParentId = this.currentTree?.index.parentById.get(nodeId);
    if (this.currentTree?.nodes.has(nodeId)) {
      guards.push({ kind: "parentIs", nodeId, parentId: currentParentId ?? null });
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

function createBuilderApi<TTypes extends NodeTypeMap>(
  controller: PatchBuilderController<TTypes>,
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
    setAttr(nodeId, path, value, options) {
      controller.addSetAttr(nodeId, path, value, options);
      return api;
    },
    removeAttr(nodeId, path, options) {
      controller.addRemoveAttr(nodeId, path, options);
      return api;
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
  return createBuilderApi(new PatchBuilderController(options));
}

export function createEditor<TTypes extends NodeTypeMap>(
  source: IndexedTree<TTypes>,
  options: CreateEditorOptions<TTypes> = {},
): TreeEditor<TTypes> {
  const controller = new PatchBuilderController<TTypes>({
    source,
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.patchId !== undefined ? { patchId: options.patchId } : {}),
    ...((options.baseRevision ?? source.revision) !== undefined
      ? { baseRevision: options.baseRevision ?? source.revision }
      : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  });

  const editorApi: TreeEditor<TTypes> = {
    patchId(patchId) {
      controller.setPatchId(patchId);
      return editorApi;
    },
    baseRevision(baseRevision) {
      controller.setBaseRevision(baseRevision);
      return editorApi;
    },
    metadata(metadata) {
      controller.setMetadata(metadata);
      return editorApi;
    },
    setAttr(nodeId, path, value, options) {
      controller.addSetAttr(nodeId, path, value, options);
      return editorApi;
    },
    removeAttr(nodeId, path, options) {
      controller.addRemoveAttr(nodeId, path, options);
      return editorApi;
    },
    hideNode(nodeId) {
      controller.addHideNode(nodeId);
      return editorApi;
    },
    showNode(nodeId) {
      controller.addShowNode(nodeId);
      return editorApi;
    },
    insertNode(parentId, node, position) {
      controller.addInsertNode(parentId, node, position);
      return editorApi;
    },
    moveNode(nodeId, newParentId, position) {
      controller.addMoveNode(nodeId, newParentId, position);
      return editorApi;
    },
    replaceSubtree(nodeId, node) {
      controller.addReplaceSubtree(nodeId, node);
      return editorApi;
    },
    removeNode(nodeId) {
      controller.addRemoveNode(nodeId);
      return editorApi;
    },
    build() {
      return controller.build();
    },
    node(nodeId, claimedType) {
      controller.ensureEditorNode(nodeId, claimedType);
      const nodeApi: NodeEditor<TTypes, typeof claimedType> = {
        set(path, value, options) {
          controller.addSetAttr(nodeId, path, value, options, claimedType);
          return nodeApi;
        },
        remove(path, options) {
          controller.addRemoveAttr(nodeId, path, options, claimedType);
          return nodeApi;
        },
        hide() {
          controller.addHideNode(nodeId, claimedType);
          return nodeApi;
        },
        show() {
          controller.addShowNode(nodeId, claimedType);
          return nodeApi;
        },
        insert(node, position) {
          controller.addInsertNode(nodeId, node, position);
          return nodeApi;
        },
        move(newParentId, position) {
          controller.addMoveNode(nodeId, newParentId, position, claimedType);
          return nodeApi;
        },
        replace(node) {
          controller.addReplaceSubtree(nodeId, node);
          return nodeApi;
        },
        removeNode() {
          controller.addRemoveNode(nodeId, claimedType);
          return nodeApi;
        },
      };

      return nodeApi;
    },
  };

  return editorApi;
}
