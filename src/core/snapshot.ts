class ReadonlyMapView<TKey, TValue, TViewValue> implements ReadonlyMap<TKey, TViewValue> {
  readonly #map: ReadonlyMap<TKey, TValue>;
  readonly #mapValue: (value: TValue) => TViewValue;

  constructor(
    map: ReadonlyMap<TKey, TValue>,
    mapValue: (value: TValue) => TViewValue,
  ) {
    this.#map = map;
    this.#mapValue = mapValue;
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: TKey): TViewValue | undefined {
    const value = this.#map.get(key);
    if (value === undefined && !this.#map.has(key)) {
      return undefined;
    }

    return this.#mapValue(value as TValue);
  }

  has(key: TKey): boolean {
    return this.#map.has(key);
  }

  forEach(
    callbackfn: (value: TViewValue, key: TKey, map: ReadonlyMap<TKey, TViewValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#map) {
      callbackfn.call(thisArg, this.#mapValue(value), key, this);
    }
  }

  *entries(): MapIterator<[TKey, TViewValue]> {
    for (const [key, value] of this.#map) {
      yield [key, this.#mapValue(value)];
    }
  }

  *keys(): MapIterator<TKey> {
    yield* this.#map.keys();
  }

  *values(): MapIterator<TViewValue> {
    for (const value of this.#map.values()) {
      yield this.#mapValue(value);
    }
  }

  [Symbol.iterator](): MapIterator<[TKey, TViewValue]> {
    return this.entries();
  }

  set(): never {
    throw new TypeError('Cannot call "set" on a read-only Map view.');
  }

  delete(): never {
    throw new TypeError('Cannot call "delete" on a read-only Map view.');
  }

  clear(): never {
    throw new TypeError('Cannot call "clear" on a read-only Map view.');
  }

  readonly [Symbol.toStringTag] = "Map";
}

export function createReadonlyMapView<TKey, TValue>(
  map: ReadonlyMap<TKey, TValue>,
): ReadonlyMap<TKey, TValue>;
export function createReadonlyMapView<TKey, TValue, TViewValue>(
  map: ReadonlyMap<TKey, TValue>,
  mapValue: (value: TValue) => TViewValue,
): ReadonlyMap<TKey, TViewValue>;
export function createReadonlyMapView<TKey, TValue, TViewValue = TValue>(
  map: ReadonlyMap<TKey, TValue>,
  mapValue: (value: TValue) => TViewValue = (value) => value as unknown as TViewValue,
): ReadonlyMap<TKey, TViewValue> {
  return new ReadonlyMapView(map, mapValue);
}

class ReadonlySetView<TValue> implements ReadonlySet<TValue> {
  readonly #set: ReadonlySet<TValue>;

  constructor(set: ReadonlySet<TValue>) {
    this.#set = set;
    Object.freeze(this);
  }

  get size(): number {
    return this.#set.size;
  }

  has(value: TValue): boolean {
    return this.#set.has(value);
  }

  forEach(
    callbackfn: (value: TValue, value2: TValue, set: ReadonlySet<TValue>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#set) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  *entries(): SetIterator<[TValue, TValue]> {
    for (const value of this.#set) {
      yield [value, value];
    }
  }

  keys(): SetIterator<TValue> {
    return this.values();
  }

  *values(): SetIterator<TValue> {
    yield* this.#set.values();
  }

  [Symbol.iterator](): SetIterator<TValue> {
    return this.values();
  }

  add(): never {
    throw new TypeError('Cannot call "add" on a read-only Set view.');
  }

  delete(): never {
    throw new TypeError('Cannot call "delete" on a read-only Set view.');
  }

  clear(): never {
    throw new TypeError('Cannot call "clear" on a read-only Set view.');
  }

  readonly [Symbol.toStringTag] = "Set";
}

export function createReadonlySetView<TValue>(
  set: ReadonlySet<TValue>,
): ReadonlySet<TValue> {
  return new ReadonlySetView(set);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepFreezePlainData<T>(value: T): T {
  const stack: unknown[] = [value];
  const visited = new WeakSet<object>();
  const containers: object[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (
      current === null ||
      typeof current !== "object" ||
      Object.isFrozen(current) ||
      (!Array.isArray(current) && !isPlainObject(current)) ||
      visited.has(current)
    ) {
      continue;
    }

    visited.add(current);
    containers.push(current);
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) {
      stack.push(child);
    }
  }

  for (let index = containers.length - 1; index >= 0; index -= 1) {
    Object.freeze(containers[index]!);
  }

  return value;
}

export function setOwnEnumerableValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    return;
  }

  target[key] = value;
}
