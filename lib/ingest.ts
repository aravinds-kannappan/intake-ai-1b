/**
 * Browser-side document ingest for PDF, images, DOCX, and plain text.
 * Produces page texts (+ optional pre-rendered page images) for locate/extract.
 */

export type IngestKind = 'pdf' | 'image' | 'docx' | 'text';

export interface IngestedDoc {
  fileName: string;
  numPages: number;
  pageTexts: string[];
  /** 1-based page -> data URL when we already have pixels (images / rendered HTML). */
  pageDataUrls?: Record<number, string>;
  kind: IngestKind;
  /** pdf.js document, only for PDF. */
  pdfDoc?: unknown;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|html?|json)$/i;

function extOf(name: string): string {
  const m = name.match(/(\.[a-z0-9]+)$/i);
  return (m?.[1] || '').toLowerCase();
}

export function detectKind(file: File): IngestKind {
  const ext = extOf(file.name);
  const type = (file.type || '').toLowerCase();
  if (type === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (type.startsWith('image/') || IMAGE_EXT.test(ext)) return 'image';
  if (
    type.includes('wordprocessingml') ||
    type === 'application/msword' ||
    ext === '.docx' ||
    ext === '.doc'
  ) {
    return 'docx';
  }
  if (type.startsWith('text/') || TEXT_EXT.test(ext)) return 'text';
  // Fall back by sniffing later; treat unknown as text attempt
  if (ext === '.pdf') return 'pdf';
  return 'text';
}

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  return pdfjs;
}

async function ingestPdf(
  file: File,
  onProgress?: (msg: string) => void
): Promise<IngestedDoc> {
  const pdfjs = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`Extracting text: page ${i}/${doc.numPages}`);
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
    pageTexts.push(lines.join('\n'));
  }
  return {
    fileName: file.name,
    numPages: doc.numPages,
    pageTexts,
    kind: 'pdf',
    pdfDoc: doc,
  };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function ingestImage(file: File): Promise<IngestedDoc> {
  const dataUrl = await fileToDataUrl(file);
  return {
    fileName: file.name,
    numPages: 1,
    pageTexts: [''],
    pageDataUrls: { 1: dataUrl },
    kind: 'image',
  };
}

async function ingestImages(files: File[]): Promise<IngestedDoc> {
  const pageTexts: string[] = [];
  const pageDataUrls: Record<number, string> = {};
  for (let i = 0; i < files.length; i++) {
    pageDataUrls[i + 1] = await fileToDataUrl(files[i]);
    pageTexts.push('');
  }
  return {
    fileName: files.length === 1 ? files[0].name : `${files.length} images`,
    numPages: files.length,
    pageTexts,
    pageDataUrls,
    kind: 'image',
  };
}

function htmlToPlain(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  // Prefer table text with cell separators
  div.querySelectorAll('tr').forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('th,td')).map(
      (c) => (c.textContent || '').replace(/\s+/g, ' ').trim()
    );
    tr.replaceWith(document.createTextNode(cells.join('\t') + '\n'));
  });
  return (div.textContent || '').replace(/\n{3,}/g, '\n\n');
}

