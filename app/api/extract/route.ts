import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EXTRACTION_SYSTEM_BLOCKS,
  QUALITY_MODEL,
  buildUserContent,
  parseExtraction,
} from '@/lib/extraction';
import { chunkPages, mergeExtractions } from '@/lib/merge';
import type { SoAExtraction } from '@/lib/soa-types';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface ExtractRequest {
  pages: { page: number; imageBase64: string; mediaType: string; text?: string }[];
  quality?: boolean;
  model?: string;
}

function allowedModel(name: string | undefined): string {
  if (name === 'claude-opus-5' || name === QUALITY_MODEL) return QUALITY_MODEL;
  if (name === 'claude-sonnet-5' || name === DEFAULT_MODEL) return name;
  return DEFAULT_MODEL;
}

async function extractChunk(
  client: Anthropic,
  model: string,
  pages: ExtractRequest['pages'],
  onDelta: (text: string) => void
): Promise<SoAExtraction> {
  const stream = client.messages.stream({
    model,
    max_tokens: 64000,
    output_config: { effort: DEFAULT_EFFORT },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    system: EXTRACTION_SYSTEM_BLOCKS as any,
    messages: [
      {
        role: 'user',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: buildUserContent(pages) as any,
      },
    ],
  });
  let raw = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      raw += event.delta.text;
      onDelta(event.delta.text);
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

  const model = allowedModel(body.quality ? QUALITY_MODEL : body.model);
  const client = new Anthropic();
  const encoder = new TextEncoder();
  const chunks = chunkPages(body.pages, 2);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        send(
          `[[STATUS: ${chunks.length} parallel chunk${chunks.length === 1 ? '' : 's'} on ${model}, effort=${DEFAULT_EFFORT}]]\n`
        );
        const parts = await Promise.all(
          chunks.map(async (pages, i) => {
            send(`[[STATUS: chunk ${i + 1}/${chunks.length} pages ${pages.map((p) => p.page).join(',')} started]]\n`);
            const extracted = await extractChunk(client, model, pages, () => {
              // Keep the connection alive; the UI keys off STATUS lines.
            });
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
