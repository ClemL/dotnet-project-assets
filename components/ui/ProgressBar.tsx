export function ProgressBar({ label, done, total, detail }: { label: string; done: number; total: number; detail?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex justify-between gap-2 text-xs text-ink-2">
        <span className="truncate">
          {label}
          {detail ? `: ${detail}` : ''}
        </span>
        <span className="tabular shrink-0">
          {done} / {total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
