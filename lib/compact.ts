import type { SoAColumn, SoAExtraction, SoARow, SoATable } from './soa-types';

// Accepts both the public schema and the compact wire format the model is
// asked to emit (short keys, cells as parallel arrays). Always returns the
// public schema used by the UI and committed outputs.

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
}

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
  columns?: CompactCol[];
  rows?: CompactRow[];
  footnotes?: CompactFn[];
  fn?: CompactFn[];
  notes?: string[];
  ambiguities?: string[];
  amb?: string[];
}

function colOf(c: CompactCol, i: number): SoAColumn {
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
  const cells = r.cells
    ? r.cells.map((cell) => ({
        col: cell.col,
        value: cell.value ?? '',
        markers: cell.markers || [],
        colspan: cell.colspan,
      }))
    : (r.v || [])
        .map((value, idx) => {
          if (value == null || value === '') return null;
          return {
            col: columns[idx]?.id || `c${idx + 1}`,
            value: String(value),
            markers: r.mm?.[idx] || [],
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
  return {
    id: r.id || `r${i + 1}`,
    kind,
    label: r.label || r.lab || '',
    category: r.category ?? r.cat ?? null,
    markers: r.markers || r.m || [],
    cells,
  };
}

function expandTable(t: CompactTable, i: number): SoATable {
  const columns = (t.columns || []).map(colOf);
  return {
    id: t.id || `t${i + 1}`,
    title: t.title || '',
    pages: t.pages || [],
    columns,
    rows: (t.rows || []).map((r, ri) => rowOf(r, ri, columns)),
    footnotes: (t.footnotes || t.fn || []).map((f) => ({
      marker: f.marker || f.m || '',
      text: f.text || f.t || '',
      continuedAcrossPages: !!(f.continuedAcrossPages || f.cont),
      appliesTo: (f.appliesTo || f.at || []).map((a) => ({
        target: ((a.target || a.t || 'table') as 'cell' | 'row' | 'column' | 'table'),
        row: a.row || a.r,
        col: a.col || a.c,
      })),
    })),
    notes: t.notes || [],
    ambiguities: t.ambiguities || t.amb || [],
  };
}

export function expandExtraction(obj: { tables?: CompactTable[] }): SoAExtraction {
  if (!Array.isArray(obj.tables)) throw new Error('Model output missing "tables" array');
  return { tables: obj.tables.map(expandTable) };
}
