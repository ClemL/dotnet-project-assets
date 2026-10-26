import { ORIGIN_LABELS } from '@/lib/classify';
import type { Origin } from '@/lib/types';
import { cx } from './styles';

export const ORIGIN_COLOR: Record<Origin, string> = {
  Project: 'var(--origin-project)',
  Private: 'var(--origin-private)',
  PrivateInferred: 'var(--origin-inferred)',
  Public: 'var(--origin-public)',
  System: 'var(--origin-system)',
  Unclassified: 'var(--origin-unclassified)',
};

export function OriginDot({ origin }: { origin: Origin }) {
  return <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ORIGIN_COLOR[origin] }} />;
}

export function OriginBadge({ origin, mixed, overridden, className }: { origin: Origin; mixed?: boolean; overridden?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', className)}>
      <OriginDot origin={origin} />
      <span>{ORIGIN_LABELS[origin]}</span>
      {mixed ? <span className="rounded bg-surface-2 px-1 text-[11px] text-ink-2">mixed</span> : null}
      {overridden ? <span className="rounded bg-surface-2 px-1 text-[11px] text-ink-2">override</span> : null}
    </span>
  );
}
