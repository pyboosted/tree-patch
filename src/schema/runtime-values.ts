import type {
  JsonPointer,
  NodeTypeMap,
  PersistedValue,
} from "../core/types.js";
import { MalformedPatchError, MissingCodecError } from "../core/errors.js";
import { isPlainObject } from "../core/snapshot.js";
import {
  cloneJsonValue,
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
