import type {
  EncodedValue,
  JsonPointer,
  JsonValue,
  PersistedValue,
  ValueAdapter,
  ValueCodec,
} from "../core/types.js";
import {
  MissingCodecError,
  UnsupportedRuntimeValueError,
} from "../core/errors.js";
import { isPlainObject, setOwnEnumerableValue } from "../core/snapshot.js";

export const defaultJsonValueAdapter: ValueAdapter<JsonValue> = {
  equals: (left, right) => deepEqual(left, right),
  hash: (value) => canonicalizeJsonValue(value),
  clone: (value) => cloneJsonValue(value),
};

export function isJsonValue(value: unknown): value is JsonValue {
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; exit?: true }> = [{ value }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.value;
    if (frame.exit) {
      active.delete(current as object);
      continue;
    }

    if (current === null || typeof current === "string" || typeof current === "boolean") {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return false;
      }
      continue;
    }
    if (typeof current !== "object") {
      return false;
    }
    if (!Array.isArray(current) && !isPlainObject(current)) {
      return false;
    }
    if (active.has(current)) {
      return false;
    }

    active.add(current);
    stack.push({ value: current, exit: true });
    const children = Array.isArray(current) ? current : Object.values(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index] });
    }
  }

  return true;
}

export function cloneJsonValue<TValue extends JsonValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as TValue;
  }

  const clone: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    setOwnEnumerableValue(clone, key, cloneJsonValue(value[key] as JsonValue));
  }
  return clone as TValue;
}

export function canonicalizeJsonValue(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJsonValue(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJsonValue(value[key] as JsonValue)}`,
  );
  return `{${entries.join(",")}}`;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left === null || right === null) {
    return left === right;
  }

  if (typeof left !== typeof right) {
    return false;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key, index) => {
      if (key !== rightKeys[index]) {
        return false;
      }

      return deepEqual(left[key], right[key]);
    });
  }

  return false;
}

export function cloneRuntimeValue<TValue>(
  value: TValue,
  adapter?: ValueAdapter<TValue>,
  pointer?: JsonPointer,
): TValue {
  if (adapter?.clone) {
    return adapter.clone(value);
  }

  if (isJsonValue(value)) {
    return cloneJsonValue(value) as TValue;
  }

  if (adapter?.codec) {
    const serialized = adapter.codec.serialize(value);
    if (!isJsonValue(serialized)) {
      throw new UnsupportedRuntimeValueError(
        `Codec "${adapter.codec.codecId}" returned a non-JSON value from serialize().`,
        {
          details: { codecId: adapter.codec.codecId, pointer },
        },
      );
    }
    return adapter.codec.deserialize(serialized);
  }

  throw new UnsupportedRuntimeValueError(
    pointer
      ? `Value at pointer "${pointer}" is not JSON-compatible and has no clone() or codec.`
      : "Value is not JSON-compatible and has no clone() or codec.",
    {
      details: { pointer },
    },
  );
}

export function encodePersistedValue<TValue>(
  value: TValue,
  adapter?: ValueAdapter<TValue>,
): PersistedValue {
  if (isJsonValue(value)) {
    return cloneJsonValue(value);
  }

  const codec = adapter?.codec;
  if (!codec) {
    throw new MissingCodecError(
      "Cannot persist a non-JSON value without a registered codec.",
    );
  }

  const serialized = codec.serialize(value);
  if (!isJsonValue(serialized)) {
    throw new UnsupportedRuntimeValueError(
      `Codec "${codec.codecId}" returned a non-JSON value from serialize().`,
      {
        details: { codecId: codec.codecId },
      },
    );
  }

  return {
    $codec: codec.codecId,
    value: serialized,
  } satisfies EncodedValue;
}

export function isEncodedValue(value: PersistedValue): value is EncodedValue {
  // The {$codec, value} object shape is reserved wire syntax for persisted codec envelopes.
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("$codec") &&
    keys.includes("value") &&
    typeof value.$codec === "string" &&
    isJsonValue(value.value)
  );
}

export function decodePersistedValue(
  value: PersistedValue,
  codecs: readonly ValueCodec[] = [],
): unknown {
  if (!isEncodedValue(value)) {
    return cloneJsonValue(value);
  }

  const codec = codecs.find((candidate) => candidate.codecId === value.$codec);
  if (!codec) {
    throw new MissingCodecError(
      `Codec "${value.$codec}" is not registered for persisted value decoding.`,
      {
        details: { codecId: value.$codec },
      },
    );
  }

  return codec.deserialize(value.value);
}
