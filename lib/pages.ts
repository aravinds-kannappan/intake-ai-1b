import type { PageSignal } from './soa-types';

/** Drop narrative pages that the locator over-included so we send fewer images. */
export function trimCandidatePages(
  pages: number[],
  signals: PageSignal[],
  minScore = 3
): number[] {
  if (pages.length <= 2) return pages;
  const byPage = new Map(signals.map((s) => [s.page, s]));
  const kept = pages.filter((p) => {
    const s = byPage.get(p);
    if (!s) return true;
    if (s.score >= minScore) return true;
    return s.signals.some(
      (x) =>
        x.startsWith('title') ||
        x.includes('grid') ||
        x.includes('footnote') ||
        x.includes('continuation') ||
        x.includes('numbered visit')
    );
  });
  // Never drop the first/last of the range if anything remains — footnotes often sit at ends.
  if (!kept.length) return pages.slice(0, Math.min(4, pages.length));
  const first = pages[0];
  const last = pages[pages.length - 1];
  const set = new Set(kept);
  if (!set.has(first)) kept.unshift(first);
  if (!set.has(last)) kept.push(last);
  return Array.from(new Set(kept)).sort((a, b) => a - b);
}

export function chunkPages<T>(pages: T[], size = 1): T[][] {
  if (pages.length <= size) return [pages];
  const chunks: T[][] = [];
  for (let i = 0; i < pages.length; i += size) {
    chunks.push(pages.slice(i, i + size));
  }
  return chunks;
}
