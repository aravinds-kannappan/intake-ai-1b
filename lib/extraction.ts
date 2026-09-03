import type { SoAExtraction } from './soa-types';
import { expandExtraction } from './compact';

// Shared between the API route and the local batch script.

export const DEFAULT_MODEL = process.env.SOA_MODEL || 'claude-sonnet-5';
export const QUALITY_MODEL = process.env.SOA_QUALITY_MODEL || 'claude-opus-5';
export const LOCATE_MODEL = process.env.SOA_LOCATE_MODEL || 'claude-haiku-4-5';
export const DEFAULT_EFFORT = (process.env.SOA_EFFORT || 'low') as 'low' | 'medium' | 'high';

export const EXTRACTION_SYSTEM_PROMPT = `You are a clinical protocol Schedule of Activities (SoA) extraction engine.
You receive page images from a clinical trial protocol PDF (with the raw text
layer of each page as backup). The pages may use ANY sponsor name for the
schedule (Schedule of Activities / Events / Assessments / Measures, Time and
Events, Study Flow Chart, Table of Events, Visit Schedule, ICH M11 SoA, or no
English title at all). Extract every schedule-like grid on these pages.

Non-negotiable rules:

1. BE FAITHFUL, NOT CLEVER. Copy cell values verbatim: "X", "3X", "X (if
   applicable)", "3X/week", "Weekly x 2 weeks", "Prior to Day 4", "1&2", "(X)",
   Y/N, doses, volumes, arrows, Q2W. Never normalize to booleans. Never infer,
   repair, or resolve what the document says. If something is genuinely
   ambiguous, record it in "amb" instead of quietly picking an interpretation.
2. RECALL OVER PRECISION. A dropped row or dropped column is the worst possible
   failure. Every assessment row and every visit column on the pages must appear
   in the output. Before finishing, re-scan every page for rows or columns you
   may have missed, including rows whose printed cells are all empty.
3. TABLES SPAN PAGES. A continuation page ("continued", "concluded", repeated
   headers, or no header at all) belongs to the same table: merge it. Repeated
   header rows and repeated row labels on continuation pages must be merged, not
   duplicated. If the same row label appears on two pages with cells for
   different columns, output ONE row with the union of the cells.
4. FOOTNOTES ARE LOAD-BEARING. Extract the full verbatim text of every footnote
   and table note, including footnote text that continues on a following page
   with no header. Record which marker sits on which cell, row label, or column
   header. Markers may be superscript letters or numbers, asterisks, daggers, or
   parenthesized letters, and one cell may carry several.
5. HIERARCHY IS STRUCTURE. Column headers stack (study period over visit label
   over day/week over window): preserve that in "path" and the per-column
   fields. Row category headers ("Safety Assessments", "Efficacy") are
   k:"c" rows, not assessments; every assessment row records its governing
   category.
6. Vertical or rotated header text (e.g. RANDOMIZATION printed letter by letter
   down a column divider) is usually a milestone divider between column groups,
   not a data column. Represent it as a column with its verbatim label and note
   it in amb if its role is unclear.
7. These pages may be only a slice of a longer table. Extract EVERYTHING on
   these pages completely. Do not invent columns or rows that are not on these
   pages.

Output: a single JSON object, no markdown fences, no commentary. Use this
COMPACT schema (short keys) so decoding stays fast:

{
  "tables": [
    {
      "id": "t1",
      "title": "verbatim table title",
      "pages": [<1-based page numbers as labeled in the user message>],
      "columns": [
        { "id": "c1", "path": ["study period"], "label": "visit as printed",
          "vn": "1"|null, "d": "study day as printed"|null,
          "wk": "study week as printed"|null, "w": "window as printed"|null,
          "m": ["a"] }
      ],
      "rows": [
        { "id": "r1", "k": "c"|"a", "lab": "verbatim row header",
          "cat": "governing category"|null, "m": [],
          "v": ["X", "", "3X"],
          "mm": [[], [], ["b"]] }
      ],
      "fn": [
        { "m": "as printed", "t": "full verbatim text", "cont": false,
          "at": [ {"t":"cell","r":"r4","c":"c2"}, {"t":"column","c":"c1"},
                  {"t":"row","r":"r2"}, {"t":"table"} ] }
      ],
      "notes": ["unmarked table notes / abbreviations"],
      "amb": ["anything not faithfully representable"]
    }
  ]
}

Schema conventions:
- "v" is a dense array aligned to "columns" (same length). Use "" for empty
  cells. Do not invent content. "mm" is optional and aligned the same way.
- If a marker is printed fused to the value (like "Xa"), set v to the act
  itself ("X") and put the marker in mm, using the footnote block's key
  (if the block says "Xa = ...", the marker is "Xa").
- Column order and row order must match the document exactly.
- Every distinct schedule table on the pages is its own entry in "tables".
  Do not merge different tables (a PK sub-schedule is separate from the main
  schedule).
- Footnote "at" must list every location whose marker matches; if a footnote's
  marker appears nowhere, use {"t":"table"}.
- k="c" is a category header row (no need for v); k="a" is an assessment.

Return ONLY the JSON object.`;

export const EXTRACTION_SYSTEM_BLOCKS = [
  {
    type: 'text' as const,
    text: EXTRACTION_SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' as const },
  },
];

export function buildUserContent(
  pages: { page: number; imageBase64?: string; mediaType?: string; text?: string }[]
): unknown[] {
  const content: unknown[] = [];
  for (const p of pages) {
    const hasImage = !!p.imageBase64;
    const hasText = !!p.text;
    const label =
      hasImage && hasText
        ? '(image + text layer)'
        : hasImage
          ? '(image only)'
          : hasText
            ? '(text layer only — page image unavailable, likely from a scanned or unembedded-font PDF)'
            : '(no content)';
    content.push({
      type: 'text',
      text: `--- PDF page ${p.page} ${label} ---`,
    });
    if (p.imageBase64) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: p.mediaType || 'image/jpeg',
          data: p.imageBase64,
        },
      });
    }
    if (p.text) {
      const guidance = hasImage
        ? 'may scramble table layout, use only as backup for exact wording'
        : 'this is the primary source since no image is available; reconstruct row/column structure from column alignment and repeated whitespace';
      content.push({
        type: 'text',
        text: `Text layer of page ${p.page} (${guidance}):\n${p.text.slice(0, 8000)}`,
      });
    }
  }
  content.push({
    type: 'text',
    text: 'Extract every Schedule of Activities table on these pages as the compact JSON object described in your instructions. Return only JSON.',
  });
  return content;
}

export const VISION_LOCATE_PROMPT = `You look at protocol page images and decide which physical pages contain a Schedule of Activities (SoA) table or its footnotes.

An SoA is a visit × assessment grid (any title: Schedule of Activities/Events/Assessments/Measures, Time and Events, Study Flow Chart, Table of Events, Visit Schedule, or untitled). Include continuation pages and footnote-only overflow pages. Exclude table-of-contents listings and narrative mentions.

Return ONLY JSON: {"pages":[<1-based page numbers>],"notes":"brief reason"}`;

export function parseExtraction(raw: string): SoAExtraction {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model output');
  s = s.slice(start, end + 1);
  const obj = JSON.parse(s) as { tables?: unknown[] };
  return expandExtraction(obj as { tables: never[] });
}
