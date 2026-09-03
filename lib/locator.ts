import type { PageSignal, SoACandidate } from './soa-types';

// Deterministic SoA locator. Input: plain text of every page (reading order).
// Output: scored per-page signals and contiguous candidate page ranges.
// No page numbers are hardcoded; everything is derived from the text.
// Tuned to sponsor vocabulary variance, not to the five assignment PDFs.

const TITLE_RE =
  /(schedule\s+of\s+(events|activities|assessments?|measures|procedures|visits|evaluations|observations|blood\s+collections)|time\s+and\s+events(\s+schedule)?|study\s+flow\s*charts?|table\s+of\s+events|overview\s+of\s+study\s+(assessments|procedures|activities)|study\s+procedures?\s+(table|schedule)|assessment\s+schedule|visit\s+schedule|activities\s+by\s+visit|planned\s+assessments|study\s+calendar|time[\s-]?event\s+schedule|flow\s*chart\s+of\s+(assessments|activities|procedures)|schedule\s+of\s+assessments\s+and\s+procedures)/i;

const CONTINUATION_RE = /\b(continued|concluded|cont['’]?d|\(cont)/i;

const HEADER_KEYWORDS = [
  /\bstudy\s+day\b/i,
  /\bstudy\s+week\b/i,
  /\bvisit\b/i,
  /\bscreening\b/i,
  /\bbaseline\b/i,
  /\bfollow[\s-]?up\b/i,
  /\btreatment\b/i,
  /\bdischarge\b/i,
  /\bwashout\b/i,
  /\brandomi[sz]ation\b/i,
  /\bend\s+of\s+(treatment|trial|study)\b/i,
  /\benrollment\b/i,
  /\bpredose\b/i,
  /\bcycle\s+\d+\b/i,
  /\bweek\s+\d+\b/i,
];

// Tokens that look like SoA cell content. Not just "X": sponsors also use
// Y/N, checkmarks, frequencies (Q2W, BID), doses, and parenthesized marks.
const GRID_TOKEN_RE =
  /^\(?((?:[X✓✔√●•○]|[YN]|[0-9]+\s?[Xx]|[Xx][a-z0-9*†‡]?|Q\d+W|QD|BID|TID|PRN))\)?$/;

const FOOTNOTE_LINE_RE =
  /^\s*(\*{1,4}|†|‡|§|X?[a-z]|X?\d|\([a-z0-9]\)|[a-z]\d?)\s*[-–—=:.]\s+\S/;

const TOC_LINE_RE = /\.{5,}\s*\d+\s*$/;

function isHeadingLike(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 110) return false;
  if (TOC_LINE_RE.test(t)) return false;
  const m = t.match(TITLE_RE);
  if (!m) return false;
  const idx = m.index ?? 0;
  if (idx > 45) return false;
  if (/\b(see|refer(?:ring)? to|described in|provided in|shown in|provides?|will be|depending upon)\b/i.test(t)) {
    return false;
  }
  return true;
}

function isShortTabularLine(line: string): boolean {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (toks.length < 8) return false;
  const short = toks.filter((t) => t.length <= 8).length;
  return short / toks.length >= 0.7;
}

export function scorePage(text: string, page: number): PageSignal {
  const lines = text.split(/\n/);
  const signals: string[] = [];
  let score = 0;

  const tocLines = lines.filter((l) => TOC_LINE_RE.test(l)).length;
  const looksLikeToc = tocLines >= 4 || /table\s+of\s+contents/i.test(text);

  const titleLines = lines.filter(isHeadingLike);
  if (titleLines.length > 0 && !looksLikeToc) {
    score += 6;
    signals.push(`title: "${titleLines[0].trim().slice(0, 70)}"`);
    if (titleLines.some((l) => CONTINUATION_RE.test(l))) {
      score += 2;
      signals.push('continuation marker in title');
    }
  }
  if (looksLikeToc) signals.push('looks like a table of contents (titles ignored)');

  let headerHits = 0;
  for (const re of HEADER_KEYWORDS) if (re.test(text)) headerHits++;
  if (headerHits >= 3 && !looksLikeToc) {
    const pts = Math.min(4, headerHits - 2);
    score += pts;
    signals.push(`${headerHits} visit-header keywords`);
  }

  const headerRowLine = lines.find((l) => {
    if (!/\b(study\s+(day|week)|visit|week|cycle|day)\b/i.test(l)) return false;
    const nums = l.split(/\s+/).filter((w) => /^-?\d+\.?\d*\*?$/.test(w));
    return nums.length >= 3;
  });
  if (headerRowLine) {
    score += 3;
    signals.push('numbered visit/day header row');
  }

  const gridLines = lines.filter((l) => {
    const toks = l.trim().split(/\s+/);
    const gridToks = toks.filter((t) => GRID_TOKEN_RE.test(t));
    return gridToks.length >= 3;
  }).length;
  if (gridLines > 0) {
    const pts = Math.min(6, gridLines);
    score += pts;
    signals.push(`${gridLines} grid-like rows`);
  }

  const gridTokCount = text.split(/\s+/).filter((t) => GRID_TOKEN_RE.test(t)).length;
  if (gridTokCount >= 6) {
    const pts = Math.min(5, 1 + Math.floor(gridTokCount / 8));
    score += pts;
    signals.push(`${gridTokCount} grid tokens page-wide`);
  }

  const tabularLines = lines.filter(isShortTabularLine).length;
  if (tabularLines >= 4 && !looksLikeToc) {
    score += Math.min(3, Math.floor(tabularLines / 4));
    signals.push(`${tabularLines} dense tabular lines`);
  }

  const footnoteLines = lines.filter((l) => FOOTNOTE_LINE_RE.test(l)).length;
  if (footnoteLines >= 2) {
    score += 2;
    signals.push(`${footnoteLines} footnote-style lines`);
  }
  if (
    /footnotes?\s+to\s+(the\s+)?(flow\s*chart|table|schedule)/i.test(text) ||
    /notes\s+on\s+the\s+schedule/i.test(text) ||
    /notes?\s+(to|for)\s+(the\s+)?(table|schedule|soa)/i.test(text)
  ) {
    score += 4;
    signals.push('explicit footnote block heading');
  }

  const charCount = text.replace(/\s+/g, '').length;
  if (charCount < 40) {
    signals.push('almost no text (possible scan)');
  }

  return { page, score, signals };
}

const SEED_THRESHOLD = 8;
const MAX_CANDIDATE_PAGES = 12;

export function locateSoA(pageTexts: string[]): {
  pageSignals: PageSignal[];
  candidates: SoACandidate[];
} {
  const pageSignals = pageTexts.map((t, i) => scorePage(t, i + 1));

  const hasGrid = (s: PageSignal) =>
    s.signals.some((x) => x.includes('grid-like') || x.includes('grid tokens'));

  const isSeed = (s: PageSignal) =>
    s.score >= SEED_THRESHOLD &&
    (s.signals.some((x) => x.startsWith('title')) || hasGrid(s));

  const isExtension = (s: PageSignal) =>
    hasGrid(s) ||
    s.signals.some(
      (x) =>
        x.includes('continuation') ||
        x.includes('footnote-style') ||
        x.includes('footnote block') ||
        x.startsWith('title')
    );

  const used = new Set<number>();
  const candidates: SoACandidate[] = [];

  for (let i = 0; i < pageSignals.length; i++) {
    const s = pageSignals[i];
    if (used.has(s.page) || !isSeed(s)) continue;

    let start = i;
    let end = i;
    while (
      start > 0 &&
      !used.has(pageSignals[start - 1].page) &&
      end - start + 1 < MAX_CANDIDATE_PAGES &&
      (isExtension(pageSignals[start - 1]) ||
        pageSignals[start - 1].signals.some((x) => x.startsWith('title')))
    ) {
      start--;
    }
    while (
      end + 1 < pageSignals.length &&
      end - start + 1 < MAX_CANDIDATE_PAGES &&
      isExtension(pageSignals[end + 1])
    ) {
      end++;
    }

    const pages = pageSignals.slice(start, end + 1).map((p) => p.page);
    pages.forEach((p) => used.add(p));

    const titleSignal = pageSignals
      .slice(start, end + 1)
      .flatMap((p) => p.signals)
      .find((x) => x.startsWith('title: '));
    const titleGuess = titleSignal
      ? titleSignal.replace(/^title: "/, '').replace(/"$/, '')
      : `pages ${pages[0]}-${pages[pages.length - 1]}`;

    candidates.push({
      id: `cand-${candidates.length + 1}`,
      pages,
      score: pageSignals.slice(start, end + 1).reduce((acc, p) => acc + p.score, 0),
      titleGuess,
      signals: Array.from(
        new Set(pageSignals.slice(start, end + 1).flatMap((p) => p.signals))
      ),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { pageSignals, candidates };
}

export function textLooksScanned(pageTexts: string[]): boolean {
  if (!pageTexts.length) return true;
  const nonempty = pageTexts.filter((t) => t.replace(/\s+/g, '').length > 40);
  return nonempty.length / pageTexts.length < 0.25;
}
