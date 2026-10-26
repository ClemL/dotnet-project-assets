export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export const btn = `inline-flex items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;
export const btnPrimary = `inline-flex items-center justify-center gap-1.5 rounded-md border border-transparent bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;
export const btnSmall = `inline-flex items-center gap-1 rounded border border-line-strong bg-surface px-2 py-0.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50 ${focus}`;
export const linkBtn = `text-accent underline-offset-2 hover:underline ${focus}`;
export const field = 'rounded-md border border-line-strong bg-surface px-2 py-1 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-accent';
export const card = 'rounded-lg border border-line bg-surface p-4';
export const th = 'border-b border-line-strong px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-2 whitespace-nowrap';
export const td = 'border-b border-line px-2 py-1.5 align-top text-sm';
export const h2 = 'text-base font-semibold text-ink';
export const hint = 'text-xs text-muted';
