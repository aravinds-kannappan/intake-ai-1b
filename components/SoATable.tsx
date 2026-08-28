'use client';

import { useMemo, useState } from 'react';
import type { SoATable } from '@/lib/soa-types';

// Renders one extracted SoA table with hierarchical headers, category rows,
// clickable footnote markers, and marker <-> footnote highlighting.

interface Props {
  table: SoATable;
}

interface HeaderGroup {
  label: string;
  span: number;
}

function groupRow(values: (string | null)[]): HeaderGroup[] {
  const groups: HeaderGroup[] = [];
  for (const v of values) {
    const label = v ?? '';
    const last = groups[groups.length - 1];
    if (last && last.label === label && label !== '') last.span += 1;
    else groups.push({ label, span: 1 });
  }
  return groups;
}

function Markers({
  markers,
  active,
  onSelect,
}: {
  markers: string[];
  active: string | null;
  onSelect: (m: string) => void;
}) {
  if (!markers?.length) return null;
  return (
    <sup className="ml-0.5 whitespace-nowrap">
      {markers.map((m, i) => (
        <button
          key={i}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(m);
          }}
          className={`px-0.5 rounded text-[0.7em] font-bold ${
            active === m
              ? 'bg-amber-300 text-amber-950'
              : 'text-blue-700 hover:bg-blue-100'
          }`}
          title={`Footnote ${m}`}
        >
          {m}
        </button>
      ))}
    </sup>
  );
}

