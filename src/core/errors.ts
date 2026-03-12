export type TreePatchErrorCode =
  | "MALFORMED_TREE"
  | "DUPLICATE_ID"
  | "INVALID_ROOT"
  | "INVALID_POINTER"
  | "MISSING_CODEC"
  | "INVALID_SCHEMA"
  | "UNSUPPORTED_RUNTIME_VALUE";

export interface TreePatchErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class TreePatchError extends Error {
  readonly code: TreePatchErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: TreePatchErrorCode,
    message: string,
    options: TreePatchErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export class MalformedTreeError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("MALFORMED_TREE", message, options);
  }
}

export class DuplicateIdError extends TreePatchError {
  constructor(nodeId: string) {
    super("DUPLICATE_ID", `Duplicate node id "${nodeId}" detected.`, {
      details: { nodeId },
    });
  }
}

export class InvalidRootError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("INVALID_ROOT", message, options);
  }
}

export class InvalidPointerError extends TreePatchError {
  constructor(pointer: string, message: string) {
    super("INVALID_POINTER", message, {
      details: { pointer },
    });
  }
}

export class MissingCodecError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("MISSING_CODEC", message, options);
  }
}

export class InvalidSchemaError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("INVALID_SCHEMA", message, options);
  }
}

export class UnsupportedRuntimeValueError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("UNSUPPORTED_RUNTIME_VALUE", message, options);
  }
}
