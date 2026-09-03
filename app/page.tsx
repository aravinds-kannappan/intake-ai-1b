'use client';

import { useCallback, useRef, useState } from 'react';
import { locateSoA, textLooksScanned } from '@/lib/locator';
import { parseExtraction } from '@/lib/extraction';
import { chunkPages, mergeExtractions } from '@/lib/merge';
import { trimCandidatePages } from '@/lib/pages';
import {
  ACCEPT_ATTR,
  ingestFiles,
  type IngestedDoc,
} from '@/lib/ingest';
import type { PageSignal, SoACandidate, SoAExtraction } from '@/lib/soa-types';
import SoATable from '@/components/SoATable';

type Phase = 'idle' | 'parsing' | 'located' | 'extracting' | 'done';

const SAMPLES = ['protocol1', 'protocol5', 'protocol9', 'protocol12', 'protocol15'];

export default function Home() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<IngestedDoc | null>(null);
  const [signals, setSignals] = useState<PageSignal[]>([]);
  const [candidates, setCandidates] = useState<SoACandidate[]>([]);
  const [manualRange, setManualRange] = useState('');
  const [showSignals, setShowSignals] = useState(false);
  const [progress, setProgress] = useState('');
  const [extraction, setExtraction] = useState<SoAExtraction | null>(null);
  const [extractedPages, setExtractedPages] = useState<number[]>([]);
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [showSource, setShowSource] = useState(false);
  const [sampleName, setSampleName] = useState('');
  const [useQuality, setUseQuality] = useState(false);
  const [scannedHint, setScannedHint] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPhase('idle');
    setError(null);
    setParsed(null);
    setSignals([]);
    setCandidates([]);
    setExtraction(null);
    setExtractedPages([]);
    setPageImages({});
    setProgress('');
    setSampleName('');
    setScannedHint(false);
  };

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    reset();
    setPhase('parsing');
    setProgress('Reading document...');
    try {
      const doc = await ingestFiles(list, setProgress);
      const { pageSignals, candidates: cands } = locateSoA(doc.pageTexts);
      const scanned =
        doc.kind === 'image' ||
        (doc.kind === 'pdf' && textLooksScanned(doc.pageTexts));
      setParsed(doc);
      setSignals(pageSignals);
      setCandidates(cands);
      setScannedHint(scanned);
      if (doc.pageDataUrls) setPageImages(doc.pageDataUrls);
      setPhase('located');
      setProgress('');
    } catch (e) {
      setError(`Failed to read file: ${e instanceof Error ? e.message : String(e)}`);
      setPhase('idle');
    }
  }, []);

  const renderPages = useCallback(
    async (pages: number[], quality: number, maxDim: number) => {
      if (!parsed) return [] as { page: number; dataUrl: string }[];
      if (parsed.pageDataUrls) {
        return pages
          .filter((p) => parsed.pageDataUrls![p])
          .map((p) => ({ page: p, dataUrl: parsed.pageDataUrls![p] }));
      }
      const doc = parsed.pdfDoc as {
        getPage: (n: number) => Promise<{
          getViewport: (o: { scale: number }) => { width: number; height: number };
          render: (o: unknown) => { promise: Promise<void> };
        }>;
      };
      if (!doc) return [];
      const out: { page: number; dataUrl: string }[] = [];
      for (const p of pages) {
        setProgress(`Rendering page ${p}...`);
        const page = await doc.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = maxDim / Math.max(vp1.width, vp1.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
        out.push({ page: p, dataUrl: canvas.toDataURL('image/jpeg', quality) });
      }
      return out;
    },
    [parsed]
  );

  const extract = useCallback(
    async (pagesIn: number[]) => {
      if (!parsed) return;
      setError(null);
      setExtraction(null);
      setPhase('extracting');
      try {
        const pages = trimCandidatePages(pagesIn, signals);
        // Smaller images = fewer input tokens and faster upload.
        let rendered = await renderPages(pages, 0.55, 1000);
        if (!rendered.length && parsed.kind === 'text') {
          // Text-only extraction: no images.
          rendered = pages.map((p) => ({ page: p, dataUrl: '' }));
        }
        const total = rendered.reduce((a, r) => a + r.dataUrl.length, 0);
        if (total > 3_800_000) rendered = await renderPages(pages, 0.45, 900);

        const imgs: Record<number, string> = { ...(parsed.pageDataUrls || {}) };
        rendered.forEach((r) => {
          if (r.dataUrl) imgs[r.page] = r.dataUrl;
        });
        setPageImages(imgs);
        setExtractedPages(pages);

        const payloadPages = pages.map((p) => {
          const r = rendered.find((x) => x.page === p);
          const dataUrl = r?.dataUrl || imgs[p] || '';
          return {
            page: p,
            imageBase64: dataUrl.includes(',') ? dataUrl.split(',')[1] : undefined,
            mediaType: dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg',
            text: parsed.pageTexts[p - 1] || undefined,
          };
        });

        // 1 page per call → max parallelism; wall time ≈ slowest page.
        const chunks = chunkPages(payloadPages, 1);
        const model = useQuality ? 'claude-sonnet-5' : 'claude-haiku-4-5';
        setProgress(
          `Fast extract: ${chunks.length} page${chunks.length === 1 ? '' : 's'} in parallel (${model})...`
        );

        const parts = await Promise.all(
          chunks.map(async (chunk, i) => {
            const res = await fetch('/api/extract', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                pages: chunk,
                quality: useQuality,
                model,
                chunkSize: 1,
              }),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => null);
              throw new Error(j?.error || `Server error ${res.status} on chunk ${i + 1}`);
            }
            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let raw = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              raw += decoder.decode(value, { stream: true });
              const statuses: string[] = [];
              const statusRe = /\[\[STATUS: ([^\]]+)\]\]/g;
              let statusMatch: RegExpExecArray | null;
              while ((statusMatch = statusRe.exec(raw))) {
                statuses.push(statusMatch[1]);
              }
              if (statuses.length) {
                setProgress(`Page chunk ${i + 1}/${chunks.length}: ${statuses[statuses.length - 1]}`);
              }
            }
            const errMatch = raw.match(/\[\[ERROR: ([\s\S]*?)\]\]\s*$/);
            if (errMatch) throw new Error(errMatch[1]);
            return parseExtraction(raw);
          })
        );

        const parsedOut = mergeExtractions(parts);
        parsedOut.sourceFile = parsed.fileName;
        parsedOut.extractedAt = new Date().toISOString();
        parsedOut.model = model;
        setExtraction(parsedOut);
        setPhase('done');
        setProgress('');
      } catch (e) {
        setError(`Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
        setPhase('located');
        setProgress('');
      }
    },
    [parsed, renderPages, useQuality, signals]
  );

  const extractManual = () => {
    const m = manualRange.match(/^\s*(\d+)\s*[-–]\s*(\d+)\s*$/);
    if (!m || !parsed) {
      setError('Enter a page range like 51-54');
      return;
    }
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a < 1 || b > parsed.numPages || a > b || b - a + 1 > 24) {
      setError(`Range must be within 1-${parsed.numPages} and at most 24 pages`);
      return;
    }
    const pages = [];
    for (let p = a; p <= b; p++) pages.push(p);
    extract(pages);
  };

  const extractTopCandidates = () => {
    if (!candidates.length) return;
    extract(candidates[0].pages);
  };

  const visionLocate = async () => {
    if (!parsed) return;
    setError(null);
    setPhase('extracting');
    try {
      const all = Array.from({ length: parsed.numPages }, (_, i) => i + 1);
      const interesting = signals
        .filter((s) => s.score > 0 || s.signals.some((x) => x.includes('no text')))
        .map((s) => s.page);
      const stride = parsed.numPages > 40 ? 3 : 1;
      const sampled = new Set<number>([
        ...interesting,
        ...all.filter((p) => p % stride === 1 || p === parsed.numPages),
      ]);
      const pages = Array.from(sampled).sort((a, b) => a - b).slice(0, 60);
      setProgress(`Vision-locating over ${pages.length} page thumbnails...`);
      const thumbs = await renderPages(pages, 0.4, 800);
      if (!thumbs.length) {
        throw new Error('No page images available for vision locate (text-only file). Use a manual range or upload a PDF/image.');
      }
      const batches = chunkPages(thumbs, 16);
      const found = new Set<number>();
      for (let i = 0; i < batches.length; i++) {
        setProgress(`Vision locate batch ${i + 1}/${batches.length}...`);
        const res = await fetch('/api/locate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pages: batches[i].map((r) => ({
              page: r.page,
              imageBase64: r.dataUrl.split(',')[1],
              mediaType: 'image/jpeg',
            })),
          }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || `Vision locate failed (${res.status})`);
        for (const p of j.pages || []) found.add(p);
      }
      if (!found.size) {
        setError('Vision locator did not find an SoA. Enter a manual page range.');
        setPhase('located');
        setProgress('');
        return;
      }
      const foundPages = Array.from(found).sort((a, b) => a - b);
      setCandidates((prev) => [
        {
          id: 'cand-vision',
          pages: foundPages,
          score: 99,
          titleGuess: `Vision locate: pages ${foundPages[0]}-${foundPages[foundPages.length - 1]}`,
          signals: ['vision locator'],
        },
        ...prev.filter((c) => c.id !== 'cand-vision'),
      ]);
      setPhase('located');
      setProgress('');
    } catch (e) {
      setError(`Vision locate failed: ${e instanceof Error ? e.message : String(e)}`);
      setPhase('located');
      setProgress('');
    }
  };

  const loadSample = async (name: string) => {
    reset();
    setSampleName(name);
    try {
      const res = await fetch(`/outputs/${name}.json`);
      if (!res.ok) throw new Error(`sample not found (${res.status})`);
      const j = (await res.json()) as SoAExtraction;
      setExtraction(j);
      setPhase('done');
    } catch (e) {
      setError(`Could not load sample: ${e instanceof Error ? e.message : String(e)}`);
      setPhase('idle');
    }
  };

  const downloadJson = () => {
    if (!extraction) return;
    const blob = new Blob([JSON.stringify(extraction, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(extraction.sourceFile || sampleName || 'soa').replace(/\.[^.]+$/i, '')}-soa.json`;
    a.click();
  };

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">SoA Extractor</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Upload any clinical trial protocol (PDF, Word, images, or text). A
          locator finds the Schedule of Activities under whatever name the
          sponsor used; Claude extracts a faithful structured grid in parallel
          one-page chunks.
        </p>
      </header>

      <section className="mb-6 flex flex-wrap items-center gap-4">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileRef.current?.click()}
          className="flex h-24 flex-1 min-w-[280px] cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-white px-4 text-center text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600"
        >
          {parsed
            ? `${parsed.fileName} · ${parsed.numPages} page${parsed.numPages === 1 ? '' : 's'} · ${parsed.kind}`
            : 'Drop PDF / DOCX / images / text here, or click to choose'}
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_ATTR}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) handleFiles(e.target.files);
            }}
          />
        </div>
        <div className="text-sm text-slate-500">
          <div className="mb-1 font-medium text-slate-600">
            Or view a pre-computed output:
          </div>
          <div className="flex flex-wrap gap-2">
            {SAMPLES.map((s) => (
              <button
                key={s}
                onClick={() => loadSample(s)}
                className={`rounded border px-2 py-1 text-xs ${
                  sampleName === s
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-slate-300 bg-white hover:bg-slate-50'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </section>

      {(phase === 'parsing' || phase === 'extracting') && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          {progress || 'Working...'}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {parsed && (phase === 'located' || phase === 'extracting' || phase === 'done') && (
        <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">
              Locator: {candidates.length} candidate SoA region
              {candidates.length === 1 ? '' : 's'} found
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={useQuality}
                  onChange={(e) => setUseQuality(e.target.checked)}
                />
                Higher quality (Sonnet — slower)
              </label>
              <button
                onClick={() => setShowSignals((v) => !v)}
                className="text-xs text-blue-600 hover:underline"
              >
                {showSignals ? 'hide' : 'show'} per-page scores
              </button>
            </div>
          </div>
          {scannedHint && (
            <p className="mb-2 text-sm text-amber-800">
              Little or no text layer. Use vision locate or a manual page range.
            </p>
          )}
          {candidates.length === 0 && (
            <p className="text-sm text-slate-600">
              No automatic SoA hit. Try vision locate or force a page range.
            </p>
          )}
          <div className="mb-3 flex flex-wrap gap-2">
            {candidates.length > 0 && (
              <button
                onClick={extractTopCandidates}
                disabled={phase === 'extracting'}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Extract best region
              </button>
            )}
            <button
              onClick={visionLocate}
              disabled={phase === 'extracting' || parsed.kind === 'text'}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50"
            >
              Vision locate
            </button>
          </div>
          <ul className="space-y-2">
            {candidates.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2"
              >
                <div className="text-sm">
                  <span className="font-medium text-slate-800">
                    Pages {c.pages[0]}
                    {c.pages.length > 1 ? `-${c.pages[c.pages.length - 1]}` : ''}
                  </span>{' '}
                  <span className="text-slate-500">score {c.score}</span>
                  <div className="text-xs text-slate-500">{c.titleGuess}</div>
                </div>
                <button
                  onClick={() => extract(c.pages)}
                  disabled={phase === 'extracting'}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Extract these pages
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-slate-600">Manual override, page range:</span>
            <input
              value={manualRange}
              onChange={(e) => setManualRange(e.target.value)}
              placeholder="e.g. 51-54"
              className="w-24 rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <button
              onClick={extractManual}
              disabled={phase === 'extracting'}
              className="rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
            >
              Extract range
            </button>
          </div>
          {showSignals && (
            <div className="mt-3 max-h-64 overflow-y-auto rounded border border-slate-100 bg-slate-50 p-2 text-xs">
              {signals
                .filter((s) => s.score > 0)
                .map((s) => (
                  <div key={s.page} className="flex gap-2 py-0.5">
                    <span className="w-16 shrink-0 font-mono text-slate-500">
                      p.{s.page}
                    </span>
                    <span className="w-10 shrink-0 font-mono font-semibold text-slate-700">
                      {s.score}
                    </span>
                    <span className="text-slate-600">{s.signals.join(' · ')}</span>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      {extraction && (
        <section className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">
              Extracted {extraction.tables.length} table
              {extraction.tables.length === 1 ? '' : 's'}
              {extraction.sourceFile ? ` from ${extraction.sourceFile}` : ''}
              {extraction.model ? ` · ${extraction.model}` : ''}
            </h2>
            <div className="flex gap-2">
              {Object.keys(pageImages).length > 0 && (
                <button
                  onClick={() => setShowSource((v) => !v)}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
                >
                  {showSource ? 'Hide' : 'Show'} source pages
                </button>
              )}
              <button
                onClick={downloadJson}
                className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                Download JSON
              </button>
            </div>
          </div>

          {showSource && (
            <div className="flex gap-3 overflow-x-auto rounded-lg border border-slate-200 bg-slate-100 p-3">
              {extractedPages.map((p) =>
                pageImages[p] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={p}
                    src={pageImages[p]}
                    alt={`page ${p}`}
                    className="max-h-[500px] rounded border border-slate-300 bg-white"
                  />
                ) : null
              )}
            </div>
          )}

          {extraction.tables.map((t) => (
            <SoATable key={t.id} table={t} />
          ))}
        </section>
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
        Accepts PDF, DOCX, images, and text. Default extractor is Haiku on
        parallel 1-page chunks with a compact JSON wire format. Toggle Sonnet
        for harder layouts.
      </footer>
    </main>
  );
}
