import type {
  CreateDocumentOptions,
  IndexedNode,
  IndexedTree,
  JsonObject,
  JsonPointer,
  NodeTypeMap,
  TreeDocument,
} from "./types.js";
import {
  DuplicateIdError,
  InvalidRootError,
  MalformedTreeError,
} from "./errors.js";
import {
  createReadonlyMapView,
  deepFreezePlainData,
  isPlainObject,
} from "./snapshot.js";
import { attachTreeState } from "./state.js";
import { getTreeRevisionHash } from "./hash.js";
import type { CompiledTreeSchema } from "../schema/schema.js";
import { compileTreeSchema } from "../schema/schema.js";
import {
  cloneRuntimeTreeValue,
  exposeIndexedNode,
} from "../schema/runtime-clone.js";
import {
  isJsonValue,
  tryCloneJsonValue,
} from "../schema/adapters.js";
import type { ChildHashAggregate } from "./child-hash.js";

const NODE_ENVELOPE_KEYS = new Set(["id", "type", "attrs", "children"]);

function cloneMetadata(
  metadata: JsonObject | undefined,
  ownership: "clone" | "assumeImmutable",
): Readonly<JsonObject> | undefined {
  if (!metadata) {
    return undefined;
  }

  if (!isPlainObject(metadata)) {
    throw new MalformedTreeError(
      "Document metadata must be a JSON-serializable object.",
    );
  }

  if (ownership === "assumeImmutable") {
    if (!isJsonValue(metadata)) {
      throw new MalformedTreeError(
        "Document metadata must be a JSON-serializable object.",
      );
    }
    return metadata;
  }

  const cloned = tryCloneJsonValue(metadata);
  if (!cloned.ok) {
    throw new MalformedTreeError(
      "Document metadata must be a JSON-serializable object.",
    );
  }
  return deepFreezePlainData(cloned.value as JsonObject);
}

function describeNodeLocation(
  parentId: string | null,
  position: number,
): string {
  return parentId === null
    ? "root"
    : `child ${position} of node "${parentId}"`;
}

function assertNodeEnvelope(
  node: unknown,
  parentId: string | null,
  position: number,
  isRoot: boolean,
): asserts node is {
  [key: string]: unknown;
  id: string;
  type: string;
  attrs: unknown;
  children: readonly unknown[];
} {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw isRoot
      ? new InvalidRootError("Document root must be a node object.")
      : new MalformedTreeError(
          `Node at ${describeNodeLocation(parentId, position)} must be an object.`,
        );
  }

  const candidate = node as Record<string, unknown>;
  const wellFormedEnvelope =
    Object.keys(candidate).length === 4 &&
    Object.hasOwn(candidate, "id") &&
    Object.hasOwn(candidate, "type") &&
    Object.hasOwn(candidate, "attrs") &&
    Object.hasOwn(candidate, "children");
  if (!wellFormedEnvelope) {
    const location = describeNodeLocation(parentId, position);
    for (const requiredKey of NODE_ENVELOPE_KEYS) {
      if (!Object.hasOwn(candidate, requiredKey)) {
        throw new MalformedTreeError(
          `Node at ${location} is missing required key "${requiredKey}".`,
        );
      }
    }

    const extraKeys = Object.keys(candidate).filter(
      (key) => !NODE_ENVELOPE_KEYS.has(key),
    );
    if (extraKeys.length > 0) {
      throw new MalformedTreeError(
        `Node at ${location} contains unsupported envelope keys: ${extraKeys.join(", ")}.`,
        {
          details: { location, extraKeys },
        },
      );
    }
  }

  if (typeof candidate.id !== "string") {
    throw new MalformedTreeError(
      `Node at ${describeNodeLocation(parentId, position)} must have a string id.`,
    );
  }

  if (typeof candidate.type !== "string") {
    throw new MalformedTreeError(
      `Node at ${describeNodeLocation(parentId, position)} must have a string type.`,
    );
  }

  if (!Array.isArray(candidate.children)) {
    throw new MalformedTreeError(
      `Node at ${describeNodeLocation(parentId, position)} must provide a children array.`,
    );
  }
}

function prepareNodeAttrs<TTypes extends NodeTypeMap>(
  nodeType: string,
  attrs: unknown,
  ownership: "clone" | "assumeImmutable",
  schema: CompiledTreeSchema<TTypes>,
): unknown {
  if (ownership === "assumeImmutable") {
    return attrs;
  }

  return deepFreezePlainData(
    cloneRuntimeTreeValue(schema, nodeType, "", attrs),
  );
}

