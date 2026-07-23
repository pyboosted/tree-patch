import type { NodeId } from "./types.js";
import {
  createCopyOnWriteMap,
  finalizeMap,
  type MutableMapLike,
} from "./cow.js";

const HASH_LANES = 4;
const LANE_HEX_LENGTH = 8;
const LANE_SEEDS = [
  0x9e3779b9,
  0x85ebca6b,
  0xc2b2ae35,
  0x27d4eb2f,
] as const;

function toHex32(value: number): string {
  return (value >>> 0).toString(16).padStart(LANE_HEX_LENGTH, "0");
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function hashLane(hash: string, lane: number): number {
  const versionPrefix = /^h\d+:/.exec(hash)?.[0].length ?? 0;
  const offset =
    versionPrefix +
    lane * LANE_HEX_LENGTH;
  const parsed = Number.parseInt(
    hash.slice(offset, offset + LANE_HEX_LENGTH),
    16,
  );
  return Number.isNaN(parsed) ? mix32(hash.length + lane) : parsed >>> 0;
}

function contribution(hash: string, index: number, lane: number): number {
  const weight = mix32(index + LANE_SEEDS[lane]!) | 1;
  return Math.imul(hashLane(hash, lane) ^ LANE_SEEDS[lane]!, weight) >>> 0;
}

export class ChildHashAggregate {
  private updates: MutableMapLike<number, string>;

  private constructor(
    readonly childIds: readonly NodeId[],
    private readonly baseHashes: readonly string[],
    private readonly lanes: number[],
    updates: MutableMapLike<number, string>,
  ) {
    this.updates = updates;
  }

  static build(
    childIds: readonly NodeId[],
    childHashes: readonly string[],
  ): ChildHashAggregate {
    const lanes = new Array<number>(HASH_LANES).fill(0);
    for (let index = 0; index < childHashes.length; index += 1) {
      const hash = childHashes[index]!;
      for (let lane = 0; lane < HASH_LANES; lane += 1) {
        lanes[lane] = (
          lanes[lane]! + contribution(hash, index, lane)
        ) >>> 0;
      }
    }
    return new ChildHashAggregate(
      childIds,
      childHashes,
      lanes,
      new Map(),
    );
  }

  fork(): ChildHashAggregate {
    return new ChildHashAggregate(
      this.childIds,
      this.baseHashes,
      [...this.lanes],
      createCopyOnWriteMap(this.updates),
    );
  }

  matches(childIds: readonly NodeId[]): boolean {
    return this.childIds === childIds;
  }

  get(index: number): string | undefined {
    return this.updates.get(index) ?? this.baseHashes[index];
  }

  update(index: number, hash: string): void {
    const previous = this.get(index);
    if (previous === undefined || previous === hash) {
      return;
    }

    for (let lane = 0; lane < HASH_LANES; lane += 1) {
      this.lanes[lane] = (
        this.lanes[lane]! -
        contribution(previous, index, lane) +
        contribution(hash, index, lane)
      ) >>> 0;
    }
    this.updates.set(index, hash);
    this.updates = finalizeMap(this.updates);
  }

  digest(): string {
    return this.lanes.map(toHex32).join("");
  }
}
