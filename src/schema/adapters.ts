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
  if (!isJsonValue(value)) {
    throw new UnsupportedRuntimeValueError(
      "Cannot clone a cyclic or non-JSON runtime value as JSON.",
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const root: JsonValue = Array.isArray(value) ? [] : {};
  const stack: Array<{ source: JsonValue[] | Record<string, JsonValue>; target: JsonValue[] | Record<string, JsonValue> }> = [
    {
      source: value as JsonValue[] | Record<string, JsonValue>,
      target: root as JsonValue[] | Record<string, JsonValue>,
    },
  ];

  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    if (Array.isArray(source)) {
      const targetArray = target as JsonValue[];
      targetArray.length = source.length;
      for (let index = source.length - 1; index >= 0; index -= 1) {
        const child = source[index]!;
        if (child !== null && typeof child === "object") {
          const childClone: JsonValue = Array.isArray(child) ? [] : {};
          targetArray[index] = childClone;
          stack.push({
            source: child as JsonValue[] | Record<string, JsonValue>,
            target: childClone as JsonValue[] | Record<string, JsonValue>,
          });
        } else {
          targetArray[index] = child;
        }
      }
      continue;
    }

    const targetObject = target as Record<string, JsonValue>;
    for (const key of Object.keys(source)) {
      const child = source[key]!;
      if (child !== null && typeof child === "object") {
        const childClone: JsonValue = Array.isArray(child) ? [] : {};
        setOwnEnumerableValue(targetObject, key, childClone);
        stack.push({
          source: child as JsonValue[] | Record<string, JsonValue>,
          target: childClone as JsonValue[] | Record<string, JsonValue>,
        });
      } else {
        setOwnEnumerableValue(targetObject, key, child);
      }
    }
  }

  return root as TValue;
}

export function canonicalizeJsonValue(value: JsonValue): string {
  if (!isJsonValue(value)) {
    throw new UnsupportedRuntimeValueError(
      "Cannot canonicalize a cyclic or non-JSON runtime value as JSON.",
    );
  }
  const chunks: string[] = [];
  type Frame =
    | { kind: "value"; value: JsonValue }
    | { kind: "token"; value: string };
  const stack: Frame[] = [{ kind: "value", value }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "token") {
      chunks.push(frame.value);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") {
      chunks.push(JSON.stringify(current));
      continue;
    }

    if (Array.isArray(current)) {
      stack.push({ kind: "token", value: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index]! });
        if (index > 0) {
          stack.push({ kind: "token", value: "," });
        }
      }
      stack.push({ kind: "token", value: "[" });
      continue;
    }

    const keys = Object.keys(current).sort();
    stack.push({ kind: "token", value: "}" });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({ kind: "value", value: current[key]! });
      stack.push({ kind: "token", value: `${JSON.stringify(key)}:` });
      if (index > 0) {
        stack.push({ kind: "token", value: "," });
      }
    }
    stack.push({ kind: "token", value: "{" });
  }

  return chunks.join("");
}

export function deepEqual(left: unknown, right: unknown): boolean {
  const stack: Array<readonly [unknown, unknown]> = [[left, right]];
  const visited = new WeakMap<object, WeakSet<object>>();

  while (stack.length > 0) {
    const [currentLeft, currentRight] = stack.pop()!;
    if (Object.is(currentLeft, currentRight)) {
      continue;
    }
    if (
      currentLeft === null ||
      currentRight === null ||
      typeof currentLeft !== "object" ||
      typeof currentRight !== "object"
    ) {
      return false;
    }

    let rightValues = visited.get(currentLeft);
    if (rightValues?.has(currentRight)) {
      continue;
    }
    if (!rightValues) {
      rightValues = new WeakSet<object>();
      visited.set(currentLeft, rightValues);
    }
    rightValues.add(currentRight);

    if (Array.isArray(currentLeft) || Array.isArray(currentRight)) {
      if (
        !Array.isArray(currentLeft) ||
        !Array.isArray(currentRight) ||
        currentLeft.length !== currentRight.length
      ) {
        return false;
      }
      for (let index = 0; index < currentLeft.length; index += 1) {
        stack.push([currentLeft[index], currentRight[index]]);
      }
      continue;
    }

    if (!isPlainObject(currentLeft) || !isPlainObject(currentRight)) {
      return false;
    }
    const leftKeys = Object.keys(currentLeft).sort();
    const rightKeys = Object.keys(currentRight).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      return false;
    }
    for (const key of leftKeys) {
      stack.push([currentLeft[key], currentRight[key]]);
    }
  }

  return true;
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
