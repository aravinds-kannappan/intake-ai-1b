# SoA Extractor (Take-Home 1b, Intake AI)

A tool that takes a clinical trial protocol (PDF, Word, images, or text), finds the Schedule of Activities (whatever the sponsor decided to call it), and produces a faithful, structured, machine-readable representation of it: every row, every column, verbatim cell values, hierarchical headers on both axes, and footnotes linked to the cells they modify. A web UI lets you drop in any protocol and inspect the result against the source pages.

Deployment: Vercel, auto-deploying from `main` (import this repo in Vercel and set `ANTHROPIC_API_KEY` in the project's environment variables; no other configuration is needed). Live: https://intake-ai-1b.vercel.app

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000. The one prerequisite: the extraction API calls Claude, so put a key in `.env.local` before `npm run dev`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Without the key the app still runs: upload, locator, and the pre-computed outputs all work; only extraction and vision-locate will return a clear error telling you the key is missing.

This is not a gallery of the five assignment PDFs. Drop in any protocol. The locator has no hardcoded page numbers; if the text layer is empty or the title is one it has never seen, use **Vision locate** or a manual page range.

The committed outputs in `outputs/` were produced by `npm run extract -- path/to/protocol.pdf`, which runs the same locator and same extraction prompt as the web app. That batch script (and only that script) additionally needs poppler (`brew install poppler`) for page rasterization, because Node has no canvas; the web app rasterizes with pdf.js in the browser and needs nothing extra. Optional: `SOA_QUALITY=1` uses Sonnet 5 instead of the default Haiku 4.5.

## Architecture

The pipeline has three stages, split deliberately between deterministic code and a model:

```
Document upload (browser): PDF / DOCX / images / text
  └─ lib/ingest.ts → page texts (+ page images when available)
       └─ Locator (lib/locator.ts): deterministic scoring over page text
            └─ optional vision locate (/api/locate, Haiku) when text is missing
               or the title is one the keyword list has never seen
            └─ candidate page ranges, shown to the user with per-page score evidence
                 └─ Extractor: 1-page chunks in parallel (/api/extract)
                    Claude Haiku 4.5 (default, fast) or Sonnet 5 (quality toggle),
                    ultra-compact JSON, then a deterministic merge across chunks
                      └─ JSON (lib/soa-types.ts schema) rendered as an interactive table
```

Supports **PDF, DOCX, images (png/jpg/webp/gif), and text/HTML/CSV**. Non-PDF files are ingested in the browser into the same page-text + optional page-image representation the locator/extractor already use.

### The locator

`lib/locator.ts` is pure deterministic TypeScript, no model calls. It scores every page on:

- SoA-style titles on heading-like lines, covering the usual sponsor aliases (Schedule of Events/Activities/Assessments/Measures/Evaluations, Time and Events, Study Flow Chart, Table of Events, Visit Schedule, ICH-style wording). Table-of-contents pages (dotted leaders) and narrative cross references ("see Schedule of Events, Attachment...") are ignored
- header-row signals: "Study Day" / "Study Week" / "Visit" / "Cycle" followed by runs of numbers, and clusters of period keywords (Screening, Baseline, Treatment, Follow-up, Discharge, Washout, Enrollment...)
- grid signals: lines dense in cell-like tokens (X, (X), 3X, Y/N, Q2W, BID, checkmarks), a line-agnostic page-wide token count (rotated landscape pages scramble line structure but the marks survive), and dense short-token tabular lines for schedules that do not use X marks at all
- footnote signals: blocks of "a - ...", "* ...", "Xa = ..." lines and explicit headings like "Footnotes to Flow Chart" or "Notes on the Schedule"
- a vision fallback (Haiku on page thumbnails) when the PDF is scanned or the title is one the keyword list has never seen. Nothing about page numbers is hardcoded.

Pages above a seed threshold start a candidate; the candidate then grows forward and backward through lower-scoring pages that look like continuations (more grid, "continued"/"concluded", footnote blocks). Backward growth is what saves rotated multi-page tables whose early pages score below the seed threshold. Footnote-block growth is what pulls in footnote text that spilled past a page break with no header (protocol9 does exactly this).

The locator's evidence is shown in the UI (per-page scores and the reasons). The user can extract the best region in one click, run vision locate, or override with a manual page range (the API splits it into **1-page** parallel chunks). A candidate is capped at 12 pages so a keyword-heavy protocol does not swallow half the document; longer schedules come back as adjacent candidates that merge on extract if they are clearly the same table.

### The extractor

Candidate ranges are trimmed of low-score narrative pages, then split into **1-page chunks extracted in parallel**, then stitched by `lib/merge.ts`. Default model is **Claude Haiku 4.5** (much faster decode than Sonnet). Unusual layouts can use Sonnet 5 from the UI toggle (`SOA_QUALITY=1` in the batch script). The prompt asks for an ultra-compact wire format (column tuples + sparse cell maps) which `lib/compact.ts` expands to the public schema. Footnote `appliesTo` is rebuilt from markers when omitted.

- verbatim cell values, never normalized to booleans
- recall over precision, with an explicit instruction to re-scan for missed rows/columns
- merge continuation pages instead of duplicating them
- extract footnote text in full, including cross-page continuations, and record marker-to-cell/row/column linkage
- category rows are structure, not assessments
- vertical divider text (RANDOMIZATION printed letter by letter) is a divider, not a data column
- when something cannot be represented faithfully, say so in an `ambiguities` array instead of guessing

Why images and not the text layer? See "Tools evaluated" below; the short version is that every text-based extractor I benchmarked silently destroys exactly the information this assignment cares about.

The response streams back to the browser (and the batch script) so long extractions show progress and don't sit behind a buffered connection.

### The UI

`app/page.tsx` (Next.js 14, App Router, Tailwind). Upload or drag a protocol file (PDF / DOCX / images / text), watch the locator's candidates appear with their evidence, extract any candidate (or a manual range), and get:

- the table rendered with its full header hierarchy (period row, visit labels, visit number / study day / study week / window rows), category rows, and colspans
- every footnote marker as a clickable superscript; clicking a marker or a footnote highlights every cell, row, and column header that carries it
- a "Show source pages" toggle with the exact page images that were sent to the model, for cell-by-cell checking against the source
- the raw JSON, downloadable
- the model's own `ambiguities` and `notes`, displayed prominently rather than hidden
- a **Higher quality (Sonnet)** checkbox for unusual layouts (slower; default is Haiku 4.5)
- **Vision locate** when the text locator found nothing (scans, odd titles)

The five assignment outputs are loadable from the home page so the renderer can be inspected without an API key. Extra committed JSON under `outputs/` (CTN / NEAT protocols) is generalization evidence, not the graded five.

## Output schema and why

Defined in `lib/soa-types.ts`. One extraction is `{ tables: SoATable[] }`; a protocol can and does contain more than one schedule (protocol5 has a Time and Events Schedule plus a blood-collections sub-schedule; both are captured as separate tables from one pass).

Per table:

- `columns`: ordered leaf visit columns. Hierarchy is kept per column (`path` for the period grouping, plus `visitNumber` / `studyDay` / `studyWeek` / `window` as printed). I chose per-column denormalized hierarchy over a nested header tree because it keeps every consumer simple (rendering, diffing, EDC mapping) while preserving all grouping information; the renderer reconstructs merged header rows from it losslessly.
- `rows`: ordered rows with `kind: "category" | "assessment"`, so category header rows are preserved as structure and each assessment records its governing `category`.
- `cells`: sparse, verbatim `value`, `markers`, optional `colspan` for values that visibly span columns ("Prior to Day 4" across days 1-3). Sparse because an empty cell is meaningful only by absence; inventing empty cells invites inventing content.
- `footnotes`: verbatim `marker` and full `text`, `continuedAcrossPages`, and `appliesTo` targets (cell / row / column / table). Linkage is stored explicitly AND recoverable from the marker fields on cells/rows/columns; the UI uses both.
- `notes`: table-level notes and abbreviation lines that carry no marker.
- `ambiguities`: free-text descriptions of anything the model could not represent faithfully. This field is the "be faithful, not clever" rule made concrete, and it earned its place in testing (see verification notes below).
- `pages`: 1-based physical source pages, for provenance.

## Tools, APIs, models evaluated

I benchmarked the text-extraction candidates on these actual protocols before writing the extractor. Results:

**pdfplumber (Python, layout-based tables).** On protocol1 page 54 it detects the table lattice and then returns empty strings for essentially every X cell: 30 rows of structure with the marks silently gone. That is the worst possible failure mode for this assignment (looks like a table, drops the content). On protocol12 it produces 28 columns for a 9-column table and merges the vertical RANDOMIZATION divider into "R/A/N/D/O/M/I/Z/A/"; on protocol9 (rotated) it produces 34 phantom columns with spanning cells shredded. Rejected for cell extraction.

**pdftotext -layout (poppler).** Fine for reading order on portrait prose. On the SoA pages it detaches superscript footnote markers onto their own lines (protocol12/15 render as rows of floating "b b b c"), transposes rotated pages, and gives no reliable column geometry. Rejected for extraction; conceptually it is what I use (via pdf.js) for locating.

**pdf.js text layer.** Used for the locator and as the extractor's wording backup. Same class of geometric problems as pdftotext for cells. One real pitfall found during development: v4 and v6 order rotated-page text differently, which changed locator scores; the locator now has a line-structure-agnostic grid signal so it survives both.

**Camelot / Tabula (lattice and stream table extractors).** Not benchmarked. Both depend on ruled-line detection or whitespace heuristics of the same family that pdfplumber uses, plus heavier system deps (Ghostscript/Java). Given that the failure above is representational (superscripts, rotated text, spanning cells), not a tuning issue, I did not expect a different outcome and spent the time on verification instead. This is a judgment call, not a measurement.

**OCR/layout services (AWS Textract, Azure Document Intelligence).** Not evaluated: paid accounts I did not want to create for this, and their table models also flatten multi-row grouped headers, which is a graded requirement here.

**Claude Haiku 4.5 (`claude-haiku-4-5`), vision, ultra-compact JSON. Chosen as the default.** Extraction is mostly transcription; Haiku is several times faster per output token than Sonnet and is good enough for X-mark grids. Page images are sent at ~1000 px JPEG. The text layer is a short backup for exact wording.

**Claude Sonnet 5. Optional quality path** (UI toggle / `SOA_QUALITY=1`). Use when Haiku drops a subtle superscript or an unusual layout. Not the default because it is why large SoAs previously took minutes.

**Claude Opus 5.** Available via `SOA_MODEL=claude-opus-5` if needed; not exposed in the default UI anymore (Sonnet is the quality tier).

The trade-offs: Haiku can miss tiny superscripts more often than Sonnet; the source-page toggle and Sonnet toggle exist for that. Cost per run is much lower.

## Manual verification, per protocol

Method: rendered every source page, put it next to the extracted grid (`npx tsx scripts/dump.ts outputs/protocolN.json` prints the grid compactly), and compared row by row, with full cell-by-cell passes on the pages called out below.

**protocol1 (Lilly LZZT, Schedule of Events, pages 52-54).** Locator: correct (52 is a title-only cover page, harmless). Full cell-by-cell check of both table pages: all 14 visit columns, all 28 rows, all cells correct, including the Xb footnote linkage appearing on visits 8 through 11 across the page break (I initially suspected this was a model error; the source shows the model was right). Three honest wrinkles, all surfaced by the tool itself in `ambiguities`: (1) the table title and VISIT/WEEK header labels are corrupted glyphs in the rendered PDF (broken font embedding); wording was recovered from the text layer; (2) the printed grid contains a genuinely blank spacer column between visits 5 and 7, represented as an ambiguity note rather than a fabricated "visit 6"; (3) "Study drug record / Medications dispensed / Medications returned" is printed as one bordered row with a three-line label and is extracted as one row, flagged.

**protocol5 (atomoxetine, Appendix I Time and Events Schedule + Appendix II Schedule of Blood Collections, rotated landscape, pages 50-51).** Locator: correct, one candidate covering both. Both tables extracted separately, which is the multi-SoA requirement working. Row-by-row check against the text dump: correct, including the "Cocaine Infusion Session #" row with numeric cells (1&2, 3...8), the starred footnotes and the Xa-Xf footnotes. A useful internal check passes: in Appendix II, every row's extracted per-day sample counts times its per-sample volume equals its extracted Total Volume (e.g. 45 PK samples x 5 mL = 225 mL), across all rows and the 390 mL grand total.

**protocol9 (lofexidine, Table 4 Schedule of Measures, 4 rotated pages 26-29, footnote page with no table on it).** Locator: correct after a fix this protocol forced (backward growth through below-threshold rotated pages). Full cell-by-cell check of page 27: exact, including VAS-E's irregular 1X pattern on days 1,3,4,6,8,10 and MCGI starting at day 4. The footnotes-only page 29 was correctly pulled in and its definitions linked. Two honest warts, both self-reported in `ambiguities`: the document superscripts CRF form numbers (01)-(33) on row labels, which the tool records as markers that resolve to no footnote text (correct: the definitions are not on these pages); and several rows (Morphine, Lofexidine dosing, Drop Out Day) mark occurrence with grey cell shading and no printed character, which the tool refuses to turn into invented "X"s and instead describes. If shaded-equals-scheduled is the intended reading, a human must confirm it; that is a question for a clinical SME, written down rather than guessed.

**protocol12 (modafinil, Table 3 Overview of Study Assessments, page 48, with its footnote block on page 49 under the heading "Notes on the Schedule of Assessments").** Locator: correct (includes page 50, which is narrative; the extractor correctly took nothing from it). Spot checks exact: the Pregnancy test row's five distinct markers across columns (Xg at weeks 1-3, Xb at 4 and 8, Xc at 12, plain X at follow-up), 3X/week values, "X wk 6" cells verbatim, the vertical RANDOMIZATION divider represented as a divider column, and all 14 footnote definitions captured from the following page and linked. One judgment call flagged by the tool: "Xc Xe" printed side by side in one cell is one cell value with two markers.

**protocol15 (cabergoline, Table 1, single dense page 25).** Locator: correct (over-includes the neighboring narrative pages; harmless). Full check of the trickiest rows against the page image: exact, including Serum prolactin (Xa, Xa, Xa, Xc in the correct four columns), CCQ-NOW's week-12 Xb (where every neighboring row uses Xc; the document's own inconsistency, preserved), "Weekly x 2 weeks" and "3 X/week for 2 weeks" verbatim including the document's own spacing ("3 X"), and all five footnote definitions.

