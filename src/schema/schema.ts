import type {
  JsonPointer,
  NodeRuntimeSpec,
  NodeTypeMap,
  TreeSchema,
  ValueAdapter,
} from "../core/types.js";
import { InvalidSchemaError } from "../core/errors.js";
import { pathToPointer, parseJsonPointer } from "./pointers.js";

export interface CompiledNodeRuntimeSpec {
  atomicPointers: readonly JsonPointer[];
  atomicPointerSet: ReadonlySet<JsonPointer>;
  adapters: ReadonlyMap<JsonPointer, ValueAdapter<unknown>>;
}

export interface CompiledTreeSchema<TTypes extends NodeTypeMap> {
  readonly types: ReadonlyMap<string, CompiledNodeRuntimeSpec>;
  readonly raw?: TreeSchema<TTypes>;
}

const EMPTY_NODE_SPEC: CompiledNodeRuntimeSpec = {
  atomicPointers: Object.freeze([]),
  atomicPointerSet: new Set(),
  adapters: new Map(),
};

function overlaps(left: JsonPointer, right: JsonPointer): boolean {
  if (left === right) {
    return true;
  }

  if (left === "" || right === "") {
    return true;
  }

  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function compileNodeRuntimeSpec<TAttrs>(
  nodeType: string,
  spec: NodeRuntimeSpec<TAttrs>,
): CompiledNodeRuntimeSpec {
  const atomicPointers = [...new Set((spec.atomicPaths ?? []).map((path) => pathToPointer(path)))].sort();

  for (const pointer of atomicPointers) {
    parseJsonPointer(pointer);
  }

  for (let index = 0; index < atomicPointers.length; index += 1) {
    const current = atomicPointers[index]!;
    for (let scan = index + 1; scan < atomicPointers.length; scan += 1) {
      const next = atomicPointers[scan]!;
      if (overlaps(current, next)) {
        throw new InvalidSchemaError(
          `Atomic paths "${current}" and "${next}" overlap on node type "${nodeType}".`,
          {
            details: { nodeType, left: current, right: next },
          },
        );
      }
    }
  }

  const adapters = new Map<JsonPointer, ValueAdapter<unknown>>();
  for (const [pointer, adapter] of Object.entries(spec.adapters ?? {})) {
    parseJsonPointer(pointer);
    if (adapter) {
      adapters.set(pointer as JsonPointer, adapter);
    }
  }

  return {
    atomicPointers: Object.freeze(atomicPointers),
    atomicPointerSet: new Set(atomicPointers),
    adapters,
  };
}

export function compileTreeSchema<TTypes extends NodeTypeMap>(
  schema?: TreeSchema<TTypes>,
): CompiledTreeSchema<TTypes> {
  if (!schema) {
    return {
      types: new Map(),
    };
  }

  if (!schema.types || typeof schema.types !== "object") {
    throw new InvalidSchemaError("Tree schema must provide a types object.");
  }

  const compiledTypes = new Map<string, CompiledNodeRuntimeSpec>();

  for (const [nodeType, spec] of Object.entries(schema.types)) {
    if (!spec) {
      compiledTypes.set(nodeType, EMPTY_NODE_SPEC);
      continue;
    }

    compiledTypes.set(nodeType, compileNodeRuntimeSpec(nodeType, spec));
  }

  return {
    types: compiledTypes,
    raw: schema,
  };
}

export function getNodeRuntimeSpec(
  schema: CompiledTreeSchema<NodeTypeMap>,
  nodeType: string,
): CompiledNodeRuntimeSpec {
  return schema.types.get(nodeType) ?? EMPTY_NODE_SPEC;
}

export function getValueAdapterForPointer<TTypes extends NodeTypeMap>(
  schema: CompiledTreeSchema<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
): ValueAdapter<unknown> | undefined {
  return (schema.types.get(nodeType) ?? EMPTY_NODE_SPEC).adapters.get(pointer);
}

export function isAtomicPointer<TTypes extends NodeTypeMap>(
  schema: CompiledTreeSchema<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
): boolean {
  return (schema.types.get(nodeType) ?? EMPTY_NODE_SPEC).atomicPointerSet.has(pointer);
}
