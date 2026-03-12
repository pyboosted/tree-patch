import type { AttrPath, JsonPointer } from "../core/types.js";
import { InvalidPointerError } from "../core/errors.js";

export interface PointerResolutionSuccess {
  ok: true;
  pointer: JsonPointer;
  segments: readonly string[];
  path: readonly (string | number)[];
  parent: unknown;
  key: string | number | null;
  value: unknown;
}

export interface PointerResolutionFailure {
  ok: false;
  pointer: JsonPointer;
  segments: readonly string[];
  path: readonly (string | number)[];
  reason: "Missing" | "NonContainer" | "InvalidArrayIndex";
  parent: unknown;
  key: string | number | null;
}

export type PointerResolution = PointerResolutionSuccess | PointerResolutionFailure;

const CANONICAL_ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function encodePointerSegment(segment: string | number): string {
  if (typeof segment === "number") {
    if (!Number.isInteger(segment) || segment < 0) {
      throw new InvalidPointerError(
        String(segment),
        `Pointer path segment "${segment}" must be a non-negative integer.`,
      );
    }

    return String(segment);
  }

  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function decodePointerSegment(segment: string, pointer: string): string {
  let decoded = "";

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char !== "~") {
      decoded += char;
      continue;
    }

    const next = segment[index + 1];
    if (next === "0") {
      decoded += "~";
      index += 1;
      continue;
    }

    if (next === "1") {
      decoded += "/";
      index += 1;
      continue;
    }

    throw new InvalidPointerError(
      pointer,
      `Pointer "${pointer}" contains an invalid escape sequence.`,
    );
  }

  return decoded;
}

export function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }

  if (!pointer.startsWith("/")) {
    throw new InvalidPointerError(
      pointer,
      `Pointer "${pointer}" must be empty or start with "/".`,
    );
  }

  return pointer
    .slice(1)
    .split("/")
    .map((segment) => decodePointerSegment(segment, pointer));
}

export function isCanonicalArrayIndexToken(segment: string): boolean {
  return CANONICAL_ARRAY_INDEX.test(segment);
}

export function pathToPointer<TValue>(path: AttrPath<TValue>): JsonPointer;
export function pathToPointer(path: readonly (string | number)[]): JsonPointer {
  if (path.length === 0) {
    return "";
  }

  return `/${path.map(encodePointerSegment).join("/")}`;
}

export function pointerToPath(pointer: JsonPointer): readonly (string | number)[] {
  return parseJsonPointer(pointer).map((segment) =>
    isCanonicalArrayIndexToken(segment) ? Number(segment) : segment,
  );
}

export function resolvePointer(target: unknown, pointer: JsonPointer): PointerResolution {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) {
    return {
      ok: true,
      pointer,
      segments,
      path: [],
      parent: null,
      key: null,
      value: target,
    };
  }

  let current: unknown = target;
  let parent: unknown = null;
  let key: string | number | null = null;
  const path: (string | number)[] = [];

  for (const segment of segments) {
    parent = current;

    if (Array.isArray(current)) {
      if (!isCanonicalArrayIndexToken(segment)) {
        return {
          ok: false,
          pointer,
          segments,
          path,
          reason: "InvalidArrayIndex",
          parent,
          key: segment,
        };
      }

      const index = Number(segment);
      if (index < 0 || index >= current.length) {
        return {
          ok: false,
          pointer,
          segments,
          path,
          reason: "InvalidArrayIndex",
          parent,
          key: index,
        };
      }

      key = index;
      path.push(index);
      current = current[index];
      continue;
    }

    if (current !== null && typeof current === "object") {
      key = segment;
      path.push(segment);

      if (!(segment in current)) {
        return {
          ok: false,
          pointer,
          segments,
          path,
          reason: "Missing",
          parent,
          key,
        };
      }

      current = (current as Record<string, unknown>)[segment];
      continue;
    }

    return {
      ok: false,
      pointer,
      segments,
      path,
      reason: "NonContainer",
      parent,
      key,
    };
  }

  return {
    ok: true,
    pointer,
    segments,
    path,
    parent,
    key,
    value: current,
  };
}
