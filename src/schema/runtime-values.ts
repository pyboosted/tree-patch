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

export function getSemanticComparisonNodeTypes<TTypes extends NodeTypeMap>(
  schemas: CompiledSchemas<TTypes>,
): ReadonlySet<string> {
  const nodeTypes = new Set<string>();
  for (const schema of schemas) {
    for (const [nodeType, spec] of schema.types) {
      for (const adapter of spec.adapters.values()) {
        if (!adapter.hash) {
          nodeTypes.add(nodeType);
          break;
        }
      }
    }
  }

  return nodeTypes;
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

  let root: PersistedValue | undefined;
  const active = new WeakSet<object>();
  type Frame =
    | {
        kind: "value";
        value: unknown;
        pointer: JsonPointer;
        assign: (value: PersistedValue) => void;
      }
    | { kind: "exit"; value: object };
  const stack: Frame[] = [{
    kind: "value",
    value,
    pointer,
    assign: (encoded) => {
      root = encoded;
    },
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }

    const adapter = getValueAdapterForSchemas(schemas, nodeType, frame.pointer);
    if (adapter && !isJsonValue(frame.value) && adapter.codec) {
      frame.assign(encodePersistedValue(frame.value, adapter as never));
      continue;
    }
    if (
      frame.value === null ||
      typeof frame.value === "string" ||
      typeof frame.value === "boolean" ||
      (typeof frame.value === "number" && Number.isFinite(frame.value))
    ) {
      frame.assign(frame.value);
      continue;
    }
    if (!Array.isArray(frame.value) && !isPlainObject(frame.value)) {
      throw new MissingCodecError(
        `Cannot persist non-JSON value for node type "${nodeType}" at pointer "${frame.pointer}" without a codec.`,
        { details: { nodeType, pointer: frame.pointer } },
      );
    }
    if (active.has(frame.value)) {
      throw new MalformedPatchError(
        `Cannot persist a cyclic runtime value at pointer "${frame.pointer}".`,
        { details: { nodeType, pointer: frame.pointer } },
      );
    }

    active.add(frame.value);
    stack.push({ kind: "exit", value: frame.value });
    if (Array.isArray(frame.value)) {
      const encoded = new Array<PersistedValue>(frame.value.length);
      frame.assign(encoded);
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: frame.value[index],
          pointer: joinJsonPointer(frame.pointer, index),
          assign: (child) => {
            encoded[index] = child;
          },
        });
      }
      continue;
    }

    const encoded: Record<string, PersistedValue> = {};
    frame.assign(encoded);
    const keys = Object.keys(frame.value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({
        kind: "value",
        value: frame.value[key],
        pointer: joinJsonPointer(frame.pointer, key),
        assign: (child) => {
          setOwnEnumerableValue(
            encoded as Record<string, unknown>,
            key,
            child,
          );
        },
      });
    }
  }

  return root!;
}
