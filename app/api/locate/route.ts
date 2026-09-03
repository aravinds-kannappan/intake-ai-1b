import Anthropic from '@anthropic-ai/sdk';
import { LOCATE_MODEL, VISION_LOCATE_PROMPT } from '@/lib/extraction';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface LocateRequest {
  pages: { page: number; imageBase64: string; mediaType: string }[];
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY is not set on the server.' },
      { status: 500 }
    );
  }

  let body: LocateRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.pages?.length) {
    return Response.json({ error: 'No pages provided' }, { status: 400 });
  }
  if (body.pages.length > 20) {
    return Response.json({ error: 'Vision locate accepts at most 20 pages per call' }, { status: 400 });
  }

  const client = new Anthropic();
  const content: unknown[] = [
    {
      type: 'text',
      text: 'Identify which of these protocol pages contain an SoA table or its footnotes.',
    },
  ];
  for (const p of body.pages) {
    content.push({ type: 'text', text: `Page ${p.page}:` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: p.mediaType || 'image/jpeg',
        data: p.imageBase64,
      },
    });
  }

  const msg = await client.messages.create({
    model: LOCATE_MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system: VISION_LOCATE_PROMPT,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: 'user', content: content as any }],
  });
  const raw = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return Response.json({ error: 'Vision locator returned no JSON', raw }, { status: 502 });
  }
  let parsed: { pages?: number[]; notes?: string };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return Response.json({ error: 'Vision locator JSON was not parseable', raw }, { status: 502 });
  }
  const pages = Array.from(new Set((parsed.pages || []).filter((n) => Number.isInteger(n)))).sort(
    (a, b) => a - b
  );
  return Response.json({ pages, notes: parsed.notes || '', model: LOCATE_MODEL });
}
