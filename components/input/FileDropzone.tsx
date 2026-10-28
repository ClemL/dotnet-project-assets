'use client';

import { useRef, useState } from 'react';
import { btn, cx, h2, hint } from '../ui/styles';

/**
 * extensions: lowercase, with the dot. Files with other extensions are ignored and counted.
 * Default: ['.json'].
 */
export function FileDropzone({
  onFiles,
  title = 'Upload files',
  id = 'upload',
  extensions = ['.json'],
}: {
  onFiles: (files: File[]) => void;
  title?: string;
  id?: string;
  extensions?: string[];
}) {
  const [over, setOver] = useState(false);
  const [ignored, setIgnored] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = (files: File[]) => {
    const kept = files.filter((f) => extensions.some((x) => f.name.toLowerCase().endsWith(x)));
    setIgnored(files.length - kept.length);
    if (kept.length > 0) onFiles(kept);
  };
  const list = extensions.join(', ');
  return (
    <section className="space-y-3" aria-labelledby={`${id}-heading`}>
      <div>
        <h2 id={`${id}-heading`} className={h2}>
          {title}
        </h2>
        <p className={hint}>Files are read in your browser; nothing is uploaded.</p>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          accept(Array.from(e.dataTransfer.files));
        }}
        className={cx('flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm', over ? 'border-accent bg-info-bg' : 'border-line-strong')}
      >
        <p className="text-ink-2">Drop one or more {list} files here</p>
        <button type="button" className={btn} onClick={() => inputRef.current?.click()}>
          Choose files…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={extensions.join(',')}
          multiple
          hidden
          onChange={(e) => {
            accept(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {ignored > 0 ? <p className={hint}>Ignored {ignored} file(s) without a {list} extension.</p> : null}
    </section>
  );
}
