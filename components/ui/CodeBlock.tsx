'use client';

import { useEffect, useRef, useState } from 'react';
import { downloadText } from '@/client/download';
import { btnSmall, cx } from './styles';

/** Copies text to the clipboard; falls back to a hidden textarea when the Clipboard API is missing or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A code snippet with a Copy button and, when `fileName` is given, a Download button. */
export function CodeBlock({ code, label, fileName, className, maxHeight = 'max-h-80' }: { code: string; label?: string; fileName?: string; className?: string; maxHeight?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyText(code);
    setStatus(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 1600);
  };

  return (
    <div className={cx('overflow-hidden rounded-md border border-line', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2 px-2 py-1">
        <span className="min-w-0 truncate font-mono text-xs text-ink-2">{label ?? ''}</span>
        <span className="flex shrink-0 gap-1">
          {fileName ? (
            <button type="button" className={btnSmall} onClick={() => downloadText(fileName, code, 'text/plain')} aria-label={`Download ${fileName}`}>
              Download
            </button>
          ) : null}
          <button type="button" className={btnSmall} onClick={() => void copy()} aria-label={`Copy ${label ?? 'snippet'}`}>
            {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
        </span>
      </div>
      <pre className={cx(maxHeight, 'overflow-auto bg-surface p-2 font-mono text-xs leading-snug')}>
        <code>{code}</code>
      </pre>
      <span className="sr-only" aria-live="polite">
        {status === 'copied' ? 'Copied to the clipboard' : status === 'failed' ? 'Copy failed; select the text and copy it manually' : ''}
      </span>
    </div>
  );
}