Overall: across the five protocols I found no dropped assessment rows and no dropped visit columns in the committed outputs. The errors that remain are representational judgment calls, and in every case I checked, the tool had already flagged the situation in `ambiguities` rather than silently picking.

Extra protocols (CTN0001, CTN0002, CTN0029, CTN0048, CTN0052, NCT03061474 / NEAT) were run through the same pipeline as a check that the locator is not wired to the assignment filenames. Their JSON is committed; I did not repeat the full cell-by-cell audit I did on the five.

## Where it breaks, and what it does when it breaks

These are limits I actually hit or designed around, not a wish list.

- **Scanned protocols (no text layer).** The deterministic locator sees empty pages and finds nothing. The UI says so. **Vision locate** then sends page thumbnails to Haiku and proposes a page range; extraction still runs on the full page images. If the SoA sits on a page the thumbnail sampler skipped (very long scans), vision locate can miss it — then the manual range is the escape hatch. It does not silently invent a table.
- **SoAs with no X/Y/Q2W-style marks and no recognizable title.** The text locator seeds on title or grid tokens. A shaded-only grid in another language will not seed. Vision locate / manual range still work; the score panel shows what the heuristic saw.
- **SoAs longer than 12 pages.** A single locator candidate stops at 12 pages so a "Visit / Treatment" prose chapter cannot swallow the file. Adjacent candidates can be extracted and merged when titles match or row-label overlap is high (≥45%). If two *different* tables reuse generic row names ("Vital signs", "ECG"), merge can over-combine — inspect table titles; it is visible, not silent.
- **Chunk merge mismatches.** Parallel 1-page calls can name the same visit `Visit 3` on one page and `V3` on the next. Merge keys on path + label + day/week, so those become two columns instead of one. Duplicate-looking columns in the UI are that failure. Re-extracting with the Sonnet quality toggle is the workaround today.
- **Very wide single pages.** A single-page chunk can still hit `max_tokens`. The API returns an explicit error rather than a truncated JSON blob.
- **Grey cells with no printed character (protocol9).** The tool will not turn shading into an invented "X". It records an ambiguity. That is intentional ("be faithful, not clever") and will look like a miss if a data manager's convention is shaded-equals-done.
- **Nondeterminism.** Two runs on the same pages produce the same grid but can differ in marker spelling ("Xa" vs "a") and in ambiguity phrasing. Within any single output the linkage is self-consistent.
- **Small-superscript misreads remain possible.** Vision at ~1000 px / Haiku is the sharpest edge. Flip Sonnet quality if a superscript looks wrong; the source-page toggle exists to make checking cheap.
- **Vercel.** Each extract request is capped at 300 s and ~4.5 MB. Chunking keeps most payloads under the body limit; quality is auto-downscaled if not. A pathological chunk can still time out, and the client surfaces it.
- **Latency.** A 1-page Haiku chunk is typically tens of seconds. Wall time for a multi-page SoA tracks the slowest page, not the sum. A dense 80-column page still takes longer because tokens decode one at a time. See the next section.
- **The committed sample buttons are not the product.** They only prove the renderer. The product is upload → locate → extract on a document the tool has not seen.

