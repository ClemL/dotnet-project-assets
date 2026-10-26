'use client';

import { useRef, useState } from 'react';
import { btn, cx, h2, hint } from '../ui/styles';

export function FileDropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [over, setOver] = useState(false);
  const [ignored, setIgnored] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = (files: File[]) => {
    const json = files.filter((f) => f.name.toLowerCase().endsWith('.json'));
    setIgnored(files.length - json.length);
    if (json.length > 0) onFiles(json);
  };
  return (
    <section className="space-y-3" aria-labelledby="upload-heading">
      <div>
        <h2 id="upload-heading" className={h2}>
          Upload files
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
        <p className="text-ink-2">Drop one or more .json files here</p>
        <button type="button" className={btn} onClick={() => inputRef.current?.click()}>
          Choose files…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          onChange={(e) => {
            accept(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {ignored > 0 ? <p className={hint}>Ignored {ignored} file(s) without a .json extension.</p> : null}
    </section>
  );
}
