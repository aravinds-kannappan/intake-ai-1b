import { readFileSync } from 'node:fs';
import { scorePage } from '../lib/locator';

async function pageTextsOf(pdfPath: string): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data }).promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = (tc.items as { str: string; transform: number[] }[]).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: string[] = []; let curY: number | null = null; let cur: string[] = [];
    for (const it of items) {
      if (curY === null || Math.abs(it.y - curY) > 4) { if (cur.length) lines.push(cur.join(' ')); cur = []; curY = it.y; }
      if (it.str.trim()) cur.push(it.str);
    }
    if (cur.length) lines.push(cur.join(' '));
    texts.push(lines.join('\n'));
  }
  return texts;
}

async function main() {
  const [file, a, b] = process.argv.slice(2);
  const texts = await pageTextsOf(file);
  for (let p = parseInt(a); p <= parseInt(b); p++) {
    const s = scorePage(texts[p - 1], p);
    console.log(`p${p}: score=${s.score} [${s.signals.join(' | ')}]`);
    console.log('  first lines:', JSON.stringify(texts[p - 1].split('\n').slice(0, 4)).slice(0, 300));
  }
}
main();