## Why extractions used to take 1–3 minutes (and what changed)

The old path used Sonnet at default high effort on multi-page blobs. This repo now:

1. **Defaults to Haiku 4.5** — faster decode, good enough for most SoAs.
2. **1-page parallel chunks** — wall time ≈ slowest page, not the sum.
3. **Ultra-compact JSON** — column tuples + sparse cell maps; footnote linkage rebuilt client-side.
4. **Trim low-score pages** before calling the model.
5. **Smaller page images** (~1000 px) to cut vision tokens.
6. **Sonnet only when you ask** (quality toggle).

A typical 3-page SoA should land well under a minute on Haiku; dense wide tables still take longer because tokens decode one at a time.

## What I would build next with two more weeks

1. **A second-pass verifier**: re-send the extracted JSON with the page images and ask the model to diff against the pixels, specifically hunting dropped rows/columns and marker misreads; surface the diff in the UI. Recall is the graded failure, and self-checking is the cheapest recall insurance.
2. **Column-identity normalization in merge** so `Visit 3` / `V3` / `Day 15` on continuation pages collapse instead of duplicating. That is the real remaining multi-page bug class.
3. **Deterministic post-validation**: schema-level lints (duplicate row labels across a page seam, markers with no footnote, footnotes with no marker, colspan overlaps, `v[]` length ≠ column count) rendered as warnings next to ambiguities.
4. **A golden-set regression harness**: the five verified outputs become fixtures; any prompt or model change re-runs the batch and diffs cell-by-cell. More ClinicalTrials.gov protocols in that harness, not just as extra JSON dumps.
5. **Editable output**: let a human correct a cell in the UI and export the corrected JSON, turning verification effort into eval data.
6. **True OCR in the locator** (Tesseract WASM) so vision locate is not required on scans. Thumbnails plus Haiku is good enough to start; it still costs an API round-trip and can skip pages on long files.

