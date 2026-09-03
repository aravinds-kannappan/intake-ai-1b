import type { SoACell, SoAColumn, SoAExtraction, SoARow, SoATable } from './soa-types';

function norm(s: string | null | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function colKey(c: SoAColumn): string {
  return [norm(c.path?.join('|')), norm(c.label), norm(c.visitNumber), norm(c.studyDay), norm(c.studyWeek)].join('::');
}

function titleSimilar(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function rowOverlap(a: SoATable, b: SoATable): number {
  const labelsA = new Set(a.rows.filter((r) => r.kind === 'assessment').map((r) => norm(r.label)));
  const labelsB = b.rows.filter((r) => r.kind === 'assessment').map((r) => norm(r.label));
  if (!labelsA.size || !labelsB.length) return 0;
  let hit = 0;
  for (const l of labelsB) if (labelsA.has(l)) hit++;
  return hit / Math.max(labelsA.size, labelsB.length);
}

function findMergeTarget(tables: SoATable[], incoming: SoATable): SoATable | undefined {
  return tables.find((existing) => {
    if (titleSimilar(existing.title, incoming.title) && (existing.title || incoming.title)) return true;
    return rowOverlap(existing, incoming) >= 0.45;
  });
}

function remapColId(oldId: string, map: Map<string, string>): string {
  return map.get(oldId) || oldId;
}

function mergeTable(target: SoATable, incoming: SoATable) {
  const colMap = new Map<string, string>();
  const existingByKey = new Map(target.columns.map((c) => [colKey(c), c]));

  for (const col of incoming.columns) {
    const key = colKey(col);
    const match = existingByKey.get(key);
    if (match) {
      colMap.set(col.id, match.id);
      if (!match.window && col.window) match.window = col.window;
      for (const m of col.markers || []) {
        if (!match.markers.includes(m)) match.markers.push(m);
      }
    } else {
      const nid = `c${target.columns.length + 1}`;
      colMap.set(col.id, nid);
      const next: SoAColumn = { ...col, id: nid, path: [...(col.path || [])], markers: [...(col.markers || [])] };
      target.columns.push(next);
      existingByKey.set(key, next);
    }
  }

  const rowByLabel = new Map(target.rows.map((r) => [`${r.kind}:${norm(r.label)}`, r]));
  for (const row of incoming.rows) {
    const key = `${row.kind}:${norm(row.label)}`;
    const match = rowByLabel.get(key);
    if (!match) {
      const nid = `r${target.rows.length + 1}`;
      const cells: SoACell[] = (row.cells || []).map((c) => ({
        ...c,
        col: remapColId(c.col, colMap),
        markers: [...(c.markers || [])],
      }));
      const next: SoARow = {
        ...row,
        id: nid,
        markers: [...(row.markers || [])],
        cells,
      };
      target.rows.push(next);
      rowByLabel.set(key, next);
      continue;
    }
    for (const m of row.markers || []) {
      if (!match.markers.includes(m)) match.markers.push(m);
    }
    for (const cell of row.cells || []) {
      const col = remapColId(cell.col, colMap);
      const existing = match.cells.find((c) => c.col === col);
      if (!existing) {
        match.cells.push({ ...cell, col, markers: [...(cell.markers || [])] });
      } else if (!existing.value && cell.value) {
        existing.value = cell.value;
        existing.markers = Array.from(new Set([...(existing.markers || []), ...(cell.markers || [])]));
      }
    }
  }

  const fnByMarker = new Map(target.footnotes.map((f) => [f.marker, f]));
  for (const fn of incoming.footnotes) {
    const match = fnByMarker.get(fn.marker);
    if (!match) {
      target.footnotes.push({
        ...fn,
        appliesTo: (fn.appliesTo || []).map((t) => ({
          ...t,
          col: t.col ? remapColId(t.col, colMap) : t.col,
        })),
      });
      continue;
    }
    if (fn.text && !match.text.includes(fn.text) && !fn.text.includes(match.text)) {
      match.text = `${match.text} ${fn.text}`.trim();
      match.continuedAcrossPages = true;
    } else if (fn.continuedAcrossPages) {
      match.continuedAcrossPages = true;
    }
  }

  for (const n of incoming.notes || []) {
    if (!target.notes.includes(n)) target.notes.push(n);
  }
  for (const a of incoming.ambiguities || []) {
    if (!target.ambiguities.includes(a)) target.ambiguities.push(a);
  }
  target.pages = Array.from(new Set([...(target.pages || []), ...(incoming.pages || [])])).sort(
    (x, y) => x - y
  );
}

export function mergeExtractions(parts: SoAExtraction[]): SoAExtraction {
  const tables: SoATable[] = [];
  for (const part of parts) {
    for (const table of part.tables || []) {
      const clone: SoATable = {
        ...table,
        columns: table.columns.map((c) => ({ ...c, path: [...(c.path || [])], markers: [...(c.markers || [])] })),
        rows: table.rows.map((r) => ({
          ...r,
          markers: [...(r.markers || [])],
          cells: (r.cells || []).map((c) => ({ ...c, markers: [...(c.markers || [])] })),
        })),
        footnotes: (table.footnotes || []).map((f) => ({ ...f, appliesTo: [...(f.appliesTo || [])] })),
        notes: [...(table.notes || [])],
        ambiguities: [...(table.ambiguities || [])],
        pages: [...(table.pages || [])],
      };
      const target = findMergeTarget(tables, clone);
      if (target) mergeTable(target, clone);
      else {
        clone.id = `t${tables.length + 1}`;
        tables.push(clone);
      }
    }
  }
  tables.forEach((t, i) => {
    t.id = `t${i + 1}`;
  });
  return { tables };
}

export { chunkPages, trimCandidatePages } from './pages';