async function renderHtmlPages(
  html: string,
  onProgress?: (msg: string) => void
): Promise<{ texts: string[]; dataUrls: Record<number, string> }> {
  onProgress?.('Rendering Word/HTML tables...');
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1100px;background:#fff;color:#000;padding:24px;font:14px/1.35 Georgia,serif;';
  wrap.innerHTML = html;
  document.body.appendChild(wrap);

  // Split on page-break hints or large tables → one canvas for whole doc if small
  const tables = Array.from(wrap.querySelectorAll('table'));
  const chunks: HTMLElement[] = [];
  if (tables.length >= 1) {
    // Title/intro before first table as page 1 if substantial, then each table (+ following notes until next table)
    let cursor: Node | null = wrap.firstChild;
    let buf = document.createElement('div');
    const flush = () => {
      if ((buf.textContent || '').trim().length > 40 || buf.querySelector('table')) {
        chunks.push(buf);
        buf = document.createElement('div');
      }
    };
    while (cursor) {
      const next = cursor.nextSibling;
      if (cursor.nodeType === 1 && (cursor as HTMLElement).tagName === 'TABLE') {
        flush();
        const page = document.createElement('div');
        page.appendChild(cursor.cloneNode(true));
        // grab following sibling notes until next table / heading-ish
        let sib = next;
        while (sib && !(sib.nodeType === 1 && (sib as HTMLElement).tagName === 'TABLE')) {
          const n = sib.nextSibling;
          page.appendChild(sib.cloneNode(true));
          sib = n;
          if ((page.textContent || '').length > 4000) break;
        }
        chunks.push(page);
        buf = document.createElement('div');
        cursor = sib;
        continue;
      }
      buf.appendChild(cursor.cloneNode(true));
      cursor = next;
    }
    flush();
  } else {
    chunks.push(wrap);
  }

  const texts: string[] = [];
  const dataUrls: Record<number, string> = {};
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`Rasterizing section ${i + 1}/${chunks.length}...`);
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1100px;background:#fff;padding:16px;';
    host.appendChild(chunks[i]);
    document.body.appendChild(host);
    texts.push(htmlToPlain(host.innerHTML));
    // Canvas render
    const canvas = document.createElement('canvas');
    const scale = 1.25;
    const w = Math.min(1100, host.scrollWidth || 1100);
    const h = Math.min(1600, Math.max(host.scrollHeight, 200));
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    // foreignObject draw via SVG
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml" style="font:14px/1.35 Georgia,serif;color:#000;background:#fff;padding:12px;">
            ${host.innerHTML}
          </div>
        </foreignObject>
      </svg>`;
    const img = new Image();
    const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0);
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => resolve(); // fall through with blank; text still works
      img.src = svgUrl;
    });
    dataUrls[i + 1] = canvas.toDataURL('image/jpeg', 0.7);
    document.body.removeChild(host);
  }
  document.body.removeChild(wrap);
  if (!texts.length) {
    texts.push(htmlToPlain(html));
  }
  return { texts, dataUrls };
}

async function ingestDocx(
  file: File,
  onProgress?: (msg: string) => void
): Promise<IngestedDoc> {
  onProgress?.('Reading Word document...');
  const mammoth = await import('mammoth/mammoth.browser.js');
  const buf = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  const { texts, dataUrls } = await renderHtmlPages(result.value, onProgress);
  return {
    fileName: file.name,
    numPages: texts.length,
    pageTexts: texts,
    pageDataUrls: dataUrls,
    kind: 'docx',
  };
}

async function ingestText(file: File): Promise<IngestedDoc> {
  const text = await file.text();
  // Split long text into ~page-sized chunks for the locator.
  const chunks: string[] = [];
  const parts = text.split(/\n{2,}/);
  let buf = '';
  for (const p of parts) {
    if ((buf + '\n\n' + p).length > 3500 && buf) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  if (!chunks.length) chunks.push(text || '');
  return {
    fileName: file.name,
    numPages: chunks.length,
    pageTexts: chunks,
    kind: 'text',
  };
}

export async function ingestFile(
  file: File,
  onProgress?: (msg: string) => void
): Promise<IngestedDoc> {
  const kind = detectKind(file);
  if (kind === 'pdf') return ingestPdf(file, onProgress);
  if (kind === 'image') return ingestImage(file);
  if (kind === 'docx') {
    if (extOf(file.name) === '.doc') {
      throw new Error(
        'Legacy .doc is not supported. Save as .docx, PDF, or an image and retry.'
      );
    }
    return ingestDocx(file, onProgress);
  }
  return ingestText(file);
}

export async function ingestFiles(
  files: File[],
  onProgress?: (msg: string) => void
): Promise<IngestedDoc> {
  if (!files.length) throw new Error('No files');
  if (files.length === 1) return ingestFile(files[0], onProgress);
  // Multiple images → multi-page image doc
  if (files.every((f) => detectKind(f) === 'image')) {
    onProgress?.(`Loading ${files.length} images...`);
    return ingestImages(files);
  }
  throw new Error('Multi-file upload is only supported for images. Upload one PDF/DOCX/text file, or several page images.');
}

export const ACCEPT_ATTR =
  '.pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.txt,.md,.csv,.html,.htm,application/pdf,image/*,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*';
