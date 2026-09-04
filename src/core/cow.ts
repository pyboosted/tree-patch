export interface MutableMapLike<TKey, TValue> extends ReadonlyMap<TKey, TValue> {
  set(key: TKey, value: TValue): this;
  delete(key: TKey): boolean;
  clear(): void;
}

export interface MutableSetLike<TValue> extends ReadonlySet<TValue> {
  add(value: TValue): this;
  delete(value: TValue): boolean;
  clear(): void;
}

class CopyOnWriteMap<TKey, TValue> implements MutableMapLike<TKey, TValue> {
  private readonly writes = new Map<TKey, TValue>();
  private readonly deletes = new Set<TKey>();
  private cleared = false;
  private storesUndefined = false;
  readonly layerDepth: number;

  constructor(private readonly base: ReadonlyMap<TKey, TValue>) {
    this.layerDepth =
      base instanceof CopyOnWriteMap
        ? base.layerDepth + 1
        : 1;
  }

  get size(): number {
    if (this.cleared) {
      return this.writes.size;
    }
    let size = this.base.size;
    for (const key of this.deletes) {
      if (this.base.has(key)) {
        size -= 1;
      }
    }
    for (const key of this.writes.keys()) {
      if (!this.base.has(key)) {
        size += 1;
      }
    }
    return size;
  }

  clear(): void {
    this.writes.clear();
    this.deletes.clear();
    this.cleared = true;
  }

  delete(key: TKey): boolean {
    const had = this.has(key);
    this.writes.delete(key);

    if (!this.cleared) {
      // Keep a tombstone even when the key is currently absent. Cache maps may
      // safely grow in an immutable base snapshot after this layer is created.
      this.deletes.add(key);
    }

    return had;
  }

