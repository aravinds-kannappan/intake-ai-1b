import type { SoAExtraction } from './soa-types';

// Shared between the API route and the local batch script.

export const DEFAULT_MODEL = process.env.SOA_MODEL || 'claude-sonnet-5';

export const EXTRACTION_SYSTEM_PROMPT = `You are a clinical protocol Schedule of Activities (SoA) extraction engine.
You receive page images from a clinical trial protocol PDF (with the raw text
layer of each page as backup). The pages contain one or more SoA tables, also
known as Schedule of Events, Time and Events Schedule, Schedule of Assessments,
Study Flow Chart, or Schedule of Measures. Your job is to produce a faithful,
machine-readable representation of every schedule table on these pages.

Non-negotiable rules:

1. BE FAITHFUL, NOT CLEVER. Copy cell values verbatim: "X", "3X", "X (if
   applicable)", "3X/week", "Weekly x 2 weeks", "Prior to Day 4", "1&2", "(X)",
   doses, volumes, arrows. Never normalize to booleans. Never infer, repair, or
   resolve what the document says. If something is genuinely ambiguous, record
   it in "ambiguities" instead of quietly picking an interpretation.
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
   kind:"category" rows, not assessments; every assessment row records its
   governing category.
6. Vertical or rotated header text (e.g. RANDOMIZATION printed letter by letter
   down a column divider) is usually a milestone divider between column groups,
   not a data column. Represent it as a column with its verbatim label and note
   it in ambiguities if its role is unclear.

Output: a single JSON object, no markdown fences, no commentary, matching:

{
  "tables": [
    {
      "id": "t1",
      "title": "verbatim table title",
      "pages": [<1-based page numbers as labeled in the user message>],
      "columns": [
        { "id": "c1", "path": ["study period", "sub-period if any"],
          "label": "visit label as printed", "visitNumber": "1" | null,
          "studyDay": "as printed" | null, "studyWeek": "as printed" | null,
          "window": "as printed" | null, "markers": ["a"] }
      ],
      "rows": [
        { "id": "r1", "kind": "category" | "assessment",
          "label": "verbatim row header", "category": "governing category" | null,
          "markers": [], "cells": [
            { "col": "c1", "value": "verbatim", "markers": ["b"], "colspan": 3 }
          ] }
      ],
      "footnotes": [
        { "marker": "as printed", "text": "full verbatim text",
          "continuedAcrossPages": false,
          "appliesTo": [ { "target": "cell", "row": "r4", "col": "c2" },
                         { "target": "column", "col": "c1" },
                         { "target": "row", "row": "r2" },
                         { "target": "table" } ] }
      ],
      "notes": ["verbatim table-level notes and abbreviation lines without a marker"],
      "ambiguities": ["plain-language description of anything not faithfully representable"]
    }
  ]
}

Schema conventions:
- "cells" is sparse: include only cells with printed content. Do not invent
  empty cells. Use "colspan" > 1 only when one printed value visibly spans
  several columns (e.g. "Prior to Day 4" across days 1-3).
- If a marker is printed fused to the value (like "Xa" meaning X with
  superscript a), set value to what is printed for the act itself ("X") and put
  the marker in "markers", using the exact key the footnote block uses (if the
  footnote block says "Xa = ...", the marker is "Xa").
- Column order and row order must match the document exactly.
- Every distinct schedule table on the pages is its own entry in "tables". Do
  not merge different tables (e.g. a blood-collection sub-schedule is separate
  from the main schedule).
- Footnote "appliesTo" must list every location whose marker matches; if a
  footnote's marker appears nowhere, use {"target":"table"}.

Return ONLY the JSON object.`;

export function buildUserContent(
  pages: { page: number; imageBase64?: string; mediaType?: string; text?: string }[]
): unknown[] {
  const content: unknown[] = [];
  for (const p of pages) {
    content.push({
      type: 'text',
      text: `--- PDF page ${p.page} (image${p.text ? ' + text layer' : ''}) ---`,
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
      content.push({
        type: 'text',
        text: `Text layer of page ${p.page} (may scramble table layout, use only as backup for exact wording):\n${p.text.slice(0, 6000)}`,
      });
    }
  }
  content.push({
    type: 'text',
    text: 'Extract every Schedule of Activities table on these pages as the JSON object described in your instructions. Return only JSON.',
  });
  return content;
}

// Tolerant JSON recovery: strips markdown fences and leading/trailing prose.
export function parseExtraction(raw: string): SoAExtraction {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model output');
  s = s.slice(start, end + 1);
  const obj = JSON.parse(s) as SoAExtraction;
  if (!Array.isArray(obj.tables)) throw new Error('Model output missing "tables" array');
  return obj;
}
