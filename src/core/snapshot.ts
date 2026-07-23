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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepFreezePlainData<T>(value: T): T {
  if (Object.isFrozen(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      deepFreezePlainData(item);
    });
    return Object.freeze(value);
  }

  if (isPlainObject(value)) {
    Object.values(value).forEach((item) => {
      deepFreezePlainData(item);
    });
    return Object.freeze(value) as T;
  }

  return value;
}

export function setOwnEnumerableValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}
