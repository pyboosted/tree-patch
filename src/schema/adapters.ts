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
import { isPlainObject } from "../core/snapshot.js";

export const defaultJsonValueAdapter: ValueAdapter<JsonValue> = {
  equals: (left, right) => deepEqual(left, right),
  hash: (value) => canonicalizeJsonValue(value),
  clone: (value) => cloneJsonValue(value),
};

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) {
        return value.every((item) => isJsonValue(item));
      }

      if (!isPlainObject(value)) {
        return false;
      }

      return Object.values(value).every((item) => isJsonValue(item));
    default:
      return false;
  }
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
    clone[key] = cloneJsonValue(value[key] as JsonValue);
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
    return adapter.codec.deserialize(adapter.codec.serialize(value));
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

  return {
    $codec: codec.codecId,
    value: codec.serialize(value),
  } satisfies EncodedValue;
}

export function isEncodedValue(value: PersistedValue): value is EncodedValue {
  // The {$codec, value} object shape is reserved wire syntax for persisted codec envelopes.
  return (
    typeof value === "object" &&
    value !== null &&
    "$codec" in value &&
    "value" in value &&
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
