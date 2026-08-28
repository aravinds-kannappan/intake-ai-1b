// Output schema for extracted Schedule of Activities tables.
// Design goals, in order: no dropped rows/columns, verbatim cell values,
// footnote linkage, preserved hierarchy on both axes, provenance to pages.

export interface SoAColumn {
  id: string; // "c1", "c2", ... in document order
  // Hierarchy above the visit label, outermost first,
  // e.g. ["Treatment Infusions"] or ["Study Medication Administration"].
  path: string[];
  label: string; // the visit label as printed, e.g. "Visit 3", "Baseline", "-6"
  visitNumber: string | null; // as printed, if a visit-number header row exists
  studyDay: string | null; // as printed, e.g. "-2", "Up to -35"
  studyWeek: string | null; // as printed, e.g. "12", "9 -11", "12/Term"
  window: string | null; // allowable visit window as printed, e.g. "+/- 3 days"
  markers: string[]; // footnote markers attached to this column header
}

export interface SoACell {
  col: string; // SoAColumn id
  value: string; // verbatim as printed: "X", "3X/week", "Prior to Day 4", "(X)" ...
  markers: string[]; // footnote markers attached to this cell
  colspan?: number; // >1 when a single printed value visibly spans multiple columns
}

export interface SoARow {
  id: string; // "r1", "r2", ... in document order
  kind: 'category' | 'assessment';
  label: string; // verbatim row header
  category: string | null; // label of the governing category row, if any
  markers: string[]; // footnote markers attached to the row label
  cells: SoACell[]; // sparse: only cells with printed content
}

export interface SoAFootnote {
  marker: string; // as printed: "a", "*", "**", "Xa", "†" ...
  text: string; // full verbatim text, including any part continued on a later page
  continuedAcrossPages: boolean;
  appliesTo: SoAFootnoteTarget[];
}

export interface SoAFootnoteTarget {
  target: 'cell' | 'row' | 'column' | 'table';
  row?: string; // SoARow id
  col?: string; // SoAColumn id
}

export interface SoATable {
  id: string;
  title: string; // as printed, e.g. "Table 4. Schedule of Measures and Data Collection"
  pages: number[]; // 1-based physical PDF pages this table (incl. footnotes) spans
  columns: SoAColumn[];
  rows: SoARow[];
  footnotes: SoAFootnote[];
  notes: string[]; // table-level notes/abbreviation lines without a marker
  ambiguities: string[]; // anything that could not be represented faithfully
}

export interface SoAExtraction {
  tables: SoATable[];
  model?: string;
  extractedAt?: string;
  sourceFile?: string;
}

// ---------- Locator types ----------

export interface PageSignal {
  page: number; // 1-based
  score: number;
  signals: string[]; // human-readable reasons, shown in the UI
}

export interface SoACandidate {
  id: string;
  pages: number[]; // contiguous, 1-based
  score: number;
  titleGuess: string;
  signals: string[];
}
