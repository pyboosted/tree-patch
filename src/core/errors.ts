export type TreePatchErrorCode =
  | "MALFORMED_TREE"
  | "MALFORMED_PATCH"
  | "DUPLICATE_ID"
  | "INVALID_ROOT"
  | "INVALID_POINTER"
  | "MISSING_CODEC"
  | "MISSING_PATCH_ID"
  | "INVALID_SCHEMA"
  | "UNSUPPORTED_RUNTIME_VALUE"
  | "AMBIGUOUS_POSITION"
  | "UNSUPPORTED_PATCH_OPERATION"
  | "UNSUPPORTED_TRANSFORM"
  | "EDITOR_NODE_MISSING"
  | "EDITOR_NODE_TYPE_MISMATCH";

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

export class MalformedPatchError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("MALFORMED_PATCH", message, options);
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

export class MissingPatchIdError extends TreePatchError {
  constructor() {
    super("MISSING_PATCH_ID", "Patch builder requires an explicit patchId before build().");
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

export class AmbiguousPositionError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("AMBIGUOUS_POSITION", message, options);
  }
}

export class UnsupportedPatchOperationError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("UNSUPPORTED_PATCH_OPERATION", message, options);
  }
}

export class UnsupportedTransformError extends TreePatchError {
  constructor(message: string, options: TreePatchErrorOptions = {}) {
    super("UNSUPPORTED_TRANSFORM", message, options);
  }
}

export class EditorNodeMissingError extends TreePatchError {
  constructor(nodeId: string) {
    super("EDITOR_NODE_MISSING", `Editor node "${nodeId}" does not exist in the current builder state.`, {
      details: { nodeId },
    });
  }
}

export class EditorNodeTypeMismatchError extends TreePatchError {
  constructor(nodeId: string, expectedType: string, actualType: string) {
    super(
      "EDITOR_NODE_TYPE_MISMATCH",
      `Editor node "${nodeId}" was claimed as "${expectedType}" but is actually "${actualType}".`,
      {
        details: { nodeId, expectedType, actualType },
      },
    );
  }
}
