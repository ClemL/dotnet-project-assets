import { cx } from './styles';

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
  disabled?: boolean;
}

export function Tabs<T extends string>({ tabs, value, onChange, label, size = 'md' }: { tabs: TabDef<T>[]; value: T; onChange: (id: T) => void; label: string; size?: 'md' | 'sm' }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 font-medium focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40',
            size === 'md' ? 'px-3 py-2 text-sm' : 'px-2.5 py-1.5 text-xs',
            t.id === value ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined ? <span className="tabular ml-1.5 rounded-full bg-surface-2 px-1.5 text-[11px] text-ink-2">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
