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
import { UnsupportedRuntimeValueError } from "../core/errors.js";
import { cloneRuntimeValue, tryCloneJsonValue } from "./adapters.js";
import type { CompiledTreeSchema } from "./schema.js";
import { getNodeRuntimeSpec } from "./schema.js";

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
  if (getNodeRuntimeSpec(schema, nodeType).adapters.size === 0) {
    // Plain-JSON node types need no per-pointer adapter lookups; fall through
    // to the pointer-tracking walk only to produce exact errors.
    const fast = tryCloneJsonValue(value);
    if (fast.ok) {
      return fast.value;
    }
  }

  const adapters = getNodeRuntimeSpec(schema, nodeType).adapters;
  let root: unknown;
  const active = new WeakSet<object>();
  type Frame =
    | {
        kind: "value";
        value: unknown;
        pointer: JsonPointer;
        assign: (next: unknown) => void;
      }
    | { kind: "exit"; value: object };
  const stack: Frame[] = [{
    kind: "value",
    value,
    pointer,
    assign: (next) => {
      root = next;
    },
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }

    const adapter = adapters.get(frame.pointer);
    if (adapter) {
      frame.assign(cloneRuntimeValue(frame.value, adapter, frame.pointer));
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
      frame.assign(cloneRuntimeValue(frame.value, undefined, frame.pointer));
      continue;
    }
    if (active.has(frame.value)) {
      throw new UnsupportedRuntimeValueError(
        `Cyclic runtime value at pointer "${frame.pointer}" is not supported.`,
        { details: { pointer: frame.pointer } },
      );
    }

    active.add(frame.value);
    stack.push({ kind: "exit", value: frame.value });
    if (Array.isArray(frame.value)) {
      const clone: unknown[] = new Array(frame.value.length);
      frame.assign(clone);
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: frame.value[index],
          pointer: joinPointer(frame.pointer, index),
          assign: (next) => {
            clone[index] = next;
          },
        });
      }
      continue;
    }

    const clone: Record<string, unknown> = {};
    frame.assign(clone);
    const keys = Object.keys(frame.value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({
        kind: "value",
        value: frame.value[key],
        pointer: joinPointer(frame.pointer, key),
        assign: (next) => {
          setOwnEnumerableValue(clone, key, next);
        },
      });
    }
  }

  return root;
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
