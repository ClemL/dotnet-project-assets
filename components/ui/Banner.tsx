import { cx } from './styles';

const tones = {
  info: { box: 'border-accent/40 bg-info-bg text-info-ink', icon: 'ℹ' },
  warn: { box: 'border-warn-line bg-warn-bg text-warn-ink', icon: '⚠' },
  danger: { box: 'border-danger bg-danger-bg text-danger-ink', icon: '⛔' },
} as const;

export function Banner({ tone, title, children, className }: { tone: keyof typeof tones; title: string; children?: React.ReactNode; className?: string }) {
  const t = tones[tone];
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={cx('flex gap-2 rounded-md border px-3 py-2 text-sm', t.box, className)}>
      <span aria-hidden="true" className="leading-5">
        {t.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-1 space-y-1">{children}</div> : null}
      </div>
    </div>
  );
}
