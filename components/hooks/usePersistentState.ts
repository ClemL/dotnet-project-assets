'use client';

import { useEffect, useState } from 'react';
import { readJson, writeJson } from '@/client/storage';

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * useState backed by localStorage. Starts from `initial` (so the static HTML matches), loads the
 * stored value after mount, and saves every change after that. Stored objects are merged over
 * `initial` so new settings fields get their defaults.
 */
export function usePersistentState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readJson<unknown>(key, null);
    if (stored !== null) setValue(isPlainObject(initial) && isPlainObject(stored) ? ({ ...initial, ...stored } as T) : (stored as T));
    setReady(true);
    // `initial` is a constant default; reading it once is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (ready) writeJson(key, value);
  }, [key, value, ready]);

  return [value, setValue, ready];
}
