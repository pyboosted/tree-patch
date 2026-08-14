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
const HEX_BYTE = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, "0"),
);

function toHex32(value: number): string {
  return (
    HEX_BYTE[(value >>> 24) & 0xff]! +
    HEX_BYTE[(value >>> 16) & 0xff]! +
    HEX_BYTE[(value >>> 8) & 0xff]! +
    HEX_BYTE[value & 0xff]!
  );
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function versionPrefixLength(hash: string): number {
  if (hash.charCodeAt(0) !== 104 /* h */) {
    return 0;
  }

  let index = 1;
  const length = hash.length;
  while (index < length) {
    const code = hash.charCodeAt(index);
    if (code < 48 || code > 57) {
      break;
    }
    index += 1;
  }

  return hash.charCodeAt(index) === 58 /* : */ ? index + 1 : 0;
}

function parseHex8(hash: string, offset: number): number {
  let value = 0;
  for (let index = 0; index < LANE_HEX_LENGTH; index += 1) {
    const code = hash.charCodeAt(offset + index);
    const digit = code <= 57 ? code - 48 : (code | 32) - 87;
    if (digit < 0 || digit > 15) {
      return Number.NaN;
    }
    value = (value << 4) | digit;
  }
  return value >>> 0;
}

function hashLaneValue(hash: string, offset: number, lane: number): number {
  const parsed = parseHex8(hash, offset + lane * LANE_HEX_LENGTH);
  return Number.isNaN(parsed) ? mix32(hash.length + lane) : parsed;
}

function contributionFromLane(
  laneValue: number,
  index: number,
  lane: number,
): number {
  const weight = mix32(index + LANE_SEEDS[lane]!) | 1;
  return Math.imul(laneValue ^ LANE_SEEDS[lane]!, weight) >>> 0;
}

function addHashContribution(
  lanes: number[],
  hash: string,
  index: number,
  sign: 1 | -1,
): void {
  const offset = versionPrefixLength(hash);
  for (let lane = 0; lane < HASH_LANES; lane += 1) {
    lanes[lane] = (
      lanes[lane]! +
      sign * contributionFromLane(hashLaneValue(hash, offset, lane), index, lane)
    ) >>> 0;
  }
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
      addHashContribution(lanes, childHashes[index]!, index, 1);
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

    addHashContribution(this.lanes, previous, index, -1);
    addHashContribution(this.lanes, hash, index, 1);
    this.updates.set(index, hash);
    this.updates = finalizeMap(this.updates);
  }

  digest(): string {
    return (
      toHex32(this.lanes[0]!) +
      toHex32(this.lanes[1]!) +
      toHex32(this.lanes[2]!) +
      toHex32(this.lanes[3]!)
    );
  }
}
