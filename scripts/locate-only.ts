// Runs only the locator against one or more PDFs. Used for benchmarking and
// debugging without spending API credits.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { locateSoA } from '../lib/locator';

async function textsOf(pdfPath: string) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = (tc.items as { str: string; transform: number[] }[])
      .filter((it) => it.str !== undefined)
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: string[] = [];
    let curY: number | null = null;
    let cur: string[] = [];
    for (const it of items) {
      if (curY === null || Math.abs(it.y - curY) > 4) {
        if (cur.length) lines.push(cur.join(' '));
        cur = [];
        curY = it.y;
      }
      if (it.str.trim()) cur.push(it.str);
    }
    if (cur.length) lines.push(cur.join(' '));
    texts.push(lines.join('\n'));
  }
  return texts;
}

async function main() {
  for (const f of process.argv.slice(2)) {
    const texts = await textsOf(f);
    const { candidates } = locateSoA(texts);
    console.log(`\n${basename(f)} (${texts.length} pages)`);
    for (const c of candidates.slice(0, 5)) {
      console.log(`  p${c.pages[0]}-${c.pages[c.pages.length - 1]} score=${c.score} "${c.titleGuess.slice(0, 80)}"`);
    }
    if (!candidates.length) console.log('  NO CANDIDATES');
  }
}
main();
