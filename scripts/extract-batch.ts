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
//
// Emits per-phase timings to stderr and a machine-readable summary line
// (starting with "TIMING") so bench harnesses can aggregate.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { locateSoA } from '../lib/locator';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EXTRACTION_SYSTEM_BLOCKS,
  QUALITY_MODEL,
  buildUserContent,
  parseExtraction,
} from '../lib/extraction';
import { chunkPages, mergeExtractions } from '../lib/merge';
import type { SoAExtraction } from '../lib/soa-types';

interface CandTiming {
  pages: number[];
  renderMs: number;
  imageBytes: number;
  firstByteMs: number;      // wall time from send until the first output token
  streamMs: number;         // wall time from send until stop
  outputTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputChars: number;
  tokensPerSec: number;
  tables: number;
  cols: number;
  rows: number;
  footnotes: number;
}

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

async function extractOne(pdfPath: string): Promise<{ result: SoAExtraction; timings: { locateMs: number; parseTextMs: number; cands: CandTiming[]; totalMs: number } }> {
  const name = basename(pdfPath).replace(/\.pdf$/i, '');
  const t0 = Date.now();
  console.log(`\n=== ${name} ===`);
  const tText0 = Date.now();
  const texts = await pageTextsOf(pdfPath);
  const parseTextMs = Date.now() - tText0;
  const tLoc0 = Date.now();
  const { candidates } = locateSoA(texts);
  const locateMs = Date.now() - tLoc0;
  console.log(
    `locator: ${candidates.length} candidates (text extract ${parseTextMs}ms, locate ${locateMs}ms):`,
    candidates.map((c) => `p${c.pages[0]}-${c.pages[c.pages.length - 1]} (score ${c.score})`).join(', ')
  );
  if (!candidates.length) throw new Error('locator found no SoA candidate');

  const best = candidates[0].score;
  const chosen = candidates.filter((c) => c.score >= 0.4 * best).slice(0, 3);
  console.log(`extracting ${chosen.length} candidate region(s)`);

  const client = new Anthropic();
  const candTimings: CandTiming[] = [];
  const tmpDir = join(process.env.TMPDIR || '/tmp', `soa-${name}`);
  const model = process.env.SOA_QUALITY === '1' ? QUALITY_MODEL : DEFAULT_MODEL;

  // Parallel 2-page chunks across candidates. Wall time tracks the slowest
  // chunk, not the sum, which is what makes large SoAs finish faster.
  const textOnly = process.env.SOA_TEXT_ONLY === '1';
  const perCand = await Promise.all(
    chosen.map(async (cand) => {
      const tRender0 = Date.now();
      const images = textOnly ? [] : renderPages(pdfPath, cand.pages, tmpDir);
      const renderMs = Date.now() - tRender0;
      const imageBytes = images.reduce((a, i) => a + i.imageBase64.length, 0);
      const pages = textOnly
        ? cand.pages.map((p) => ({ page: p, text: texts[p - 1] }))
        : images.map((img) => ({
            ...img,
            text: texts[img.page - 1],
          }));
      const chunks = chunkPages(pages, 2);
      console.log(
        `  ${model} effort=${DEFAULT_EFFORT} on pages ${cand.pages.join(',')} ` +
        `(${chunks.length} chunk(s), render ${renderMs}ms, ${(imageBytes / 1024).toFixed(0)}KB base64) ...`
      );

      const tSend = Date.now();
      let firstByteMs = -1;
      let outputChars = 0;
      let outputTokens = 0;
      let inputTokens = 0;
      let cachedInputTokens = 0;
      const chunkResults = await Promise.all(
        chunks.map(async (chunk) => {
          const stream = client.messages.stream({
            model,
            max_tokens: 64000,
            output_config: { effort: DEFAULT_EFFORT },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            system: EXTRACTION_SYSTEM_BLOCKS as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: [{ role: 'user', content: buildUserContent(chunk) as any }],
          });
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              if (firstByteMs < 0) firstByteMs = Date.now() - tSend;
              outputChars += event.delta.text.length;
            }
          }
          const msg = await stream.finalMessage();
          if (msg.stop_reason === 'max_tokens') {
            throw new Error('model hit max_tokens; table too large for one pass');
          }
          const text = msg.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('');
          const usage = msg.usage as {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
          };
          outputTokens += usage.output_tokens;
          inputTokens += usage.input_tokens;
          cachedInputTokens += usage.cache_read_input_tokens || 0;
          return parseExtraction(text);
        })
      );
      const parsed = mergeExtractions(chunkResults);
      const streamMs = Date.now() - tSend;
      const cols = parsed.tables.reduce((a, t) => a + t.columns.length, 0);
      const rows = parsed.tables.reduce((a, t) => a + t.rows.length, 0);
      const footnotes = parsed.tables.reduce((a, t) => a + t.footnotes.length, 0);
      const tokensPerSec = outputTokens / Math.max(0.001, (streamMs - Math.max(firstByteMs, 0)) / 1000);
      console.log(
        `  got ${parsed.tables.length} table(s) on p${cand.pages.join(',')}, ${cols} cols x ${rows} rows, ${footnotes} fn | ` +
        `first-byte ${firstByteMs}ms, stream ${streamMs}ms, ` +
        `in=${inputTokens}tok out=${outputTokens}tok, ` +
        `${tokensPerSec.toFixed(1)} tok/s output`
      );
      return {
        parsed,
        timing: {
          pages: cand.pages,
          renderMs,
          imageBytes,
          firstByteMs,
          streamMs,
          outputTokens,
          inputTokens,
          cachedInputTokens,
          outputChars,
          tokensPerSec,
          tables: parsed.tables.length,
          cols,
          rows,
          footnotes,
        } as CandTiming,
      };
    })
  );
  const allTables: SoAExtraction['tables'] = [];
  for (const r of perCand) {
    for (const t of r.parsed.tables) {
      t.id = `t${allTables.length + 1}`;
      allTables.push(t);
    }
    candTimings.push(r.timing);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  const totalMs = Date.now() - t0;

  return {
    result: {
      tables: allTables,
      model: process.env.SOA_QUALITY === '1' ? QUALITY_MODEL : DEFAULT_MODEL,
      extractedAt: new Date().toISOString(),
      sourceFile: basename(pdfPath),
    },
    timings: { locateMs, parseTextMs, cands: candTimings, totalMs },
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
  mkdirSync('bench', { recursive: true });
  const all: unknown[] = [];
  for (const f of files) {
    const runStart = Date.now();
    try {
      const { result, timings } = await extractOne(f);
      const name = basename(f).replace(/\.pdf$/i, '');
      const json = JSON.stringify(result, null, 2);
      writeFileSync(join('outputs', `${name}.json`), json);
      writeFileSync(join('public', 'outputs', `${name}.json`), json);
      console.log(`wrote outputs/${name}.json (total ${timings.totalMs}ms)`);
      console.log(
        `TIMING ${name} total=${timings.totalMs}ms text=${timings.parseTextMs}ms locate=${timings.locateMs}ms ` +
        timings.cands.map((c, i) => `cand${i + 1}[render=${c.renderMs}ms firstByte=${c.firstByteMs}ms stream=${c.streamMs}ms tok/s=${c.tokensPerSec.toFixed(1)} out=${c.outputTokens}]`).join(' ')
      );
      all.push({ file: basename(f), success: true, timings, tables: result.tables.length });
    } catch (e) {
      const totalMs = Date.now() - runStart;
      console.error(`FAILED ${f}: ${e instanceof Error ? e.message : e} (after ${totalMs}ms)`);
      all.push({ file: basename(f), success: false, error: e instanceof Error ? e.message : String(e), totalMs });
      process.exitCode = 1;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join('bench', `run-${stamp}.json`), JSON.stringify(all, null, 2));
  console.log(`\nbench summary written to bench/run-${stamp}.json`);
}

main();