export function createDocument<TTypes extends NodeTypeMap>(
  input: TreeDocument<TTypes>,
  options: CreateDocumentOptions<TTypes> = {},
): IndexedTree<TTypes> {
  if (!input || typeof input !== "object") {
    throw new InvalidRootError("Document input must be an object with a root node.");
  }

  const ownership = options.ownership ?? "clone";
  const schema = compileTreeSchema(options.schema);
  const nodes = new Map<string, IndexedNode<TTypes>>();
  const parentById = new Map<string, string | null>();
  const positionById = new Map<string, number>();
  const depthById = new Map<string, number>();
  const nodeHashById = new Map<string, string>();
  const subtreeHashById = new Map<string, string>();
  const pathHashByNodeId = new Map<string, Map<JsonPointer, string>>();
  const childHashByParentId = new Map<string, ChildHashAggregate>();
  const activeNodeObjects = new Set<object>();
  const seenNodeIds = new Set<string>();

  type VisitFrame =
    | {
        kind: "enter";
        node: unknown;
        parentId: string | null;
        position: number;
        depth: number;
        isRoot: boolean;
        parentChildIds: string[] | null;
      }
    | {
        kind: "exit";
        node: {
          id: string;
          type: string;
          attrs: unknown;
          children: readonly unknown[];
        };
        runtimeNodeObject: object;
        parentId: string | null;
        position: number;
        depth: number;
        childIds: string[];
        parentChildIds: string[] | null;
      };

  let rootId = "";
  const stack: VisitFrame[] = [{
    kind: "enter",
    node: input.root,
    parentId: null,
    position: 0,
    depth: 0,
    isRoot: true,
    parentChildIds: null,
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      const indexedNode = Object.freeze({
        id: frame.node.id,
        type: frame.node.type,
        attrs: prepareNodeAttrs(
          frame.node.type,
          frame.node.attrs,
          ownership,
          schema,
        ) as IndexedNode<TTypes>["attrs"],
        childIds: Object.freeze(frame.childIds),
      }) as IndexedNode<TTypes>;

      nodes.set(frame.node.id, indexedNode);
      parentById.set(frame.node.id, frame.parentId);
      positionById.set(frame.node.id, frame.position);
      depthById.set(frame.node.id, frame.depth);
      activeNodeObjects.delete(frame.runtimeNodeObject);
      if (frame.parentChildIds === null) {
        rootId = frame.node.id;
      } else {
        frame.parentChildIds[frame.position] = frame.node.id;
      }
      continue;
    }

    assertNodeEnvelope(frame.node, frame.parentId, frame.position, frame.isRoot);
    const runtimeNodeObject = frame.node as object;
    if (activeNodeObjects.has(runtimeNodeObject)) {
      const location = describeNodeLocation(frame.parentId, frame.position);
      throw new MalformedTreeError(
        `Cycle detected while visiting node at ${location}.`,
        { details: { location } },
      );
    }
    if (seenNodeIds.has(frame.node.id)) {
      throw new DuplicateIdError(frame.node.id);
    }

    seenNodeIds.add(frame.node.id);
    activeNodeObjects.add(runtimeNodeObject);
    const childIds = new Array<string>(frame.node.children.length);
    stack.push({
      kind: "exit",
      node: frame.node,
      runtimeNodeObject,
      parentId: frame.parentId,
      position: frame.position,
      depth: frame.depth,
      childIds,
      parentChildIds: frame.parentChildIds,
    });
    for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        kind: "enter",
        node: frame.node.children[index],
        parentId: frame.node.id,
        position: index,
        depth: frame.depth + 1,
        isRoot: false,
        parentChildIds: childIds,
      });
    }
  }

  const treeBase = {
    rootId,
    nodes: createReadonlyMapView(
      nodes,
      (node) => exposeIndexedNode(schema, ownership, node),
    ),
    index: Object.freeze({
      parentById: createReadonlyMapView(parentById),
      positionById: createReadonlyMapView(positionById),
      depthById: createReadonlyMapView(depthById),
    }),
    cache: Object.freeze({
      nodeHashById: createReadonlyMapView(nodeHashById),
      subtreeHashById: createReadonlyMapView(subtreeHashById),
      pathHashByNodeId: createReadonlyMapView(
        pathHashByNodeId,
        (hashes) => createReadonlyMapView(hashes),
      ),
    }),
  };
  const metadata = cloneMetadata(input.metadata, ownership);
  const tree = {
    ...treeBase,
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  } as IndexedTree<TTypes>;

  attachTreeState(tree, {
    ownership,
    schema,
    nodes,
    index: {
      parentById,
      positionById,
      depthById,
    },
    cache: {
      nodeHashById,
      subtreeHashById,
      pathHashByNodeId,
      childHashByParentId,
    },
    explicitHidden: new Set(),
    patchOwned: new Set(),
  });

  if (tree.revision === undefined) {
    Object.defineProperty(tree, "revision", {
      enumerable: true,
      value: getTreeRevisionHash(tree),
    });
  }

  return Object.freeze(tree);
}
