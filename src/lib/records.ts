// Records keyed by user data (column names): null-prototype objects, so a column named
// `__proto__` or `constructor` is an ordinary key, never Object.prototype.

/** A null-prototype copy of `src` (or an empty one). */
export function dict<T>(src?: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, src);
}

/** `key` is an own key of `r` (never an inherited one). */
export function hasKey(r: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(r, key);
}
