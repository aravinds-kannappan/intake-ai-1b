// Batch extraction over local protocol PDFs. Produces the committed outputs in
// outputs/ and public/outputs/. Uses the exact same locator and extraction
// prompt as the web app; only the page rasterizer differs (poppler's pdftoppm
// here, pdf.js canvas in the browser).
//
// Local-only requirements (NOT needed to run the web app):
//   - poppler (`brew install poppler`) for pdftoppm
//   - ANTHROPIC_API_KEY in the environment
//
// Usage: npx tsx scripts/extract-batch.ts /path/to/protocol1.pdf [more.pdf ...]

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { locateSoA } from '../lib/locator';
import {
  DEFAULT_MODEL,
  EXTRACTION_SYSTEM_PROMPT,
  buildUserContent,
  parseExtraction,
} from '../lib/extraction';
import type { SoAExtraction } from '../lib/soa-types';

async function pageTextsOf(pdfPath: string): Promise<string[]> {
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

function renderPages(pdfPath: string, pages: number[], tmpDir: string) {
  mkdirSync(tmpDir, { recursive: true });
  const out: { page: number; imageBase64: string; mediaType: string }[] = [];
  for (const p of pages) {
    const prefix = join(tmpDir, `pg-${p}`);
    execFileSync('pdftoppm', [
      '-jpeg', '-jpegopt', 'quality=80', '-r', '150',
      '-f', String(p), '-l', String(p), pdfPath, prefix,
    ]);
    const file = readdirSync(tmpDir).find((f) => f.startsWith(`pg-${p}`) && f.endsWith('.jpg'));
    if (!file) throw new Error(`pdftoppm produced no image for page ${p}`);
    out.push({
      page: p,
      imageBase64: readFileSync(join(tmpDir, file)).toString('base64'),
      mediaType: 'image/jpeg',
    });
  }
  return out;
}

async function extractOne(pdfPath: string): Promise<SoAExtraction> {
  const name = basename(pdfPath).replace(/\.pdf$/i, '');
  console.log(`\n=== ${name} ===`);
  const texts = await pageTextsOf(pdfPath);
  const { candidates } = locateSoA(texts);
  console.log(
    `locator: ${candidates.length} candidates:`,
    candidates.map((c) => `p${c.pages[0]}-${c.pages[c.pages.length - 1]} (score ${c.score})`).join(', ')
  );
  if (!candidates.length) throw new Error('locator found no SoA candidate');

  // Batch policy (same spirit as the UI, where the user picks): take every
  // candidate scoring at least 40% of the best one, capped at 3, so genuine
  // sub-schedules survive while low-scoring noise is dropped.
  const best = candidates[0].score;
  const chosen = candidates.filter((c) => c.score >= 0.4 * best).slice(0, 3);
  console.log(`extracting ${chosen.length} candidate region(s)`);

  const client = new Anthropic();
  const allTables: SoAExtraction['tables'] = [];
  const tmpDir = join(process.env.TMPDIR || '/tmp', `soa-${name}`);
  for (const cand of chosen) {
    const images = renderPages(pdfPath, cand.pages, tmpDir);
    const pages = images.map((img) => ({
      ...img,
      text: texts[img.page - 1],
    }));
    console.log(`  calling ${DEFAULT_MODEL} on pages ${cand.pages.join(',')} ...`);
    const msg = await client.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 64000,
      system: EXTRACTION_SYSTEM_PROMPT,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: 'user', content: buildUserContent(pages) as any }],
    }).finalMessage();
    if (msg.stop_reason === 'max_tokens') {
      throw new Error('model hit max_tokens; table too large for one pass');
    }
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    const parsed = parseExtraction(text);
    for (const t of parsed.tables) {
      t.id = `t${allTables.length + 1}`;
      allTables.push(t);
    }
    console.log(
      `  got ${parsed.tables.length} table(s): ${parsed.tables
        .map((t) => `"${t.title}" ${t.columns.length}c x ${t.rows.length}r, ${t.footnotes.length} fn`)
        .join('; ')}`
    );
  }
  rmSync(tmpDir, { recursive: true, force: true });

  return {
    tables: allTables,
    model: DEFAULT_MODEL,
    extractedAt: new Date().toISOString(),
    sourceFile: basename(pdfPath),
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: npx tsx scripts/extract-batch.ts <protocol.pdf> [...]');
    process.exit(1);
  }
  mkdirSync('outputs', { recursive: true });
  mkdirSync('public/outputs', { recursive: true });
  for (const f of files) {
    try {
      const result = await extractOne(f);
      const name = basename(f).replace(/\.pdf$/i, '');
      const json = JSON.stringify(result, null, 2);
      writeFileSync(join('outputs', `${name}.json`), json);
      writeFileSync(join('public', 'outputs', `${name}.json`), json);
      console.log(`wrote outputs/${name}.json`);
    } catch (e) {
      console.error(`FAILED ${f}:`, e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  }
}

main();
