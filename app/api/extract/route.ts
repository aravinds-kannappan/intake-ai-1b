import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODEL,
  EXTRACTION_SYSTEM_PROMPT,
  buildUserContent,
} from '@/lib/extraction';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface ExtractRequest {
  pages: { page: number; imageBase64: string; mediaType: string; text?: string }[];
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
  if (body.pages.length > 12) {
    return Response.json(
      { error: 'Too many pages in one extraction request (max 12)' },
      { status: 400 }
    );
  }

  const client = new Anthropic();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const msgStream = client.messages.stream({
          model: DEFAULT_MODEL,
          max_tokens: 64000,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              content: buildUserContent(body.pages) as any,
            },
          ],
        });
        for await (const event of msgStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await msgStream.finalMessage();
        if (final.stop_reason === 'max_tokens') {
          controller.enqueue(
            encoder.encode('\n\n[[ERROR: model hit the output token limit; table too large for one pass]]')
          );
        }
        controller.close();
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `\n\n[[ERROR: ${err instanceof Error ? err.message : String(err)}]]`
          )
        );
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
