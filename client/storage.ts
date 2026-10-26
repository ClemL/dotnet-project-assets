// localStorage helpers. Every access is wrapped: storage can be missing or throw (private
// windows, blocked site data), and the app must keep working without it.

export const STORAGE_PREFIX = 'assets-graph:';

/** The subset of the Web Storage API this app uses (lets tests pass an in-memory store). */
export interface KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserStore(): KeyValueStore | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readJson<T>(key: string, fallback: T, store = browserStore()): T {
  try {
    const raw = store?.getItem(STORAGE_PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, store = browserStore()): boolean {
  try {
    store?.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return store !== undefined;
  } catch {
    return false;
  }
}

export function removeKey(key: string, store = browserStore()): void {
  try {
    store?.removeItem(STORAGE_PREFIX + key);
  } catch {
    // ignore
  }
}

/** Keys (without the app prefix) that start with `prefix`. */
export function keysWithPrefix(prefix: string, store = browserStore()): string[] {
  const out: string[] = [];
  try {
    if (!store) return out;
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(STORAGE_PREFIX + prefix)) out.push(k.slice(STORAGE_PREFIX.length));
    }
  } catch {
    // ignore
  }
  return out;
}

export function createMemoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