  forEach(
    callbackfn: (value: TValue, key: TKey, map: ReadonlyMap<TKey, TValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  get(key: TKey): TValue | undefined {
    // Reads on lightly patched snapshots mostly miss this layer; resolve the
    // common case with one lookup per layer instead of has() + get().
    const written = this.writes.get(key);
    if (
      written !== undefined ||
      (this.storesUndefined && this.writes.has(key))
    ) {
      return written;
    }

    if (this.cleared || (this.deletes.size !== 0 && this.deletes.has(key))) {
      return undefined;
    }

    return this.base.get(key);
  }

  has(key: TKey): boolean {
    if (this.writes.has(key)) {
      return true;
    }

    if (this.cleared || this.deletes.has(key)) {
      return false;
    }

    return this.base.has(key);
  }

  set(key: TKey, value: TValue): this {
    if (value === undefined) {
      this.storesUndefined = true;
    }
    this.writes.set(key, value);
    if (this.deletes.size !== 0) {
      this.deletes.delete(key);
    }
    return this;
  }

  *entries(): MapIterator<[TKey, TValue]> {
    if (!this.cleared) {
      for (const [key, value] of this.base.entries()) {
        if (!this.deletes.has(key)) {
          yield [key, this.writes.has(key) ? this.writes.get(key)! : value];
        }
      }
    }

    for (const [key, value] of this.writes.entries()) {
      if (this.cleared || !this.base.has(key)) {
        yield [key, value];
      }
    }
  }

  *keys(): MapIterator<TKey> {
    for (const [key] of this.entries()) {
      yield key;
    }
  }

  *values(): MapIterator<TValue> {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  [Symbol.iterator](): MapIterator<[TKey, TValue]> {
    return this.entries();
  }

  materialize(): Map<TKey, TValue> {
    const materialized = this.cleared
      ? new Map<TKey, TValue>()
      : new Map(this.base);
    for (const key of this.deletes) {
      materialized.delete(key);
    }
    for (const [key, value] of this.writes) {
      materialized.set(key, value);
    }
    return materialized;
  }

  shouldCompact(): boolean {
    const changes = this.writes.size + this.deletes.size;
    return (
      this.cleared ||
      this.layerDepth >= 8 ||
      changes > Math.max(1_024, this.base.size / 2)
    );
  }

  ensureMutableValue(
    key: TKey,
    cloneValue: (current: TValue | undefined) => TValue,
  ): TValue {
    if (this.writes.has(key)) {
      return this.writes.get(key)!;
    }

    const next = cloneValue(this.get(key));
    this.set(key, next);
    return next;
  }

  readonly [Symbol.toStringTag] = "Map";
}

class CopyOnWriteSet<TValue> implements MutableSetLike<TValue> {
  private readonly adds = new Set<TValue>();
  private readonly deletes = new Set<TValue>();
  private cleared = false;
  readonly layerDepth: number;

  constructor(private readonly base: ReadonlySet<TValue>) {
    this.layerDepth =
      base instanceof CopyOnWriteSet
        ? base.layerDepth + 1
        : 1;
  }

  get size(): number {
    if (this.cleared) {
      return this.adds.size;
    }
    let size = this.base.size;
    for (const value of this.deletes) {
      if (this.base.has(value)) {
        size -= 1;
      }
    }
    for (const value of this.adds) {
      if (!this.base.has(value)) {
        size += 1;
      }
    }
    return size;
  }

  add(value: TValue): this {
    this.adds.add(value);
    this.deletes.delete(value);
    return this;
  }

  clear(): void {
    this.adds.clear();
    this.deletes.clear();
    this.cleared = true;
  }

  delete(value: TValue): boolean {
    const had = this.has(value);
    this.adds.delete(value);

    if (!this.cleared) {
      this.deletes.add(value);
    }

    return had;
  }

  forEach(
    callbackfn: (value: TValue, value2: TValue, set: ReadonlySet<TValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.values()) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  has(value: TValue): boolean {
    if (this.adds.has(value)) {
      return true;
    }

    if (this.cleared || this.deletes.has(value)) {
      return false;
    }

    return this.base.has(value);
  }

  *entries(): SetIterator<[TValue, TValue]> {
    for (const value of this.values()) {
      yield [value, value];
    }
  }

  *keys(): SetIterator<TValue> {
    yield* this.values();
  }

  *values(): SetIterator<TValue> {
    if (!this.cleared) {
      for (const value of this.base.values()) {
        if (!this.deletes.has(value)) {
          yield value;
        }
      }
    }

    for (const value of this.adds.values()) {
      if (this.cleared || !this.base.has(value)) {
        yield value;
      }
    }
  }

  [Symbol.iterator](): SetIterator<TValue> {
    return this.values();
  }

  materialize(): Set<TValue> {
    const materialized = this.cleared
      ? new Set<TValue>()
      : new Set(this.base);
    for (const value of this.deletes) {
      materialized.delete(value);
    }
    for (const value of this.adds) {
      materialized.add(value);
    }
    return materialized;
  }

  shouldCompact(): boolean {
    const changes = this.adds.size + this.deletes.size;
    return (
      this.cleared ||
      this.layerDepth >= 8 ||
      changes > Math.max(1_024, this.base.size / 2)
    );
  }

  readonly [Symbol.toStringTag] = "Set";
}

export function createCopyOnWriteMap<TKey, TValue>(
  base: ReadonlyMap<TKey, TValue>,
): MutableMapLike<TKey, TValue> {
  return new CopyOnWriteMap(base);
}

export function createCopyOnWriteSet<TValue>(
  base: ReadonlySet<TValue>,
): MutableSetLike<TValue> {
  return new CopyOnWriteSet(base);
}

export function ensureMutableMapValue<TKey, TValue>(
  map: MutableMapLike<TKey, TValue>,
  key: TKey,
  cloneValue: (current: TValue | undefined) => TValue,
): TValue {
  if (map instanceof CopyOnWriteMap) {
    return map.ensureMutableValue(key, cloneValue);
  }

  const current = map.get(key);
  if (current !== undefined || map.has(key)) {
    return current as TValue;
  }

  const next = cloneValue(undefined);
  map.set(key, next);
  return next;
}

export function materializeMap<TKey, TValue>(
  map: ReadonlyMap<TKey, TValue>,
): Map<TKey, TValue> {
  if (map instanceof CopyOnWriteMap) {
    return map.materialize();
  }

  return new Map(map);
}

export function materializeSet<TValue>(
  set: ReadonlySet<TValue>,
): Set<TValue> {
  if (set instanceof CopyOnWriteSet) {
    return set.materialize();
  }

  return new Set(set);
}

export function finalizeMap<TKey, TValue>(
  map: MutableMapLike<TKey, TValue>,
): MutableMapLike<TKey, TValue> {
  return map instanceof CopyOnWriteMap && map.shouldCompact()
    ? map.materialize()
    : map;
}

export function finalizeSet<TValue>(
  set: MutableSetLike<TValue>,
): MutableSetLike<TValue> {
  return set instanceof CopyOnWriteSet && set.shouldCompact()
    ? set.materialize()
    : set;
}
