function createReadonlyMutationError(method: string): () => never {
  return () => {
    throw new TypeError(`Cannot call "${method}" on a read-only Map view.`);
  };
}

export function createReadonlyMapView<TKey, TValue>(
  map: Map<TKey, TValue>,
): ReadonlyMap<TKey, TValue> {
  return new Proxy(map, {
    get(target, property, receiver) {
      if (property === "set" || property === "delete" || property === "clear") {
        return createReadonlyMutationError(String(property));
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReadonlyMap<TKey, TValue>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepFreezePlainData<T>(value: T): T {
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

