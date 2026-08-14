import type {
  EncodedValue,
  JsonPointer,
  JsonPrimitive,
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

export const ESCAPED_JSON_CODEC_ID = "$tree-patch/json";
type EscapedPersistedValue = EncodedValue & {
  $codec: typeof ESCAPED_JSON_CODEC_ID;
};

export const defaultJsonValueAdapter: ValueAdapter<JsonValue> = {
  equals: (left, right) => deepEqual(left, right),
  hash: (value) => canonicalizeJsonValue(value),
  clone: (value) => cloneJsonValue(value),
};

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isPrimitiveJsonArray(value: unknown): value is JsonPrimitive[] {
  if (!Array.isArray(value)) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!isJsonPrimitive(value[index])) {
      return false;
    }
  }

  return true;
}

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

    if (isJsonPrimitive(current)) {
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
  const result = tryCloneJsonValue(value);
  if (!result.ok) {
    throw new UnsupportedRuntimeValueError(
      "Cannot clone a cyclic or non-JSON runtime value as JSON.",
    );
  }
  return result.value as TValue;
}

export function tryCloneJsonValue(
  value: unknown,
): { ok: true; value: JsonValue } | { ok: false } {
  if (isJsonPrimitive(value)) {
    return { ok: true, value };
  }
  if (isPrimitiveJsonArray(value)) {
    return { ok: true, value: value.slice() };
  }

  let root: JsonValue | undefined;
  const active = new WeakSet<object>();
  type Frame =
    | {
        kind: "value";
        value: unknown;
        assign: (value: JsonValue) => void;
      }
    | { kind: "exit"; value: object };
  const stack: Frame[] = [{
    kind: "value",
    value,
    assign: (cloned) => {
      root = cloned;
    },
  }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }
    if (isJsonPrimitive(frame.value)) {
      frame.assign(frame.value);
      continue;
    }
    if (
      (!Array.isArray(frame.value) && !isPlainObject(frame.value)) ||
      active.has(frame.value)
    ) {
      return { ok: false };
    }

    active.add(frame.value);
    stack.push({ kind: "exit", value: frame.value });
    if (Array.isArray(frame.value)) {
      if (isPrimitiveJsonArray(frame.value)) {
        frame.assign(frame.value.slice());
        continue;
      }
      const cloned = new Array<JsonValue>(frame.value.length);
      frame.assign(cloned);
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: frame.value[index],
          assign: (child) => {
            cloned[index] = child;
          },
        });
      }
      continue;
    }

    const cloned: Record<string, JsonValue> = {};
    frame.assign(cloned);
    const keys = Object.keys(frame.value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({
        kind: "value",
        value: frame.value[key],
        assign: (child) => {
          setOwnEnumerableValue(cloned, key, child);
        },
      });
    }
  }

  return { ok: true, value: root! };
}

