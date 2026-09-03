// Measures raw model latency for the SoA extraction call: image encoding,
// first-byte time, streaming throughput, and total. Uses one small, one large
// candidate to isolate what changes with page count vs table size.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODEL,
  EXTRACTION_SYSTEM_PROMPT,
  buildUserContent,
} from '../lib/extraction';

interface Case {
  label: string;
  pdf: string;
  pages: number[];
}

const CASES: Case[] = [
  { label: 'small_1page', pdf: '/Users/aravindkannappan/Desktop/takehome-1b/protocol1.pdf', pages: [53] },
  { label: 'wide_3pages_rotated', pdf: '/Users/aravindkannappan/Desktop/takehome-1b/protocol9.pdf', pages: [26, 27, 28] },
];

function render(pdf: string, pages: number[], tmp: string) {
  mkdirSync(tmp, { recursive: true });
  const out: { page: number; imageBase64: string; mediaType: string }[] = [];
  for (const p of pages) {
    const prefix = join(tmp, `pg-${p}`);
    execFileSync('pdftoppm', [
      '-jpeg', '-jpegopt', 'quality=80', '-r', '150',
      '-f', String(p), '-l', String(p), pdf, prefix,
    ]);
    const file = readdirSync(tmp).find((f) => f.startsWith(`pg-${p}`) && f.endsWith('.jpg'))!;
    out.push({
      page: p,
      imageBase64: readFileSync(join(tmp, file)).toString('base64'),
      mediaType: 'image/jpeg',
    });
  }
  return out;
}

async function measure(c: Case) {
  const client = new Anthropic();
  const tmp = join(process.env.TMPDIR || '/tmp', 'lat-' + c.label);
  const t0 = Date.now();
  const imgs = render(c.pdf, c.pages, tmp);
  const renderMs = Date.now() - t0;
  const bytes = imgs.reduce((a, i) => a + i.imageBase64.length, 0);

  const tSend = Date.now();
  let firstByteMs = -1;
  let chars = 0;
  let firstFewSecOut = 0;
  const stream = client.messages.stream({
    model: DEFAULT_MODEL,
    max_tokens: 64000,
    system: EXTRACTION_SYSTEM_PROMPT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: 'user', content: buildUserContent(imgs.map((i) => ({ ...i }))) as any }],
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      if (firstByteMs < 0) firstByteMs = Date.now() - tSend;
      chars += event.delta.text.length;
      if (Date.now() - tSend < firstByteMs + 5000) firstFewSecOut = chars;
    }
  }
  const msg = await stream.finalMessage();
  const totalMs = Date.now() - tSend;
  const u = msg.usage as { input_tokens: number; output_tokens: number };
  rmSync(tmp, { recursive: true, force: true });
  console.log(
    `${c.label} (${basename(c.pdf)} pages ${c.pages.join(',')}): ` +
    `render=${renderMs}ms images=${(bytes/1024).toFixed(0)}KB ` +
    `first-byte=${firstByteMs}ms total=${totalMs}ms ` +
    `input=${u.input_tokens}tok output=${u.output_tokens}tok ` +
    `tok/s=${(u.output_tokens / ((totalMs - firstByteMs) / 1000)).toFixed(1)} ` +
    `stop=${msg.stop_reason}`
  );
}

async function main() {
  for (const c of CASES) {
    try {
      await measure(c);
    } catch (e) {
      console.log(`${c.label}: FAILED ${e instanceof Error ? e.message : e}`);
    }
  }
}
main();
