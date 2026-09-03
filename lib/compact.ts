import type { SoAColumn, SoAExtraction, SoARow, SoATable } from './soa-types';

// Expands the ultra-compact wire format the model emits into the public schema.
// Accepts legacy compact and full schemas too.

interface CompactCol {
  id?: string;
  path?: string[];
  label?: string;
  visitNumber?: string | null;
  studyDay?: string | null;
  studyWeek?: string | null;
  window?: string | null;
  markers?: string[];
  vn?: string | null;
  d?: string | null;
  w?: string | null;
  wk?: string | null;
  m?: string[];
  // ultra: [pathJoinedOrPath0, label, vn, d, wk, w]
  // or string label only
}

type UltraCol = string | (string | null)[] | CompactCol;

interface CompactRow {
  id?: string;
  kind?: 'category' | 'assessment';
  k?: 'c' | 'a' | 'category' | 'assessment';
  label?: string;
  lab?: string;
  category?: string | null;
  cat?: string | null;
  markers?: string[];
  m?: string[];
  cells?: { col: string; value: string; markers?: string[]; colspan?: number }[];
  v?: (string | null)[];
  mm?: (string[] | null)[];
  // ultra sparse map: colIndex -> value or [value, ...markers]
  c?: Record<string, string | (string | null)[]>;
}

interface CompactFn {
  marker?: string;
  m?: string;
  text?: string;
  t?: string;
  continuedAcrossPages?: boolean;
  cont?: boolean;
  appliesTo?: { target?: string; t?: string; row?: string; r?: string; col?: string; c?: string }[];
  at?: { target?: string; t?: string; row?: string; r?: string; col?: string; c?: string }[];
}

interface CompactTable {
  id?: string;
  title?: string;
  pages?: number[];
  columns?: UltraCol[];
  rows?: CompactRow[];
  footnotes?: CompactFn[];
  fn?: CompactFn[] | (string | null)[][];
  notes?: string[];
  ambiguities?: string[];
  amb?: string[];
}

function splitMarkers(value: string): { value: string; markers: string[] } {
  const markers: string[] = [];
  let v = value;
  // Trailing fused markers: Xa, X*, X†, (X)a, Xa,b
  const fused = v.match(/^(.*?)([a-z]|[†‡*]|\d+)$/i);
  if (fused && /[Xx✓✔]/.test(fused[1]) && fused[2].length <= 2) {
    // only peel single-letter/digit marker when base looks like a cell mark
    const base = fused[1];
    if (/^[(\[]?[Xx✓✔●•][)\]]?$/.test(base.trim()) || /^[0-9]+\s?[Xx]$/i.test(base.trim())) {
      v = base;
      markers.push(fused[2]);
    }
  }
  return { value: v, markers };
}

function colOf(c: UltraCol, i: number): SoAColumn {
  if (typeof c === 'string') {
    return {
      id: `c${i + 1}`,
      path: [],
      label: c,
      visitNumber: null,
      studyDay: null,
      studyWeek: null,
      window: null,
      markers: [],
    };
  }
  if (Array.isArray(c)) {
    const pathRaw = c[0] || '';
    const path =
      typeof pathRaw === 'string' && pathRaw.includes('|')
        ? pathRaw.split('|').filter(Boolean)
        : pathRaw
          ? [String(pathRaw)]
          : [];
    return {
      id: `c${i + 1}`,
      path,
      label: String(c[1] ?? ''),
      visitNumber: c[2] != null && c[2] !== '' ? String(c[2]) : null,
      studyDay: c[3] != null && c[3] !== '' ? String(c[3]) : null,
      studyWeek: c[4] != null && c[4] !== '' ? String(c[4]) : null,
      window: c[5] != null && c[5] !== '' ? String(c[5]) : null,
      markers: [],
    };
  }
  return {
    id: c.id || `c${i + 1}`,
    path: c.path || [],
    label: c.label || '',
    visitNumber: c.visitNumber ?? c.vn ?? null,
    studyDay: c.studyDay ?? c.d ?? null,
    studyWeek: c.studyWeek ?? c.wk ?? null,
    window: c.window ?? c.w ?? null,
    markers: c.markers || c.m || [],
  };
}