export function canonicalizeJsonValue(value: JsonValue): string {
  if (isPrimitiveJsonArray(value)) {
    return JSON.stringify(value);
  }

  const chunks: string[] = [];
  const active = new WeakSet<object>();
  type Frame =
    | { kind: "value"; value: JsonValue }
    | { kind: "token"; value: string }
    | { kind: "exit"; value: object };
  const stack: Frame[] = [{ kind: "value", value }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "token") {
      chunks.push(frame.value);
      continue;
    }
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }
    const current = frame.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      chunks.push(JSON.stringify(current));
      continue;
    }
    if (
      (!Array.isArray(current) && !isPlainObject(current)) ||
      active.has(current)
    ) {
      throw new UnsupportedRuntimeValueError(
        "Cannot canonicalize a cyclic or non-JSON runtime value as JSON.",
      );
    }

    active.add(current);
    stack.push({ kind: "exit", value: current });
    if (Array.isArray(current)) {
      if (isPrimitiveJsonArray(current)) {
        chunks.push(JSON.stringify(current));
        continue;
      }
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
    if (currentLeft === currentRight) {
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

  const clonedJson = tryCloneJsonValue(value);
  if (clonedJson.ok) {
    return clonedJson.value as TValue;
  }

  if (adapter?.codec) {
    const serialized = adapter.codec.serialize(value);
    const clonedSerialized = tryCloneJsonValue(serialized);
    if (!clonedSerialized.ok) {
      throw new UnsupportedRuntimeValueError(
        `Codec "${adapter.codec.codecId}" returned a non-JSON value from serialize().`,
        {
          details: { codecId: adapter.codec.codecId, pointer },
        },
      );
    }
    return adapter.codec.deserialize(clonedSerialized.value);
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
  const clonedJson = tryCloneJsonValue(value);
  if (clonedJson.ok) {
    return escapeCodecEnvelopeShapes(clonedJson.value);
  }

  const codec = adapter?.codec;
  if (!codec) {
    throw new MissingCodecError(
      "Cannot persist a non-JSON value without a registered codec.",
    );
  }
  if (codec.codecId === ESCAPED_JSON_CODEC_ID) {
    throw new UnsupportedRuntimeValueError(
      `Codec id "${ESCAPED_JSON_CODEC_ID}" is reserved for escaped JSON values.`,
      { details: { codecId: codec.codecId } },
    );
  }

  const serialized = codec.serialize(value);
  const clonedSerialized = tryCloneJsonValue(serialized);
  if (!clonedSerialized.ok) {
    throw new UnsupportedRuntimeValueError(
      `Codec "${codec.codecId}" returned a non-JSON value from serialize().`,
      {
        details: { codecId: codec.codecId },
      },
    );
  }

  return {
    $codec: codec.codecId,
    value: clonedSerialized.value,
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

export function isEscapedPersistedValue(
  value: PersistedValue,
): value is EscapedPersistedValue {
  return isEncodedValue(value) && value.$codec === ESCAPED_JSON_CODEC_ID;
}

function escapeCodecEnvelopeShapes(value: JsonValue): PersistedValue {
  let root: PersistedValue | undefined;
  const stack: Array<{
    value: JsonValue;
    assign: (value: PersistedValue) => void;
  }> = [{
    value,
    assign: (encoded) => {
      root = encoded;
    },
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (isEncodedValue(frame.value as PersistedValue)) {
      frame.assign({
        $codec: ESCAPED_JSON_CODEC_ID,
        value: frame.value,
      });
      continue;
    }
    if (frame.value === null || typeof frame.value !== "object") {
      frame.assign(frame.value);
      continue;
    }
    if (Array.isArray(frame.value)) {
      const encoded = new Array<PersistedValue>(frame.value.length);
      frame.assign(encoded);
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: frame.value[index]!,
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
        value: frame.value[key]!,
        assign: (child) => {
          setOwnEnumerableValue(encoded, key, child);
        },
      });
    }
  }

  return root!;
}

export function decodePersistedValue(
  value: PersistedValue,
  codecs: readonly ValueCodec[] = [],
): unknown {
  let root: unknown;
  const active = new WeakSet<object>();
  type Frame =
    | {
        kind: "value";
        value: PersistedValue;
        assign: (value: unknown) => void;
      }
    | { kind: "exit"; value: object };
  const stack: Frame[] = [{
    kind: "value",
    value,
    assign: (decoded) => {
      root = decoded;
    },
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }
    if (isEncodedValue(frame.value)) {
      const encoded = frame.value;
      if (isEscapedPersistedValue(encoded)) {
        frame.assign(cloneJsonValue(encoded.value));
        continue;
      }
      const codec = codecs.find(
        (candidate) => candidate.codecId === encoded.$codec,
      );
      if (!codec) {
        throw new MissingCodecError(
          `Codec "${encoded.$codec}" is not registered for persisted value decoding.`,
          { details: { codecId: encoded.$codec } },
        );
      }
      frame.assign(codec.deserialize(encoded.value));
      continue;
    }
    if (frame.value === null || typeof frame.value !== "object") {
      frame.assign(frame.value);
      continue;
    }
    if (active.has(frame.value)) {
      throw new UnsupportedRuntimeValueError(
        "Cannot decode a cyclic persisted value.",
      );
    }
    active.add(frame.value);
    stack.push({ kind: "exit", value: frame.value });

    if (Array.isArray(frame.value)) {
      const decoded = new Array<unknown>(frame.value.length);
      frame.assign(decoded);
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: frame.value[index]!,
          assign: (child) => {
            decoded[index] = child;
          },
        });
      }
      continue;
    }

    const decoded: Record<string, unknown> = {};
    frame.assign(decoded);
    const keys = Object.keys(frame.value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({
        kind: "value",
        value: frame.value[key]!,
        assign: (child) => {
          setOwnEnumerableValue(decoded, key, child);
        },
      });
    }
  }

  return root;
}
