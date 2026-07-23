import { executePatchInternal } from "../core/apply.js";
import { diffTrees, rebasePatch } from "../core/diff.js";
import { InvalidResolutionInputError } from "../core/errors.js";
import type {
  ConflictResolutionDecision,
  ConflictResolutionOptions,
  ConflictResolutionSession as ConflictResolutionSessionContract,
  IndexedTree,
  JsonObject,
  NodeTypeMap,
  PatchConflict,
  PatchOp,
  RebaseResult,
  ResolutionBuildResult,
  TreePatch,
} from "../core/types.js";
import { cloneJsonValue } from "../schema/adapters.js";

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
  metadata?: Readonly<JsonObject>,
): JsonObject | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  return cloneJsonValue(metadata as JsonObject);
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
  private stateDirty = false;

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

    const initialConflicts = this.sortConflicts(this.initialRebase.conflicts);
    this.state = {
      preview: this.initialRebase.preview ?? newBase,
      conflicts: initialConflicts,
      unresolvedConflicts: initialConflicts,
      replayConflicts: [],
      appliedOpIds: [...this.initialRebase.appliedOpIds],
      skippedOpIds: [...this.initialRebase.skippedOpIds],
    };
  }

  get preview(): IndexedTree<TTypes> {
    return this.currentState().preview;
  }

  get conflicts(): readonly PatchConflict[] {
    return this.currentState().conflicts;
  }

  get unresolvedConflicts(): readonly PatchConflict[] {
    return this.currentState().unresolvedConflicts;
  }

  get replayConflicts(): readonly PatchConflict[] {
    return this.currentState().replayConflicts;
  }

  get appliedOpIds(): readonly string[] {
    return this.currentState().appliedOpIds;
  }

  get skippedOpIds(): readonly string[] {
    return this.currentState().skippedOpIds;
  }

  getDecision(opId: string): ConflictResolutionDecision | undefined {
    return this.decisions.get(opId);
  }

  takeBase(opId: string): this {
    this.ensureKnownOpId(opId);
    this.decisions.set(opId, "takeBase");
    this.stateDirty = true;
    return this;
  }

  keepLocal(opId: string): this {
    this.ensureKnownOpId(opId);
    this.decisions.set(opId, "keepLocal");
    this.stateDirty = true;
    return this;
  }

  reset(opId: string): this {
    this.ensureKnownOpId(opId);
    this.decisions.delete(opId);
    this.stateDirty = true;
    return this;
  }

  takeBaseAll(): this {
    this.currentState().conflicts.forEach((conflict) => {
      this.decisions.set(conflict.opId, "takeBase");
    });
    this.stateDirty = true;
    return this;
  }

  keepLocalAll(): this {
    this.currentState().conflicts.forEach((conflict) => {
      this.decisions.set(conflict.opId, "keepLocal");
    });
    this.stateDirty = true;
    return this;
  }

  build(): ResolutionBuildResult<TTypes> {
    const state = this.currentState();
    if (state.conflicts.length > 0) {
      return {
        status: "unresolved",
        preview: state.preview,
        conflicts: state.conflicts,
        unresolvedConflicts: state.unresolvedConflicts,
        replayConflicts: state.replayConflicts,
        appliedOpIds: state.appliedOpIds,
        skippedOpIds: state.skippedOpIds,
      };
    }

    const resolvedPatch = diffTrees(this.newBase, state.preview, this.options.diff);
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
      preview: state.preview,
      appliedOpIds: state.appliedOpIds,
      skippedOpIds: state.skippedOpIds,
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

  private currentState(): ResolutionState<TTypes> {
    if (this.stateDirty) {
      this.state = this.recompute();
      this.stateDirty = false;
    }
    return this.state;
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
