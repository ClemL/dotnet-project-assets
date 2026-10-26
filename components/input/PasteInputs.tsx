'use client';

import { btn, btnSmall, field, h2, hint } from '../ui/styles';
import { newId, type PasteSlot } from '../inputTypes';

export function PasteInputs({ slots, onChange }: { slots: PasteSlot[]; onChange: (slots: PasteSlot[]) => void }) {
  return (
    <section className="space-y-3" aria-labelledby="paste-heading">
      <div>
        <h2 id="paste-heading" className={h2}>
          Paste
        </h2>
        <p className={hint}>One project.assets.json body per box.</p>
      </div>
      {slots.map((slot, i) => (
        <div key={slot.id} className="space-y-1">
          <div className="flex items-center justify-between">
            <label htmlFor={slot.id} className="text-sm font-medium text-ink-2">
              Paste #{i + 1}
            </label>
            {slots.length > 1 ? (
              <button type="button" className={btnSmall} onClick={() => onChange(slots.filter((s) => s.id !== slot.id))}>
                Remove
              </button>
            ) : null}
          </div>
          <textarea
            id={slot.id}
            className={`${field} h-32 w-full resize-y font-mono text-xs`}
            spellCheck={false}
            placeholder='{ "version": 3, "targets": { … }, "libraries": { … }, "project": { … } }'
            value={slot.text}
            onChange={(e) => onChange(slots.map((s) => (s.id === slot.id ? { ...s, text: e.target.value } : s)))}
          />
        </div>
      ))}
      <button type="button" className={btn} onClick={() => onChange([...slots, { id: newId('paste'), text: '' }])}>
        + Add another
      </button>
    </section>
  );
}
