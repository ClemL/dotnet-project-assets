'use client';

import { useCallback, useEffect, useState } from 'react';
import { buildInfoLine, parseChangelog } from '@/lib/changelog';
import { Dialog } from './ui/Dialog';

export const APP_NAME = 'Assets Graph';
// Inlined at build time by next.config.ts; the fallbacks keep dev servers and tests working.
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME ?? '';

/**
 * Build info plus the newest changelog entry, which opens the full changelog, newest first.
 *
 * Entries come from public/updates.txt, one per line, appended oldest first, so shipping an entry
 * is a one-line edit to a text file. A missing or empty file leaves the build info alone.
 */
export function Footer() {
  const [entries, setEntries] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    let cancelled = false;
    fetch('/updates.txt')
      .then((response) => (response.ok ? response.text() : ''))
      .then((text) => {
        if (!cancelled) setEntries(parseChangelog(text));
      })
      .catch(() => {
        // A missing changelog is not worth an error message.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const latest = entries.at(-1);

  return (
    <>
      <footer className="mx-auto mt-auto w-full max-w-[1400px] px-4 pb-4 pt-6 font-mono text-xs leading-relaxed text-muted">
        <div>{buildInfoLine(APP_NAME, VERSION, BUILD_TIME)}</div>
        {latest ? (
          <button
            type="button"
            title={latest}
            onClick={() => setOpen(true)}
            className="mt-1 block w-full cursor-pointer truncate text-left hover:text-ink focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {latest}
          </button>
        ) : null}
      </footer>

      {/* Outside <footer>, so the dialog does not inherit the footer's small monospace type. */}
      <Dialog open={open} onClose={close} title="Changelog">
        <ul className="max-h-[28rem] list-disc space-y-1.5 overflow-y-auto pl-5 text-sm leading-relaxed">
          {[...entries].reverse().map((line, i) => (
            // A text child, so React escapes it: an entry cannot inject markup.
            <li key={`${i}-${line}`}>{line}</li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
