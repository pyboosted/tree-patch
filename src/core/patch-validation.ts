import type {
  ChildPosition,
  Guard,
  NodeId,
  PatchOp,
  PersistedValue,
  SerializedPatchNode,
  TreePatch,
} from "./types.js";
import {
  AmbiguousPositionError,
  MalformedPatchError,
  UnsupportedPatchOperationError,
} from "./errors.js";
import { isEncodedValue, isJsonValue } from "../schema/adapters.js";
import { parseJsonPointer } from "../schema/pointers.js";
import { deepFreezePlainData, isPlainObject } from "./snapshot.js";

const validatedPreparedPatches = new WeakSet<object>();

function validatePersistedValueShape(value: unknown, location: string): void {
  if (isEncodedValue(value as PersistedValue) || isJsonValue(value)) {
    return;
  }

  throw new MalformedPatchError(`${location} must be JSON-serializable or an encoded persisted value.`, {
    details: { location },
  });
}

export function assertSerializedPatchNode(
  node: unknown,
  location: string,
  seenIds: Set<string>,
): asserts node is SerializedPatchNode {
  const stack: Array<{ node: unknown; location: string }> = [{ node, location }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (!frame.node || typeof frame.node !== "object" || Array.isArray(frame.node)) {
      throw new MalformedPatchError(
        `${frame.location} must be a serialized patch node object.`,
        { details: { location: frame.location } },
      );
    }

    const candidate = frame.node as Record<string, unknown>;
    if (typeof candidate.id !== "string") {
      throw new MalformedPatchError(`${frame.location}.id must be a string.`, {
        details: { location: frame.location },
      });
    }
    if (typeof candidate.type !== "string") {
      throw new MalformedPatchError(`${frame.location}.type must be a string.`, {
        details: { location: frame.location },
      });
    }
    if (!Object.hasOwn(candidate, "attrs")) {
      throw new MalformedPatchError(`${frame.location}.attrs is required.`, {
        details: { location: frame.location },
      });
    }
    if (!Array.isArray(candidate.children)) {
      throw new MalformedPatchError(`${frame.location}.children must be an array.`, {
        details: { location: frame.location },
      });
    }
    if (seenIds.has(candidate.id)) {
      throw new MalformedPatchError(
        `Serialized patch subtree at ${frame.location} reuses node id "${candidate.id}".`,
        {
          details: { location: frame.location, nodeId: candidate.id },
        },
      );
    }

    seenIds.add(candidate.id);
    validatePersistedValueShape(candidate.attrs, `${frame.location}.attrs`);
    for (let index = candidate.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: candidate.children[index],
        location: `child ${index} of serialized node "${candidate.id}"`,
      });
    }
  }
}

export function collectSerializedNodeIds(
  node: SerializedPatchNode,
  collected: NodeId[] = [],
): NodeId[] {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    collected.push(current.id);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      stack.push(current.children[index]!);
    }
  }
  return collected;
}

export function normalizePosition(
  position: unknown,
  location: string,
): ChildPosition | undefined {
  if (position === undefined) {
    return undefined;
  }

  if (!position || typeof position !== "object" || Array.isArray(position)) {
    throw new MalformedPatchError(`${location} must be an object when provided.`, {
      details: { location },
    });
  }

  const record = position as Record<string, unknown>;
  let key: string | undefined;
  let value: unknown;
  let definedCount = 0;
  for (const candidate of Object.keys(record)) {
    const candidateValue = record[candidate];
    if (candidateValue === undefined) {
      continue;
    }
    definedCount += 1;
    key = candidate;
    value = candidateValue;
  }
  if (definedCount !== 1 || key === undefined) {
    throw new AmbiguousPositionError(
      `${location} must contain exactly one of beforeId, afterId, atStart, or atEnd.`,
      {
        details: { location, providedKeys: Object.keys(record) },
      },
    );
  }
  switch (key) {
    case "beforeId":
      if (typeof value !== "string") {
        throw new MalformedPatchError(`${location}.beforeId must be a string.`, {
          details: { location },
        });
      }
      return { beforeId: value };
    case "afterId":
      if (typeof value !== "string") {
        throw new MalformedPatchError(`${location}.afterId must be a string.`, {
          details: { location },
        });
      }
      return { afterId: value };
    case "atStart":
      if (value !== true) {
        throw new MalformedPatchError(`${location}.atStart must be true when provided.`, {
          details: { location },
        });
      }
      return { atStart: true };
    case "atEnd":
      if (value !== true) {
        throw new MalformedPatchError(`${location}.atEnd must be true when provided.`, {
          details: { location },
        });
      }
      return { atEnd: true };
    default:
      throw new AmbiguousPositionError(
        `${location} contains unsupported key "${key}".`,
        {
          details: { location, key },
        },
      );
  }
}

