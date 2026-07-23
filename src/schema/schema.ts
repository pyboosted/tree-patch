import type {
  JsonPointer,
  NodeRuntimeSpec,
  NodeTypeMap,
  TreeSchema,
  ValueAdapter,
  ValueCodec,
} from "../core/types.js";
import { InvalidSchemaError } from "../core/errors.js";
import {
  createReadonlyMapView,
  createReadonlySetView,
  isPlainObject,
} from "../core/snapshot.js";
import { pathToPointer, parseJsonPointer } from "./pointers.js";

export interface CompiledNodeRuntimeSpec {
  atomicPointers: readonly JsonPointer[];
  atomicPointerSet: ReadonlySet<JsonPointer>;
  adapters: ReadonlyMap<JsonPointer, ValueAdapter<unknown>>;
}

export interface CompiledTreeSchema<TTypes extends NodeTypeMap> {
  readonly types: ReadonlyMap<string, CompiledNodeRuntimeSpec>;
}

const EMPTY_NODE_SPEC: CompiledNodeRuntimeSpec = Object.freeze({
  atomicPointers: Object.freeze([]) as readonly JsonPointer[],
  atomicPointerSet: createReadonlySetView(new Set<JsonPointer>()),
  adapters: createReadonlyMapView(new Map<JsonPointer, ValueAdapter<unknown>>()),
});

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
  if (!isPlainObject(spec)) {
    throw new InvalidSchemaError(
      `Runtime specification for node type "${nodeType}" must be an object.`,
      { details: { nodeType } },
    );
  }

  if (spec.atomicPaths !== undefined && !Array.isArray(spec.atomicPaths)) {
    throw new InvalidSchemaError(
      `atomicPaths for node type "${nodeType}" must be an array.`,
      { details: { nodeType } },
    );
  }

  for (const path of spec.atomicPaths ?? []) {
    if (!Array.isArray(path)) {
      throw new InvalidSchemaError(
        `Every atomic path for node type "${nodeType}" must be an array.`,
        { details: { nodeType } },
      );
    }
  }

  const atomicPointers = [...new Set((spec.atomicPaths ?? []).map((path) => pathToPointer(path)))].sort();

  for (const pointer of atomicPointers) {
    parseJsonPointer(pointer);
  }

  for (let index = 0; index < atomicPointers.length - 1; index += 1) {
    const current = atomicPointers[index]!;
    const next = atomicPointers[index + 1]!;
    if (overlaps(current, next)) {
      throw new InvalidSchemaError(
        `Atomic paths "${current}" and "${next}" overlap on node type "${nodeType}".`,
        {
          details: { nodeType, left: current, right: next },
        },
      );
    }
  }

  if (spec.adapters !== undefined && !isPlainObject(spec.adapters)) {
    throw new InvalidSchemaError(
      `adapters for node type "${nodeType}" must be an object.`,
      { details: { nodeType } },
    );
  }

  const adapters = new Map<JsonPointer, ValueAdapter<unknown>>();
  for (const [pointer, adapter] of Object.entries(spec.adapters ?? {})) {
    parseJsonPointer(pointer);
    if (!isPlainObject(adapter) || typeof adapter.equals !== "function") {
      throw new InvalidSchemaError(
        `Adapter for node type "${nodeType}" at "${pointer}" must provide equals().`,
        { details: { nodeType, pointer } },
      );
    }
    if (adapter.hash !== undefined && typeof adapter.hash !== "function") {
      throw new InvalidSchemaError(
        `Adapter hash for node type "${nodeType}" at "${pointer}" must be a function.`,
        { details: { nodeType, pointer } },
      );
    }
    if (adapter.clone !== undefined && typeof adapter.clone !== "function") {
      throw new InvalidSchemaError(
        `Adapter clone for node type "${nodeType}" at "${pointer}" must be a function.`,
        { details: { nodeType, pointer } },
      );
    }

    const checkedAdapter = adapter as unknown as ValueAdapter<unknown>;
    let codec: ValueCodec<unknown> | undefined;
    if (adapter.codec !== undefined) {
      if (
        !isPlainObject(adapter.codec) ||
        typeof adapter.codec.codecId !== "string" ||
        adapter.codec.codecId.length === 0 ||
        typeof adapter.codec.serialize !== "function" ||
        typeof adapter.codec.deserialize !== "function"
      ) {
        throw new InvalidSchemaError(
          `Adapter codec for node type "${nodeType}" at "${pointer}" must provide a non-empty codecId, serialize(), and deserialize().`,
          { details: { nodeType, pointer } },
        );
      }

      codec = Object.freeze({
        codecId: adapter.codec.codecId,
        serialize: checkedAdapter.codec!.serialize,
        deserialize: checkedAdapter.codec!.deserialize,
      });
    }

    adapters.set(pointer as JsonPointer, Object.freeze({
      equals: checkedAdapter.equals,
      ...(checkedAdapter.hash !== undefined ? { hash: checkedAdapter.hash } : {}),
      ...(checkedAdapter.clone !== undefined ? { clone: checkedAdapter.clone } : {}),
      ...(codec !== undefined ? { codec } : {}),
    }));
  }

  const atomicPointerSet = new Set(atomicPointers);
  return Object.freeze({
    atomicPointers: Object.freeze(atomicPointers),
    atomicPointerSet: createReadonlySetView(atomicPointerSet),
    adapters: createReadonlyMapView(adapters),
  });
}

export function compileTreeSchema<TTypes extends NodeTypeMap>(
  schema?: TreeSchema<TTypes>,
): CompiledTreeSchema<TTypes> {
  if (!schema) {
    return Object.freeze({
      types: createReadonlyMapView(new Map()),
    });
  }

  if (!isPlainObject(schema) || !isPlainObject(schema.types)) {
    throw new InvalidSchemaError("Tree schema must provide a types object.");
  }

  const compiledTypes = new Map<string, CompiledNodeRuntimeSpec>();

  for (const [nodeType, spec] of Object.entries(schema.types)) {
    if (spec === undefined) {
      compiledTypes.set(nodeType, EMPTY_NODE_SPEC);
      continue;
    }

    if (spec === null) {
      throw new InvalidSchemaError(
        `Runtime specification for node type "${nodeType}" must be an object.`,
        { details: { nodeType } },
      );
    }
    compiledTypes.set(nodeType, compileNodeRuntimeSpec(nodeType, spec));
  }

  return Object.freeze({
    types: createReadonlyMapView(compiledTypes),
  });
}

export function getNodeRuntimeSpec<TTypes extends NodeTypeMap>(
  schema: CompiledTreeSchema<TTypes>,
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
