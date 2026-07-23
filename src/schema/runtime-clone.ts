import type {
  IndexedNode,
  JsonPointer,
  NodeTypeMap,
} from "../core/types.js";
import {
  deepFreezePlainData,
  isPlainObject,
  setOwnEnumerableValue,
} from "../core/snapshot.js";
import {
  cloneRuntimeValue,
  isJsonValue,
} from "./adapters.js";
import type { CompiledTreeSchema } from "./schema.js";
import {
  getNodeRuntimeSpec,
  getValueAdapterForPointer,
} from "./schema.js";

function joinPointer(base: JsonPointer, segment: string | number): JsonPointer {
  const encoded = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return (base === "" ? `/${encoded}` : `${base}/${encoded}`) as JsonPointer;
}

export function cloneRuntimeTreeValue<TTypes extends NodeTypeMap>(
  schema: CompiledTreeSchema<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
  value: unknown,
): unknown {
  const adapter = getValueAdapterForPointer(schema, nodeType, pointer);
  if (adapter) {
    return cloneRuntimeValue(value, adapter, pointer);
  }

  if (isJsonValue(value)) {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        cloneRuntimeTreeValue(
          schema,
          nodeType,
          joinPointer(pointer, index),
          item,
        ),
      );
    }

    if (isPlainObject(value)) {
      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        setOwnEnumerableValue(
          clone,
          key,
          cloneRuntimeTreeValue(
            schema,
            nodeType,
            joinPointer(pointer, key),
            value[key],
          ),
        );
      }
      return clone;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      cloneRuntimeTreeValue(
        schema,
        nodeType,
        joinPointer(pointer, index),
        item,
      ),
    );
  }

  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      setOwnEnumerableValue(
        clone,
        key,
        cloneRuntimeTreeValue(
          schema,
          nodeType,
          joinPointer(pointer, key),
          value[key],
        ),
      );
    }
    return clone;
  }

  return cloneRuntimeValue(value, undefined, pointer);
}

export function exposeRuntimeAttrs<TTypes extends NodeTypeMap>(
  schema: CompiledTreeSchema<TTypes>,
  ownership: "clone" | "assumeImmutable",
  nodeType: string,
  attrs: unknown,
): unknown {
  if (
    ownership === "assumeImmutable" ||
    getNodeRuntimeSpec(schema, nodeType).adapters.size === 0
  ) {
    return attrs;
  }

  return deepFreezePlainData(
    cloneRuntimeTreeValue(schema, nodeType, "", attrs),
  );
}

export function exposeIndexedNode<TTypes extends NodeTypeMap>(
  schema: CompiledTreeSchema<TTypes>,
  ownership: "clone" | "assumeImmutable",
  node: IndexedNode<TTypes>,
): IndexedNode<TTypes> {
  const attrs = exposeRuntimeAttrs(
    schema,
    ownership,
    String(node.type),
    node.attrs,
  );
  if (attrs === node.attrs) {
    return node;
  }

  return Object.freeze({
    ...node,
    attrs,
  }) as IndexedNode<TTypes>;
}