## AI tools used

The assignment permits coding assistants and asks that they be named.

- **Cursor** (Composer) is what I used to iterate on this repo after the first working pipeline existed: the Haiku default / 1-page parallel chunks / ultra-compact JSON speed path, multi-format ingest (DOCX/images/text), the vision locator, merge of continuation chunks, broadening the text locator without letting it eat 24-page chapters, and this README. Where it helped: keeping the public schema stable while the wire format changed, and forcing the locator to be tested on all five PDFs after a too-greedy scoring change. Where it got in the way: an early locator change treated every dense table as an SoA and returned page ranges like 7–30; that only showed up because we re-ran `scripts/locate-only.ts` on the real files. It also appends a `Co-authored-by: Cursor` git trailer unless the commit is rewritten, which I stripped from `main` so the history is mine.
- **Claude Code** wrote the first version of the pipeline (deterministic locator, vision extractor, verification UI), benchmarked pdfplumber / pdftotext / pdf.js on the actual protocols, and did the original page-image-versus-JSON verification passes. It also hit the real integration potholes: pdfjs v6 being unparseable by Next 14's webpack (pinned v4, worker served from `public/`), rotated-page text ordering changing between pdf.js versions, and the Anthropic SDK requiring streaming for long generations.
- **Claude Sonnet 5** is the optional quality engine; **Haiku 4.5** is the default extractor and the vision locator.
- Where the *extraction* model hurt: it varies surface details between runs (marker spelling), and a tidy wrong grid is easy to trust. The per-protocol verification section is the countermeasure. It did catch one thing worth chasing (the NPI-X Xb linkage on protocol1), where the model was right and my suspicion was wrong.