function rowOf(r: CompactRow, i: number, columns: SoAColumn[]): SoARow {
  const kindRaw = r.kind || r.k;
  const kind: SoARow['kind'] =
    kindRaw === 'c' || kindRaw === 'category' ? 'category' : 'assessment';

  let cells: SoARow['cells'] = [];
  if (r.cells) {
    cells = r.cells.map((cell) => ({
      col: cell.col,
      value: cell.value ?? '',
      markers: cell.markers || [],
      colspan: cell.colspan,
    }));
  } else if (r.c && typeof r.c === 'object') {
    for (const [idxStr, raw] of Object.entries(r.c)) {
      const idx = parseInt(idxStr, 10);
      if (Number.isNaN(idx)) continue;
      const colId = columns[idx]?.id || `c${idx + 1}`;
      if (Array.isArray(raw)) {
        const value = String(raw[0] ?? '');
        const markers = raw.slice(1).filter((x): x is string => !!x).map(String);
        cells.push({ col: colId, value, markers });
      } else {
        const parsed = splitMarkers(String(raw ?? ''));
        cells.push({ col: colId, value: parsed.value, markers: parsed.markers });
      }
    }
  } else if (r.v) {
    cells = (r.v || [])
      .map((value, idx) => {
        if (value == null || value === '') return null;
        return {
          col: columns[idx]?.id || `c${idx + 1}`,
          value: String(value),
          markers: r.mm?.[idx] || [],
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  return {
    id: r.id || `r${i + 1}`,
    kind,
    label: r.label || r.lab || '',
    category: r.category ?? r.cat ?? null,
    markers: r.markers || r.m || [],
    cells,
  };
}

function expandFn(fn: CompactFn | (string | null)[]): CompactFn {
  if (Array.isArray(fn)) {
    return { m: String(fn[0] ?? ''), t: String(fn[1] ?? ''), cont: !!fn[2] };
  }
  return fn;
}

function expandTable(t: CompactTable, i: number): SoATable {
  const columns = (t.columns || []).map(colOf);
  const rows = (t.rows || []).map((r, ri) => rowOf(r, ri, columns));
  const rawFn = (t.footnotes || t.fn || []).map(expandFn);

  const footnotes = rawFn.map((f) => {
    const marker = f.marker || f.m || '';
    const appliesTo =
      f.appliesTo || f.at
        ? (f.appliesTo || f.at || []).map((a) => ({
            target: ((a.target || a.t || 'table') as 'cell' | 'row' | 'column' | 'table'),
            row: a.row || a.r,
            col: a.col || a.c,
          }))
        : rebuildAppliesTo(marker, rows, columns);
    return {
      marker,
      text: f.text || f.t || '',
      continuedAcrossPages: !!(f.continuedAcrossPages || f.cont),
      appliesTo,
    };
  });

  return {
    id: t.id || `t${i + 1}`,
    title: t.title || '',
    pages: t.pages || [],
    columns,
    rows,
    footnotes,
    notes: t.notes || [],
    ambiguities: t.ambiguities || t.amb || [],
  };
}

function rebuildAppliesTo(
  marker: string,
  rows: SoARow[],
  columns: SoAColumn[]
): { target: 'cell' | 'row' | 'column' | 'table'; row?: string; col?: string }[] {
  if (!marker) return [{ target: 'table' }];
  const out: { target: 'cell' | 'row' | 'column' | 'table'; row?: string; col?: string }[] = [];
  for (const col of columns) {
    if (col.markers?.includes(marker)) out.push({ target: 'column', col: col.id });
  }
  for (const row of rows) {
    if (row.markers?.includes(marker)) out.push({ target: 'row', row: row.id });
    for (const cell of row.cells || []) {
      if (cell.markers?.includes(marker)) {
        out.push({ target: 'cell', row: row.id, col: cell.col });
      }
    }
  }
  return out.length ? out : [{ target: 'table' }];
}

export function expandExtraction(obj: { tables?: CompactTable[] }): SoAExtraction {
  if (!Array.isArray(obj.tables)) throw new Error('Model output missing "tables" array');
  return { tables: obj.tables.map(expandTable) };
}