export default function SoATable({ table }: Props) {
  const [activeMarker, setActiveMarker] = useState<string | null>(null);

  const colIndex = useMemo(() => {
    const map = new Map<string, number>();
    table.columns.forEach((c, i) => map.set(c.id, i));
    return map;
  }, [table.columns]);

  const toggleMarker = (m: string) =>
    setActiveMarker((cur) => (cur === m ? null : m));

  const cellHighlighted = (markers: string[]) =>
    activeMarker !== null && markers?.includes(activeMarker);

  const hasAnyPath0 = table.columns.some((c) => c.path?.[0]);
  const hasAnyPath1 = table.columns.some((c) => c.path?.[1]);
  const hasVisitNumber = table.columns.some(
    (c) => c.visitNumber && c.visitNumber !== c.label
  );
  const hasDay = table.columns.some((c) => c.studyDay);
  const hasWeek = table.columns.some((c) => c.studyWeek);
  const hasWindow = table.columns.some((c) => c.window);

  const headerRows: { name: string; groups: HeaderGroup[] }[] = [];
  if (hasAnyPath0)
    headerRows.push({
      name: 'Period',
      groups: groupRow(table.columns.map((c) => c.path?.[0] ?? null)),
    });
  if (hasAnyPath1)
    headerRows.push({
      name: '',
      groups: groupRow(table.columns.map((c) => c.path?.[1] ?? null)),
    });

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="font-semibold text-slate-900">{table.title || table.id}</h3>
          <p className="text-xs text-slate-500">
            Source pages: {table.pages?.join(', ') || 'unknown'} · {table.columns.length}{' '}
            visit columns ·{' '}
            {table.rows.filter((r) => r.kind === 'assessment').length} assessment rows ·{' '}
            {table.footnotes.length} footnotes
          </p>
        </div>
        {activeMarker && (
          <button
            onClick={() => setActiveMarker(null)}
            className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900"
          >
            Highlighting footnote “{activeMarker}” · clear
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            {headerRows.map((hr, i) => (
              <tr key={`p${i}`}>
                <th className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-left font-medium text-slate-500">
                  {i === 0 ? '' : ''}
                </th>
                {hr.groups.map((g, j) => (
                  <th
                    key={j}
                    colSpan={g.span}
                    className="border border-slate-200 bg-slate-100 px-2 py-1 text-center font-semibold text-slate-700"
                  >
                    {g.label}
                  </th>
                ))}
              </tr>
            ))}
            <tr>
              <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold text-slate-700">
                Activity
              </th>
              {table.columns.map((c) => (
                <th
                  key={c.id}
                  className={`border border-slate-200 px-2 py-1 text-center font-semibold text-slate-800 ${
                    activeMarker && c.markers?.includes(activeMarker)
                      ? 'bg-amber-200'
                      : 'bg-slate-50'
                  }`}
                >
                  {c.label}
                  <Markers markers={c.markers} active={activeMarker} onSelect={toggleMarker} />
                </th>
              ))}
            </tr>
            {hasVisitNumber && (
              <tr>
                <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium text-slate-500">
                  Visit
                </th>
                {table.columns.map((c) => (
                  <th key={c.id} className="border border-slate-200 bg-white px-2 py-1 text-center font-normal">
                    {c.visitNumber ?? ''}
                  </th>
                ))}
              </tr>
            )}
            {hasDay && (
              <tr>
                <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium text-slate-500">
                  Study day
                </th>
                {table.columns.map((c) => (
                  <th key={c.id} className="border border-slate-200 bg-white px-2 py-1 text-center font-normal">
                    {c.studyDay ?? ''}
                  </th>
                ))}
              </tr>
            )}
            {hasWeek && (
              <tr>
                <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium text-slate-500">
                  Study week
                </th>
                {table.columns.map((c) => (
                  <th key={c.id} className="border border-slate-200 bg-white px-2 py-1 text-center font-normal">
                    {c.studyWeek ?? ''}
                  </th>
                ))}
              </tr>
            )}
            {hasWindow && (
              <tr>
                <th className="sticky left-0 z-10 border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium text-slate-500">
                  Window
                </th>
                {table.columns.map((c) => (
                  <th key={c.id} className="border border-slate-200 bg-white px-2 py-1 text-center font-normal">
                    {c.window ?? ''}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {table.rows.map((row) => {
              if (row.kind === 'category') {
                return (
                  <tr key={row.id}>
                    <td
                      colSpan={table.columns.length + 1}
                      className="sticky-none border border-slate-200 bg-slate-200/70 px-2 py-1 font-semibold uppercase tracking-wide text-slate-700"
                    >
                      {row.label}
                      <Markers markers={row.markers} active={activeMarker} onSelect={toggleMarker} />
                    </td>
                  </tr>
                );
              }
              // build cell placement honoring colspan
              const cellByCol = new Map<number, { value: string; markers: string[]; span: number }>();
              const covered = new Set<number>();
              for (const cell of row.cells || []) {
                const idx = colIndex.get(cell.col);
                if (idx === undefined) continue;
                const span = Math.max(1, cell.colspan ?? 1);
                cellByCol.set(idx, { value: cell.value, markers: cell.markers || [], span });
                for (let k = idx + 1; k < idx + span; k++) covered.add(k);
              }
              return (
                <tr key={row.id} className="hover:bg-blue-50/40">
                  <td
                    className={`sticky left-0 z-10 border border-slate-200 bg-white px-2 py-1 text-left font-medium text-slate-800 ${
                      activeMarker && row.markers?.includes(activeMarker) ? 'bg-amber-200' : ''
                    }`}
                  >
                    {row.label}
                    <Markers markers={row.markers} active={activeMarker} onSelect={toggleMarker} />
                  </td>
                  {table.columns.map((c, idx) => {
                    if (covered.has(idx)) return null;
                    const cell = cellByCol.get(idx);
                    if (!cell)
                      return <td key={c.id} className="border border-slate-200 px-2 py-1" />;
                    return (
                      <td
                        key={c.id}
                        colSpan={cell.span}
                        className={`border border-slate-200 px-2 py-1 text-center font-medium ${
                          cellHighlighted(cell.markers)
                            ? 'bg-amber-200 text-amber-950'
                            : 'text-slate-900'
                        }`}
                      >
                        {cell.value}
                        <Markers markers={cell.markers} active={activeMarker} onSelect={toggleMarker} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(table.footnotes.length > 0 || table.notes.length > 0 || table.ambiguities.length > 0) && (
        <div className="space-y-3 border-t border-slate-200 px-4 py-3">
          {table.footnotes.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Footnotes (click to highlight where they apply)
              </h4>
              <ul className="space-y-1">
                {table.footnotes.map((f, i) => (
                  <li
                    key={i}
                    onClick={() => toggleMarker(f.marker)}
                    className={`cursor-pointer rounded px-2 py-1 text-xs leading-snug ${
                      activeMarker === f.marker
                        ? 'bg-amber-100 ring-1 ring-amber-300'
                        : 'hover:bg-slate-50'
                    }`}
                  >
                    <span className="mr-1 font-bold text-blue-700">{f.marker}</span>
                    {f.text}
                    {f.continuedAcrossPages && (
                      <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-700">
                        continued across pages
                      </span>
                    )}
                    <span className="ml-1 text-[10px] text-slate-400">
                      {f.appliesTo?.map((t) =>
                        t.target === 'table'
                          ? 'whole table'
                          : `${t.target}${t.row ? ` ${t.row}` : ''}${t.col ? ` ${t.col}` : ''}`
                      ).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {table.notes.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Table notes
              </h4>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                {table.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {table.ambiguities.length > 0 && (
            <div className="rounded border border-orange-200 bg-orange-50 px-3 py-2">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-orange-700">
                Ambiguities flagged during extraction
              </h4>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-orange-800">
                {table.ambiguities.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
