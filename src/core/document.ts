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
  cloneJsonValue,
  isJsonValue,
} from "../schema/adapters.js";

const NODE_ENVELOPE_KEYS = new Set(["id", "type", "attrs", "children"]);

function cloneMetadata(
  metadata: JsonObject | undefined,
  ownership: "clone" | "assumeImmutable",
): Readonly<JsonObject> | undefined {
  if (!metadata) {
    return undefined;
  }

  if (!isPlainObject(metadata) || !isJsonValue(metadata)) {
    throw new MalformedTreeError(
      "Document metadata must be a JSON-serializable object.",
    );
  }

  if (ownership === "assumeImmutable") {
    return metadata;
  }

  return deepFreezePlainData(cloneJsonValue(metadata));
}

function assertNodeEnvelope(node: unknown, location: string, isRoot: boolean): asserts node is {
  [key: string]: unknown;
  id: string;
  type: string;
  attrs: unknown;
  children: readonly unknown[];
} {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw isRoot
      ? new InvalidRootError("Document root must be a node object.")
      : new MalformedTreeError(`Node at ${location} must be an object.`);
  }

  const candidate = node as Record<string, unknown>;
  const keys = Object.keys(candidate);
  for (const requiredKey of NODE_ENVELOPE_KEYS) {
    if (!Object.hasOwn(candidate, requiredKey)) {
      throw new MalformedTreeError(
        `Node at ${location} is missing required key "${requiredKey}".`,
      );
    }
  }

  const extraKeys = keys.filter((key) => !NODE_ENVELOPE_KEYS.has(key));
  if (extraKeys.length > 0) {
    throw new MalformedTreeError(
      `Node at ${location} contains unsupported envelope keys: ${extraKeys.join(", ")}.`,
      {
        details: { location, extraKeys },
      },
    );
  }

  if (typeof candidate.id !== "string") {
    throw new MalformedTreeError(`Node at ${location} must have a string id.`);
  }

  if (typeof candidate.type !== "string") {
    throw new MalformedTreeError(`Node at ${location} must have a string type.`);
  }

  if (!Array.isArray(candidate.children)) {
    throw new MalformedTreeError(`Node at ${location} must provide a children array.`);
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
  const activeNodeObjects = new Set<object>();

  function visit(
    node: unknown,
    parentId: string | null,
    position: number,
    depth: number,
    location: string,
    isRoot: boolean,
  ): string {
    assertNodeEnvelope(node, location, isRoot);
    const runtimeNodeObject = node as object;
    if (activeNodeObjects.has(runtimeNodeObject)) {
      throw new MalformedTreeError(`Cycle detected while visiting node at ${location}.`, {
        details: { location },
      });
    }

    activeNodeObjects.add(runtimeNodeObject);
    try {
      if (nodes.has(node.id)) {
        throw new DuplicateIdError(node.id);
      }

      const childIds = node.children.map((child, index) =>
        visit(
          child,
          node.id,
          index,
          depth + 1,
          `${location}.children[${index}]`,
          false,
        ),
      );

      const indexedNode = Object.freeze({
        id: node.id,
        type: node.type,
        attrs: prepareNodeAttrs(node.type, node.attrs, ownership, schema) as IndexedNode<TTypes>["attrs"],
        childIds: Object.freeze(childIds),
      }) as IndexedNode<TTypes>;

      nodes.set(node.id, indexedNode);
      parentById.set(node.id, parentId);
      positionById.set(node.id, position);
      depthById.set(node.id, depth);

      return node.id;
    } finally {
      activeNodeObjects.delete(runtimeNodeObject);
    }
  }

  const rootId = visit(input.root, null, 0, 0, "root", true);

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
  const tree = treeBase as IndexedTree<TTypes>;
  if (input.revision !== undefined) {
    tree.revision = input.revision;
  }
  if (input.metadata !== undefined) {
    tree.metadata = cloneMetadata(input.metadata, ownership)!;
  }

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
    },
    explicitHidden: new Set(),
    patchOwned: new Set(),
  });

  if (tree.revision === undefined) {
    tree.revision = getTreeRevisionHash(tree);
  }

  return Object.freeze(tree);
}