## Repo layout

```
app/page.tsx               UI (upload, locator panel, table renderer, source-page view)
app/api/extract/route.ts   streaming extraction endpoint (Claude)
app/api/locate/route.ts    vision locator fallback
components/SoATable.tsx    table renderer with footnote linkage
lib/locator.ts             deterministic SoA locator
lib/extraction.ts          extraction prompt, request building, JSON recovery
lib/compact.ts             compact wire format → public schema
lib/merge.ts               stitch continuation chunks into one table
lib/soa-types.ts           output schema
lib/ingest.ts              multi-format ingest (PDF / DOCX / images / text)
lib/pages.ts               candidate trim + page chunking
scripts/extract-batch.ts   batch runner that produced outputs/ (npm run extract)
scripts/self-check.ts      compact-schema + merge sanity checks
scripts/dump.ts            prints an output JSON as a compact grid (verification aid)
scripts/debug-signals.ts   prints per-page locator scores for a PDF (debugging aid)
scripts/locate-only.ts     locator only (no API spend): `npm run locate -- file.pdf`
scripts/latency-probe.ts   wall-time probe for a known page range
outputs/                   structured outputs for the five assignment protocols, plus extra CTN/NEAT runs
public/outputs/            same files, served to the UI as loadable samples
```

Note on the source PDFs: per the assignment's ground rules the protocol documents are not committed to this repository; only the structured outputs are. To reproduce, place the PDFs anywhere and run `npm run extract -- /path/to/protocolN.pdf`.

## Assumptions and open questions for a clinical SME

- In protocol9, do grey-shaded cells with no printed character mean "activity occurs on this day"? The tool preserves the ambiguity; a data manager would need to rule.
- In protocol1, is the blank column between visits 5 and 7 a formatting artifact or a removed Visit 6? The output records it as an ambiguity rather than inventing a column.
- When a footnote's text contradicts the grid (protocol5's `**` note says chemistries happen "on days 6 and 13" while the grid marks day 13 but not day 6), both are preserved verbatim; reconciliation is a human call.
- If a continuation page repeats headers in abbreviated form (`V3` vs `Visit 3`), should those be the same EDC visit? The merger currently treats them as distinct unless the printed strings match; I would rather ask than silently collapse them.
