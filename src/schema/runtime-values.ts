import type {
  JsonPointer,
  NodeTypeMap,
  PersistedValue,
} from "../core/types.js";
import { MalformedPatchError, MissingCodecError } from "../core/errors.js";
import { isPlainObject, setOwnEnumerableValue } from "../core/snapshot.js";
import {
  cloneJsonValue,
  deepEqual,
  encodePersistedValue,
  isJsonValue,
} from "./adapters.js";
import type { CompiledTreeSchema } from "./schema.js";
import {
  getValueAdapterForPointer,
  isAtomicPointer,
} from "./schema.js";
import { joinJsonPointer } from "../core/hash.js";

export type CompiledSchemas<TTypes extends NodeTypeMap> = readonly CompiledTreeSchema<TTypes>[];

export function getValueAdapterForSchemas<TTypes extends NodeTypeMap>(
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

export function isAtomicForSchemas<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
): boolean {
  return schemas.some((schema) => isAtomicPointer(schema, nodeType, pointer));
}

export function runtimeValuesEqualForSchemas<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
  nodeType: string,
  pointer: JsonPointer,
  left: unknown,
  right: unknown,
): boolean {
  const adapter = getValueAdapterForSchemas(schemas, nodeType, pointer);
  return adapter
    ? adapter.equals(left as never, right as never)
    : deepEqual(left, right);
}

export function schemasRequireSemanticComparison<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
): boolean {
  for (const schema of schemas) {
    for (const spec of schema.types.values()) {
      for (const adapter of spec.adapters.values()) {
        if (!adapter.hash) {
          return true;
        }
      }
    }
  }

  return false;
}

export function encodeRuntimeValueForPointer<TTypes extends NodeTypeMap>(
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

  const adapter = getValueAdapterForSchemas(schemas, nodeType, pointer);
  const jsonCompatible = isJsonValue(value);
  if (!jsonCompatible && adapter?.codec) {
    return encodePersistedValue(value, adapter as never);
  }

  if (jsonCompatible) {
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
        setOwnEnumerableValue(
          encoded as Record<string, unknown>,
          key,
          encodeRuntimeValueForPointer(
            schemas,
            nodeType,
            joinJsonPointer(pointer, key),
            value[key],
          ),
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
      setOwnEnumerableValue(
        encoded as Record<string, unknown>,
        key,
        encodeRuntimeValueForPointer(
          schemas,
          nodeType,
          joinJsonPointer(pointer, key),
          value[key],
        ),
      );
    }

    return encoded as PersistedValue;
  }

  if (!adapter?.codec) {
    throw new MissingCodecError(
      `Cannot persist non-JSON value for node type "${nodeType}" at pointer "${pointer}" without a codec.`,
      {
        details: { nodeType, pointer },
      },
    );
  }

  return encodePersistedValue(value, adapter as never);
}
