import type { SoAExtraction } from './soa-types';
import { expandExtraction } from './compact';

// Shared between the API route and the local batch script.

export const DEFAULT_MODEL = process.env.SOA_MODEL || 'claude-haiku-4-5';
export const QUALITY_MODEL = process.env.SOA_QUALITY_MODEL || 'claude-sonnet-5';
export const LOCATE_MODEL = process.env.SOA_LOCATE_MODEL || 'claude-haiku-4-5';
export const DEFAULT_EFFORT = (process.env.SOA_EFFORT || 'low') as 'low' | 'medium' | 'high';

// Haiku does not take output_config.effort; Sonnet/Opus do.
export function modelSupportsEffort(model: string): boolean {
  return /sonnet|opus|fable|mythos/i.test(model);
}

export const EXTRACTION_SYSTEM_PROMPT = `Extract every Schedule of Activities / Events / Assessments / Measures / Time-and-Events / Visit Schedule / Study Flow Chart grid from the page image(s). Text layer is backup for exact wording only.

Rules: verbatim cell values (never boolean); never drop rows/columns; merge continuation pages; full footnotes; category rows are structure (k:c); no invented cells; ambiguities go in amb.

Return ONLY compact JSON (no markdown):
{"tables":[{
  "title":"...",
  "pages":[n],
  "columns":[[path0,label,vn,day,week,window], ...],
  "rows":[
    {"k":"c","lab":"Safety"},
    {"k":"a","lab":"ECG","cat":"Safety","c":{"0":"X","3":["X","a"]}}
  ],
  "fn":[["a","footnote text"],["*","star note"]],
  "notes":[],
  "amb":[]
}]}

columns[i] = [periodOr"", visitLabel, visitNumber|null, studyDay|null, studyWeek|null, window|null]
rows[].c = sparse map of column INDEX (string) -> value OR [value, marker...]
Omit empty cells. k=c category (no c), k=a assessment. Do not emit appliesTo.`;

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
    content.push({
      type: 'text',
      text: `--- page ${p.page} ---`,
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
      const slice = p.text.slice(0, hasImage ? 3500 : 12000);
      content.push({
        type: 'text',
        text: hasImage
          ? `text backup:\n${slice}`
          : `text (primary — reconstruct grid from alignment):\n${slice}`,
      });
    }
  }
  content.push({
    type: 'text',
    text: 'Return compact SoA JSON only.',
  });
  return content;
}

export const VISION_LOCATE_PROMPT = `Which pages contain a Schedule of Activities table or its footnotes? Include continuations. Exclude TOC and narrative mentions.
Return ONLY JSON: {"pages":[<1-based>],"notes":""}`;

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
