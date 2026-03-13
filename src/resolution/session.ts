import { executePatchInternal } from "../core/apply.js";
import { diffTrees, rebasePatch } from "../core/diff.js";
import { InvalidResolutionInputError } from "../core/errors.js";
import type {
  ConflictResolutionDecision,
  ConflictResolutionOptions,
  ConflictResolutionSession as ConflictResolutionSessionContract,
  IndexedTree,
  NodeTypeMap,
  PatchConflict,
  PatchOp,
  RebaseResult,
  ResolutionBuildResult,
  TreePatch,
} from "../core/types.js";

interface ResolutionState<TTypes extends NodeTypeMap> {
  preview: IndexedTree<TTypes>;
  conflicts: readonly PatchConflict[];
  unresolvedConflicts: readonly PatchConflict[];
  replayConflicts: readonly PatchConflict[];
  appliedOpIds: readonly string[];
  skippedOpIds: readonly string[];
}

function stripGuardsFromOp(op: PatchOp): PatchOp {
  const { guards: _guards, ...rest } = op as PatchOp & { guards?: readonly unknown[] };
  return rest as PatchOp;
}

function cloneMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  return structuredClone(metadata);
}

class ConflictResolutionSessionController<TTypes extends NodeTypeMap>
  implements ConflictResolutionSessionContract<TTypes>
{
  readonly initialRebase: RebaseResult<TTypes>;

  private readonly includeHidden: boolean;
  private readonly patch: TreePatch;
  private readonly newBase: IndexedTree<TTypes>;
  private readonly options: ConflictResolutionOptions<TTypes>;
  private readonly opIds = new Set<string>();
  private readonly opOrder = new Map<string, number>();
  private readonly initialAppliedOpIds: ReadonlySet<string>;
  private readonly initialConflictByOpId = new Map<string, PatchConflict>();
  private readonly decisions = new Map<string, ConflictResolutionDecision>();
  private state: ResolutionState<TTypes>;

  constructor(
    oldBase: IndexedTree<TTypes>,
    newBase: IndexedTree<TTypes>,
    patch: TreePatch,
    options: ConflictResolutionOptions<TTypes>,
  ) {
    this.patch = patch;
    this.newBase = newBase;
    this.options = options;
    this.includeHidden = options.includeHidden ?? true;

    const sourceValidation = executePatchInternal(oldBase, patch, {
      mode: "preview",
      includeHidden: this.includeHidden,
      produceTree: false,
    });

    if (sourceValidation.conflicts.length > 0) {
      throw new InvalidResolutionInputError(
        `Conflict resolution requires a patch that applies cleanly to the original base; patch "${patch.patchId}" already conflicts with the provided old base.`,
        {
          details: {
            patchId: patch.patchId,
            conflicts: sourceValidation.conflicts,
          },
        },
      );
    }

    this.initialRebase = rebasePatch(oldBase, newBase, patch, {
      includeHidden: this.includeHidden,
    });

    patch.ops.forEach((op, index) => {
      this.opIds.add(op.opId);
      this.opOrder.set(op.opId, index);
    });

    this.initialAppliedOpIds = new Set(this.initialRebase.appliedOpIds);
    this.initialRebase.conflicts.forEach((conflict) => {
      this.initialConflictByOpId.set(conflict.opId, conflict);
    });

    this.state = this.recompute();
  }

  get preview(): IndexedTree<TTypes> {
    return this.state.preview;
  }

  get conflicts(): readonly PatchConflict[] {
    return this.state.conflicts;
  }

  get unresolvedConflicts(): readonly PatchConflict[] {
    return this.state.unresolvedConflicts;
  }

  get replayConflicts(): readonly PatchConflict[] {
    return this.state.replayConflicts;
  }

  get appliedOpIds(): readonly string[] {
    return this.state.appliedOpIds;
  }

  get skippedOpIds(): readonly string[] {
    return this.state.skippedOpIds;
  }

  getDecision(opId: string): ConflictResolutionDecision | undefined {
    return this.decisions.get(opId);
  }

  takeBase(opId: string): this {
    this.ensureKnownOpId(opId);
    this.decisions.set(opId, "takeBase");
    this.state = this.recompute();
    return this;
  }

  keepLocal(opId: string): this {
    this.ensureKnownOpId(opId);
    this.decisions.set(opId, "keepLocal");
    this.state = this.recompute();
    return this;
  }

  reset(opId: string): this {
    this.ensureKnownOpId(opId);
    this.decisions.delete(opId);
    this.state = this.recompute();
    return this;
  }

  takeBaseAll(): this {
    this.conflicts.forEach((conflict) => {
      this.decisions.set(conflict.opId, "takeBase");
    });
    this.state = this.recompute();
    return this;
  }

  keepLocalAll(): this {
    this.conflicts.forEach((conflict) => {
      this.decisions.set(conflict.opId, "keepLocal");
    });
    this.state = this.recompute();
    return this;
  }

  build(): ResolutionBuildResult<TTypes> {
    if (this.state.conflicts.length > 0) {
      return {
        status: "unresolved",
        preview: this.state.preview,
        conflicts: this.state.conflicts,
        unresolvedConflicts: this.state.unresolvedConflicts,
        replayConflicts: this.state.replayConflicts,
        appliedOpIds: this.state.appliedOpIds,
        skippedOpIds: this.state.skippedOpIds,
      };
    }

    const resolvedPatch = diffTrees(this.newBase, this.state.preview, this.options.diff);
    resolvedPatch.patchId = this.patch.patchId;
    if (this.newBase.revision !== undefined) {
      resolvedPatch.baseRevision = this.newBase.revision;
    } else {
      delete resolvedPatch.baseRevision;
    }

    const metadata = cloneMetadata(this.patch.metadata);
    if (metadata !== undefined) {
      resolvedPatch.metadata = metadata;
    } else {
      delete resolvedPatch.metadata;
    }

    return {
      status: "resolved",
      resolvedPatch,
      preview: this.state.preview,
      appliedOpIds: this.state.appliedOpIds,
      skippedOpIds: this.state.skippedOpIds,
    };
  }

  private ensureKnownOpId(opId: string): void {
    if (!this.opIds.has(opId)) {
      throw new InvalidResolutionInputError(
        `Resolution session does not know operation "${opId}".`,
        {
          details: { opId, patchId: this.patch.patchId },
        },
      );
    }
  }

  private recompute(): ResolutionState<TTypes> {
    const replayOps: PatchOp[] = [];
    for (const op of this.patch.ops) {
      if (!this.shouldIncludeOp(op.opId)) {
        continue;
      }
      replayOps.push(stripGuardsFromOp(op));
    }

    const replayPatch: TreePatch = {
      format: "tree-patch/v1",
      patchId: this.patch.patchId,
      ...(this.newBase.revision !== undefined ? { baseRevision: this.newBase.revision } : {}),
      ...(this.patch.metadata !== undefined ? { metadata: cloneMetadata(this.patch.metadata)! } : {}),
      ops: replayOps,
    };

    const execution = executePatchInternal(this.newBase, replayPatch, {
      mode: "preview",
      includeHidden: this.includeHidden,
      produceTree: true,
    });

    const preview = execution.tree ?? this.newBase;
    const unresolvedConflicts = this.patch.ops
      .map((op) => this.initialConflictByOpId.get(op.opId))
      .filter((conflict): conflict is PatchConflict =>
        conflict !== undefined && this.decisions.get(conflict.opId) === undefined,
      );
    const replayConflicts = this.sortConflicts(execution.conflicts);
    const conflicts = this.sortConflicts([...unresolvedConflicts, ...replayConflicts]);
    const appliedOpIds = [...execution.appliedOpIds];
    const appliedSet = new Set(appliedOpIds);
    const skippedOpIds = this.patch.ops
      .map((op) => op.opId)
      .filter((opId) => !appliedSet.has(opId));

    return {
      preview,
      conflicts,
      unresolvedConflicts,
      replayConflicts,
      appliedOpIds,
      skippedOpIds,
    };
  }

  private shouldIncludeOp(opId: string): boolean {
    const decision = this.decisions.get(opId);
    if (decision === "takeBase") {
      return false;
    }

    if (this.initialAppliedOpIds.has(opId)) {
      return true;
    }

    return decision === "keepLocal";
  }

  private sortConflicts(conflicts: readonly PatchConflict[]): PatchConflict[] {
    return [...conflicts].sort((left, right) => {
      const leftOrder = this.opOrder.get(left.opId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = this.opOrder.get(right.opId) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
  }
}

export function createResolutionSession<TTypes extends NodeTypeMap>(
  oldBase: IndexedTree<TTypes>,
  newBase: IndexedTree<TTypes>,
  patch: TreePatch,
  options: ConflictResolutionOptions<TTypes> = {},
): ConflictResolutionSessionContract<TTypes> {
  return new ConflictResolutionSessionController(oldBase, newBase, patch, options);
}