function assertGuard(guard: unknown, location: string): asserts guard is Guard {
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) {
    throw new MalformedPatchError(`${location} must be a guard object.`, {
      details: { location },
    });
  }

  const candidate = guard as Record<string, unknown>;
  if (typeof candidate.kind !== "string") {
    throw new MalformedPatchError(`${location}.kind must be a string.`, {
      details: { location },
    });
  }

  switch (candidate.kind) {
    case "nodeExists":
    case "nodeAbsent":
      if (typeof candidate.nodeId !== "string") {
        throw new MalformedPatchError(`${location}.nodeId must be a string.`, {
          details: { location },
        });
      }
      return;
    case "nodeTypeIs":
      if (typeof candidate.nodeId !== "string" || typeof candidate.nodeType !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and nodeType.`, {
          details: { location },
        });
      }
      return;
    case "attrAbsent":
      if (typeof candidate.nodeId !== "string" || typeof candidate.path !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and path.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      return;
    case "attrEquals":
      if (typeof candidate.nodeId !== "string" || typeof candidate.path !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and path.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      validatePersistedValueShape(candidate.value, `${location}.value`);
      return;
    case "attrHash":
      if (
        typeof candidate.nodeId !== "string" ||
        typeof candidate.path !== "string" ||
        typeof candidate.hash !== "string"
      ) {
        throw new MalformedPatchError(`${location} must include string nodeId, path, and hash.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      return;
    case "subtreeHash":
      if (typeof candidate.nodeId !== "string" || typeof candidate.hash !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and hash.`, {
          details: { location },
        });
      }
      return;
    case "childOrderHash":
      if (
        typeof candidate.parentId !== "string" ||
        typeof candidate.hash !== "string"
      ) {
        throw new MalformedPatchError(
          `${location} must include string parentId and hash.`,
          { details: { location } },
        );
      }
      return;
    case "parentIs":
      if (
        typeof candidate.nodeId !== "string" ||
        (candidate.parentId !== null && typeof candidate.parentId !== "string")
      ) {
        throw new MalformedPatchError(`${location} must include string nodeId and string|null parentId.`, {
          details: { location },
        });
      }
      return;
    case "positionAtStart":
    case "positionAtEnd":
      if (typeof candidate.nodeId !== "string") {
        throw new MalformedPatchError(`${location}.nodeId must be a string.`, {
          details: { location },
        });
      }
      return;
    case "positionAfter":
      if (typeof candidate.nodeId !== "string" || typeof candidate.afterId !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and afterId.`, {
          details: { location },
        });
      }
      return;
    case "positionBefore":
      if (typeof candidate.nodeId !== "string" || typeof candidate.beforeId !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and beforeId.`, {
          details: { location },
        });
      }
      return;
    default:
      throw new UnsupportedPatchOperationError(`Unsupported guard kind "${candidate.kind}".`, {
        details: { location, kind: candidate.kind },
      });
  }
}

function assertPatchOp(op: unknown, index: number): asserts op is PatchOp {
  const location = `patch.ops[${index}]`;
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new MalformedPatchError(`${location} must be an operation object.`, {
      details: { location },
    });
  }

  const candidate = op as Record<string, unknown>;
  if (typeof candidate.kind !== "string") {
    throw new MalformedPatchError(`${location}.kind must be a string.`, {
      details: { location },
    });
  }
  if (typeof candidate.opId !== "string") {
    throw new MalformedPatchError(`${location}.opId must be a string.`, {
      details: { location },
    });
  }

  if (candidate.guards !== undefined) {
    if (!Array.isArray(candidate.guards)) {
      throw new MalformedPatchError(`${location}.guards must be an array when provided.`, {
        details: { location },
      });
    }
    candidate.guards.forEach((guard, guardIndex) => {
      assertGuard(guard, `${location}.guards[${guardIndex}]`);
    });
  }

  switch (candidate.kind) {
    case "setAttr":
      if (typeof candidate.nodeId !== "string" || typeof candidate.path !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and path.`, {
          details: { location },
        });
      }
      {
        const segments = parseJsonPointer(candidate.path);
        if (candidate.pathKinds !== undefined) {
          if (
            !Array.isArray(candidate.pathKinds) ||
            candidate.pathKinds.length !== segments.length
          ) {
            throw new MalformedPatchError(
              `${location}.pathKinds must describe every path segment as "property" or "index".`,
              { details: { location } },
            );
          }

          for (let pathIndex = 0; pathIndex < segments.length; pathIndex += 1) {
            const kind = candidate.pathKinds[pathIndex];
            if (kind !== "property" && kind !== "index") {
              throw new MalformedPatchError(
                `${location}.pathKinds must describe every path segment as "property" or "index".`,
                { details: { location, pathIndex } },
              );
            }
            if (
              kind === "index" &&
              !/^(0|[1-9]\d*)$/.test(segments[pathIndex]!)
            ) {
              throw new MalformedPatchError(
                `${location}.pathKinds[${pathIndex}] marks a non-index pointer segment as an array index.`,
                {
                  details: {
                    location,
                    pathIndex,
                    segment: segments[pathIndex],
                  },
                },
              );
            }
          }
        }
      }
      validatePersistedValueShape(candidate.value, `${location}.value`);
      return;
    case "removeAttr":
      if (typeof candidate.nodeId !== "string" || typeof candidate.path !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and path.`, {
          details: { location },
        });
      }
      parseJsonPointer(candidate.path);
      return;
    case "hideNode":
    case "showNode":
    case "removeNode":
      if (typeof candidate.nodeId !== "string") {
        throw new MalformedPatchError(`${location}.nodeId must be a string.`, {
          details: { location },
        });
      }
      return;
    case "insertNode":
      if (typeof candidate.parentId !== "string") {
        throw new MalformedPatchError(`${location}.parentId must be a string.`, {
          details: { location },
        });
      }
      normalizePosition(candidate.position, `${location}.position`);
      assertSerializedPatchNode(candidate.node, `${location}.node`, new Set<string>());
      return;
    case "moveNode":
      if (typeof candidate.nodeId !== "string" || typeof candidate.newParentId !== "string") {
        throw new MalformedPatchError(`${location} must include string nodeId and newParentId.`, {
          details: { location },
        });
      }
      normalizePosition(candidate.position, `${location}.position`);
      return;
    case "reorderChildren": {
      if (
        typeof candidate.parentId !== "string" ||
        !Array.isArray(candidate.childIds) ||
        candidate.childIds.some((childId) => typeof childId !== "string")
      ) {
        throw new MalformedPatchError(
          `${location} must include string parentId and a string childIds array.`,
          { details: { location } },
        );
      }
      if (new Set(candidate.childIds).size !== candidate.childIds.length) {
        throw new MalformedPatchError(
          `${location}.childIds must not contain duplicate node ids.`,
          { details: { location } },
        );
      }
      return;
    }
    case "replaceSubtree":
      if (typeof candidate.nodeId !== "string") {
        throw new MalformedPatchError(`${location}.nodeId must be a string.`, {
          details: { location },
        });
      }
      assertSerializedPatchNode(candidate.node, `${location}.node`, new Set<string>());
      if (candidate.node.id !== candidate.nodeId) {
        throw new MalformedPatchError(`${location}.node.id must equal ${location}.nodeId.`, {
          details: { location, nodeId: candidate.nodeId, replacementId: candidate.node.id },
        });
      }
      return;
    default:
      throw new UnsupportedPatchOperationError(`Unsupported patch operation kind "${candidate.kind}".`, {
        details: { location, kind: candidate.kind },
      });
  }
}

export function assertPatchEnvelope(patch: unknown): asserts patch is TreePatch {
  if (
    patch !== null &&
    typeof patch === "object" &&
    validatedPreparedPatches.has(patch)
  ) {
    return;
  }

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new MalformedPatchError("Patch must be an object.", {
      details: { patch },
    });
  }

  const candidate = patch as Record<string, unknown>;
  if (candidate.format !== "tree-patch/v1") {
    throw new MalformedPatchError('Patch format must be "tree-patch/v1".', {
      details: { format: candidate.format },
    });
  }
  if (typeof candidate.patchId !== "string") {
    throw new MalformedPatchError("Patch patchId must be a string.", {
      details: { patchId: candidate.patchId },
    });
  }
  if (candidate.baseRevision !== undefined && typeof candidate.baseRevision !== "string") {
    throw new MalformedPatchError("Patch baseRevision must be a string when provided.", {
      details: { baseRevision: candidate.baseRevision },
    });
  }
  if (
    candidate.metadata !== undefined &&
    (!isPlainObject(candidate.metadata) || !isJsonValue(candidate.metadata))
  ) {
    throw new MalformedPatchError(
      "Patch metadata must be a JSON-serializable object when provided.",
      { details: { metadata: candidate.metadata } },
    );
  }
  if (!Array.isArray(candidate.ops)) {
    throw new MalformedPatchError("Patch ops must be an array.", {
      details: { ops: candidate.ops },
    });
  }

  const seenOpIds = new Set<string>();
  candidate.ops.forEach((op, index) => {
    assertPatchOp(op, index);
    if (seenOpIds.has(op.opId)) {
      throw new MalformedPatchError(`Duplicate opId "${op.opId}" detected in patch.`, {
        details: { opId: op.opId },
      });
    }
    seenOpIds.add(op.opId);
  });
}

export function preparePatch(patch: TreePatch): TreePatch {
  if (validatedPreparedPatches.has(patch)) {
    return patch;
  }

  assertPatchEnvelope(patch);
  const prepared = deepFreezePlainData(
    structuredClone(patch),
  ) as TreePatch;
  validatedPreparedPatches.add(prepared);
  return prepared;
}
