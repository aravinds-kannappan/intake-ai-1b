import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EXTRACTION_SYSTEM_BLOCKS,
  QUALITY_MODEL,
  buildUserContent,
  modelSupportsEffort,
  parseExtraction,
} from '@/lib/extraction';
import { chunkPages, mergeExtractions } from '@/lib/merge';
import type { SoAExtraction } from '@/lib/soa-types';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface ExtractRequest {
  pages: { page: number; imageBase64?: string; mediaType?: string; text?: string }[];
  quality?: boolean;
  model?: string;
  /** 1 = max parallelism (default). */
  chunkSize?: number;
}

function allowedModel(name: string | undefined, quality?: boolean): string {
  if (quality) return QUALITY_MODEL;
  if (!name) return DEFAULT_MODEL;
  if (
    name === 'claude-haiku-4-5' ||
    name === 'claude-haiku-4-5-20251001' ||
    name === 'claude-sonnet-5' ||
    name === 'claude-opus-5' ||
    name === DEFAULT_MODEL ||
    name === QUALITY_MODEL
  ) {
    return name;
  }
  return DEFAULT_MODEL;
}

async function extractChunk(
  client: Anthropic,
  model: string,
  pages: ExtractRequest['pages']
): Promise<SoAExtraction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model,
    max_tokens: 16000,
    system: EXTRACTION_SYSTEM_BLOCKS,
    messages: [
      {
        role: 'user',
        content: buildUserContent(pages),
      },
    ],
  };
  if (modelSupportsEffort(model)) {
    params.output_config = { effort: DEFAULT_EFFORT };
  }

  const stream = client.messages.stream(params);
  let raw = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      raw += event.delta.text;
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'max_tokens') {
    throw new Error('model hit the output token limit; table too large for one pass');
  }
  return parseExtraction(raw);
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error:
          'ANTHROPIC_API_KEY is not set on the server. Add it to .env.local (local) or the Vercel project settings (deployed).',
      },
      { status: 500 }
    );
  }

  let body: ExtractRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.pages?.length) {
    return Response.json({ error: 'No pages provided' }, { status: 400 });
  }
  if (body.pages.length > 24) {
    return Response.json(
      { error: 'Too many pages in one extraction request (max 24)' },
      { status: 400 }
    );
  }

  const model = allowedModel(body.model, body.quality);
  const client = new Anthropic();
  const encoder = new TextEncoder();
  const chunkSize = Math.max(1, Math.min(3, body.chunkSize ?? 1));
  const chunks = chunkPages(body.pages, chunkSize);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        send(
          `[[STATUS: ${chunks.length} parallel chunk${chunks.length === 1 ? '' : 's'} on ${model}]]\n`
        );
        const parts = await Promise.all(
          chunks.map(async (pages, i) => {
            send(
              `[[STATUS: chunk ${i + 1}/${chunks.length} pages ${pages.map((p) => p.page).join(',')} started]]\n`
            );
            const extracted = await extractChunk(client, model, pages);
            send(
              `[[STATUS: chunk ${i + 1}/${chunks.length} done · ${extracted.tables.length} table(s)]]\n`
            );
            return extracted;
          })
        );
        const merged = mergeExtractions(parts);
        merged.model = model;
        send(JSON.stringify(merged));
        controller.close();
      } catch (err) {
        send(`\n\n[[ERROR: ${err instanceof Error ? err.message : String(err)}]]`);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
