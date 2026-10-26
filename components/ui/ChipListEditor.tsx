'use client';

import { useState } from 'react';
import { btnSmall, field } from './styles';

export interface ChipSuggestion {
  value: string;
  note?: string;
}

/** Editable list of short strings (prefixes, feed URLs) with optional one-click suggestions. */
export function ChipListEditor({
  label,
  values,
  onChange,
  placeholder,
  suggestions = [],
  onRemove,
  onReset,
  mono,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  suggestions?: ChipSuggestion[];
  onRemove?: (value: string) => void;
  onReset?: () => void;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const has = (v: string) => values.some((x) => x.toLowerCase() === v.toLowerCase());
  const add = (v: string) => {
    const t = v.trim();
    if (t && !has(t)) onChange([...values, t]);
  };
  const open = suggestions.filter((s) => !has(s.value));
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {values.length === 0 ? <li className="text-sm text-muted">None</li> : null}
        {values.map((v) => (
          <li key={v} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-line-strong bg-surface-2 py-0.5 pl-2.5 pr-1 text-sm">
            <span className={mono ? 'truncate font-mono text-xs' : 'truncate'}>{v}</span>
            <button
              type="button"
              className="rounded-full px-1.5 text-ink-2 hover:bg-line hover:text-ink"
              aria-label={`Remove ${v}`}
              onClick={() => {
                onChange(values.filter((x) => x !== v));
                onRemove?.(v);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
          setDraft('');
        }}
      >
        <input className={`${field} min-w-0 flex-1`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} aria-label={`Add to ${label}`} />
        <button type="submit" className={btnSmall} disabled={!draft.trim()}>
          Add
        </button>
        {onReset ? (
          <button type="button" className={btnSmall} onClick={onReset}>
            Reset to defaults
          </button>
        ) : null}
      </form>
      {open.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">Suggestions:</span>
          {open.map((s) => (
            <button key={s.value} type="button" className={btnSmall} onClick={() => add(s.value)} title={s.note}>
              + {s.value}
              {s.note ? <span className="text-muted">({s.note})</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
