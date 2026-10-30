'use client';

import { useEffect, useRef } from 'react';
import { btnSmall, h2 } from './styles';

/**
 * Minimal modal dialog. Closes on Escape and on a click on the backdrop itself, locks page scroll
 * while open, moves focus into the panel, and returns focus to the opener on close.
 */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        // Only a click that lands on the backdrop itself closes. Clicks inside the panel (selecting
        // text, scrolling the list) bubble up here too and must not dismiss it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="flex max-h-full w-full max-w-2xl flex-col gap-3 rounded-lg border border-line bg-surface p-5 text-ink shadow-xl outline-none">
        <div className="flex items-center justify-between gap-2">
          <h2 className={h2}>{title}</h2>
          <button type="button" className={btnSmall} onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
