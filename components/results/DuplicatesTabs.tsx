'use client';

import { useState } from 'react';
import type { Duplicates } from '@/lib/types';
import { describeRange } from '@/lib/version';
import { Tabs } from '../ui/Tabs';
import { cx, td, th } from '../ui/styles';

type Sub = 'tfm' | 'drift' | 'ranges' | 'redundant' | 'case';

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">{text}</p>;
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const mono = cx(td, 'font-mono text-xs');

export function DuplicatesTabs({ duplicates, isMerged, fileCount }: { duplicates: Duplicates; isMerged: boolean; fileCount: number }) {
  const [sub, setSub] = useState<Sub>('tfm');
  const [onlyConflicts, setOnlyConflicts] = useState(true);
  const conflicts = duplicates.ranges.filter((r) => r.hasConflict);
  const ranges = onlyConflicts ? conflicts : duplicates.ranges;

  return (
    <div className="space-y-3">
      <Tabs<Sub>
        label="Duplicate views"
        size="sm"
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'tfm', label: 'Across target frameworks', count: duplicates.tfm.length },
          { id: 'drift', label: 'Across projects (drift)', count: duplicates.drift.length },
          { id: 'ranges', label: 'Range conflicts', count: conflicts.length },
          { id: 'redundant', label: 'Redundant direct refs', count: duplicates.redundant.length },
          { id: 'case', label: 'Case collisions', count: duplicates.caseCollisions.length },
        ]}
      />

      {sub === 'tfm' ? (
        <>
          <p className="text-sm text-ink-2">The same Id resolved at different versions in different target frameworks of one project.</p>
          {duplicates.tfm.length === 0 ? (
            <Empty text="No Id resolves to different versions across target frameworks." />
          ) : (
            <Table head={['Project', 'Id', 'Versions by target']}>
              {duplicates.tfm.map((d) => (
                <tr key={`${d.project}/${d.key}`}>
                  <td className={cx(td, 'text-xs')}>{d.project}</td>
                  <td className={mono}>{d.id}</td>
                  <td className={mono}>
                    {d.byTarget.map((t) => (
                      <div key={t.target}>
                        <span className="text-ink-2">{t.target}</span> → {t.version}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      ) : null}

      {sub === 'drift' ? (
        <>
          <p className="text-sm text-ink-2">The same package resolved at different versions across projects: the cross-repo drift view.</p>
          {!isMerged || fileCount < 2 ? (
            <Empty text="Drift needs at least two projects. Load more files and pick the Merged scope." />
          ) : duplicates.drift.length === 0 ? (
            <Empty text="Every package resolves to the same version in every project." />
          ) : (
            <Table head={['Id', 'Version', 'Projects (targets)']}>
              {duplicates.drift.flatMap((d) =>
                d.versions.map((v, i) => (
                  <tr key={`${d.key}/${v.version}`} className={i === 0 ? 'border-t-2 border-line-strong' : undefined}>
                    <td className={mono}>{i === 0 ? d.id : ''}</td>
                    <td className={cx(mono, 'tabular whitespace-nowrap')}>{v.version}</td>
                    <td className={cx(td, 'text-xs')}>
                      {v.projects.map((p) => (
                        <div key={p.project}>
                          {p.project} <span className="text-muted">({p.tfms.join(', ')})</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                )),
              )}
            </Table>
          )}
        </>
      ) : null}

      {sub === 'ranges' ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-ink-2">Each parent&apos;s requested range compared with the resolved version. ✗ marks a range the resolved version does not satisfy.</p>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={onlyConflicts} onChange={(e) => setOnlyConflicts(e.target.checked)} />
              Unsatisfied only
            </label>
          </div>
          {ranges.length === 0 ? (
            <Empty text={onlyConflicts ? 'Every requested range is satisfied by its resolved version.' : 'No Id is requested with differing ranges.'} />
          ) : (
            <Table head={['Project', 'Target', 'Id', 'Resolved', 'Parent → requested range']}>
              {ranges.map((r) => (
                <tr key={`${r.project}/${r.target}/${r.key}`}>
                  <td className={cx(td, 'text-xs')}>{r.project}</td>
                  <td className={mono}>{r.target}</td>
                  <td className={mono}>{r.id}</td>
                  <td className={cx(mono, 'tabular')}>{r.resolved}</td>
                  <td className={mono}>
                    {r.parents.map((p, i) => (
                      <div key={i} className={p.satisfied === false ? 'text-danger-ink' : undefined}>
                        {p.parent}
                        {p.parentVersion ? ` ${p.parentVersion}` : ''} → {describeRange(p.range) || 'any'}{' '}
                        {p.satisfied === false ? <span aria-label="not satisfied">✗</span> : p.satisfied === null ? <span className="text-muted">(unparsed)</span> : null}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      ) : null}

      {sub === 'redundant' ? (
        <>
          <p className="text-sm text-ink-2">
            Declared directly and also pulled in by another direct dependency. &quot;Likely pin&quot; means the direct reference asks for a higher minimum than any transitive parent, which is usually deliberate (for example a security patch).
          </p>
          {duplicates.redundant.length === 0 ? (
            <Empty text="No direct reference is also pulled in transitively." />
          ) : (
            <Table head={['Project', 'Target', 'Id', 'Direct range', 'Resolved', 'Also reached via', 'Likely pin']}>
              {duplicates.redundant.map((r) => (
                <tr key={`${r.project}/${r.target}/${r.key}`}>
                  <td className={cx(td, 'text-xs')}>{r.project}</td>
                  <td className={mono}>{r.target}</td>
                  <td className={mono}>{r.id}</td>
                  <td className={mono}>{r.kind === 'projectReference' ? 'project' : describeRange(r.directRange)}</td>
                  <td className={cx(mono, 'tabular')}>{r.resolved}</td>
                  <td className={mono}>
                    {r.via.map((p, i) => (
                      <div key={i}>{p.join(' → ')}</div>
                    ))}
                  </td>
                  <td className={cx(td, 'text-xs')}>{r.likelyPin ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      ) : null}

      {sub === 'case' ? (
        <>
          <p className="text-sm text-ink-2">Ids that differ only by letter case. NuGet treats them as one package, and this app merges them, but the mismatch usually signals a renamed package or a typo.</p>
          {duplicates.caseCollisions.length === 0 ? (
            <Empty text="No case-only Id collisions." />
          ) : (
            <Table head={['Spelling', 'Projects']}>
              {duplicates.caseCollisions.flatMap((c) =>
                c.spellings.map((s, i) => (
                  <tr key={`${c.key}/${s.id}`} className={i === 0 ? 'border-t-2 border-line-strong' : undefined}>
                    <td className={mono}>{s.id}</td>
                    <td className={cx(td, 'text-xs')}>{s.projects.join(', ')}</td>
                  </tr>
                )),
              )}
            </Table>
          )}
        </>
      ) : null}
    </div>
  );
}
