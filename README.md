# SoA Extractor (Take-Home 1b, Intake AI)

A tool that takes a clinical trial protocol PDF, finds the Schedule of Activities (whatever the sponsor decided to call it), and produces a faithful, structured, machine-readable representation of it: every row, every column, verbatim cell values, hierarchical headers on both axes, and footnotes linked to the cells they modify. A web UI lets you drop in any protocol and inspect the result against the source pages.

Deployment: Vercel, auto-deploying from `main` (import this repo in Vercel and set `ANTHROPIC_API_KEY` in the project's environment variables; no other configuration is needed).

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000. The one prerequisite: the extraction API calls Claude, so put a key in `.env.local` before `npm run dev`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Without the key the app still runs: upload, locator, and the five pre-computed outputs all work; only the "Extract" button will return a clear error telling you the key is missing.

The committed outputs in `outputs/` were produced by `npm run extract -- path/to/protocol.pdf`, which runs the same locator and same extraction prompt as the web app. That batch script (and only that script) additionally needs poppler (`brew install poppler`) for page rasterization, because Node has no canvas; the web app rasterizes with pdf.js in the browser and needs nothing extra.

## Architecture

The pipeline has three stages, split deliberately between deterministic code and a model:

```
PDF upload (browser)
  └─ pdf.js: per-page text layer + page rasterization (client side, no server deps)
       └─ Locator (lib/locator.ts): deterministic scoring over page text
            └─ optional vision locate (/api/locate, Haiku) when text is missing
               or the title is one the keyword list has never seen
            └─ candidate page ranges, shown to the user with per-page score evidence
                 └─ Extractor: 2-page chunks in parallel (/api/extract)
                    Claude Sonnet 5 (default) or Opus 5 (toggle), effort=low,
                    compact JSON, then a deterministic merge across chunks
                      └─ JSON (lib/soa-types.ts schema) rendered as an interactive table
```

### The locator

`lib/locator.ts` is pure deterministic TypeScript, no model calls. It scores every page on:

- SoA-style titles on heading-like lines, covering the usual sponsor aliases (Schedule of Events/Activities/Assessments/Measures/Evaluations, Time and Events, Study Flow Chart, Table of Events, Visit Schedule, ICH-style wording). Table-of-contents pages (dotted leaders) and narrative cross references ("see Schedule of Events, Attachment...") are ignored
- header-row signals: "Study Day" / "Study Week" / "Visit" / "Cycle" followed by runs of numbers, and clusters of period keywords (Screening, Baseline, Treatment, Follow-up, Discharge, Washout, Enrollment...)
- grid signals: lines dense in cell-like tokens (X, (X), 3X, Y/N, Q2W, BID, checkmarks), a line-agnostic page-wide token count (rotated landscape pages scramble line structure but the marks survive), and dense short-token tabular lines for schedules that do not use X marks at all
- footnote signals: blocks of "a - ...", "* ...", "Xa = ..." lines and explicit headings like "Footnotes to Flow Chart" or "Notes on the Schedule"
- a vision fallback (Haiku on page thumbnails) when the PDF is scanned or the title is one the keyword list has never seen. Nothing about page numbers is hardcoded.

Pages above a seed threshold start a candidate; the candidate then grows forward and backward through lower-scoring pages that look like continuations (more grid, "continued"/"concluded", footnote blocks). Backward growth is what saves rotated multi-page tables whose early pages score below the seed threshold. Footnote-block growth is what pulls in footnote text that spilled past a page break with no header (protocol9 does exactly this).

The locator's evidence is shown in the UI (per-page scores and the reasons). The user can extract the top candidates in one click, run vision locate, or override with a manual page range of up to 24 pages.

### The extractor

Candidate ranges are split into 2-page chunks and extracted in parallel, then stitched by `lib/merge.ts` (same table title or ≥45% row-label overlap unions columns/cells/footnotes; distinct tables stay distinct). Each chunk sends rendered page images plus the text layer to Claude. Default model is Claude Sonnet 5 at `effort=low` (this is transcription, not reasoning; Anthropic's default `high` effort was the main reason large SoAs took minutes). Unusual layouts can use Opus 5 from the UI toggle (`SOA_QUALITY=1` in the batch script). The prompt in `lib/extraction.ts` asks for a compact wire format (short keys, dense `v[]` cell arrays) which is expanded to the public schema; that cuts output tokens without changing what the UI or committed files look like. The prompt encodes the assignment's constraints directly:

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

`app/page.tsx` (Next.js 14, App Router, Tailwind). Upload or drag a PDF, watch the locator's candidates appear with their evidence, extract any candidate (or a manual range), and get:

- the table rendered with its full header hierarchy (period row, visit labels, visit number / study day / study week / window rows), category rows, and colspans
- every footnote marker as a clickable superscript; clicking a marker or a footnote highlights every cell, row, and column header that carries it
- a "Show source pages" toggle with the exact page images that were sent to the model, for cell-by-cell checking against the source
- the raw JSON, downloadable
- the model's own `ambiguities` and `notes`, displayed prominently rather than hidden

The five pre-computed outputs are loadable from the home page so the renderer can be inspected without an API key.

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

**Claude Sonnet 5 (`claude-sonnet-5`), vision, on rendered page images, `effort=low`. Chosen as the default.** The SoA is a visual artifact: borders, shading, superscripts, rotation, spanning. A vision model reads it the way the human it was written for does. Sonnet specifically: strong document vision, 64k+ output tokens, and streaming. `effort=low` is the important speed control: current Claude models default to adaptive thinking at `high` effort, which is wasted on a transcription task and was the bulk of the 1–3 minute waits. The text layer is included as backup so exact wording (≤, ā, drug names) comes from the PDF's own characters rather than pixel reading.

**Claude Opus 5 (`claude-opus-5`). Optional quality path.** Better on unusual or untitled grids. Slower and more expensive, so it is a UI toggle / `SOA_QUALITY=1`, not the default. It is not categorically more accurate on the five assignment protocols, where Sonnet already recovered every row and column I checked.

**Claude Haiku 4.5.** Used only for vision locate (page thumbnails → page numbers). Fast enough to scan a protocol when the text locator has nothing to work with.

The trade-offs accepted by choosing a model for extraction: nondeterminism across runs (observed: one run named a marker "Xa" where another said "a"; both self-consistent), per-run cost (roughly 10-40 cents per extraction at current Sonnet + low-effort pricing), and the need for the verification UI to make checking cheap.

## Manual verification, per protocol

Method: rendered every source page, put it next to the extracted grid (`npx tsx scripts/dump.ts outputs/protocolN.json` prints the grid compactly), and compared row by row, with full cell-by-cell passes on the pages called out below.

**protocol1 (Lilly LZZT, Schedule of Events, pages 52-54).** Locator: correct (52 is a title-only cover page, harmless). Full cell-by-cell check of both table pages: all 14 visit columns, all 28 rows, all cells correct, including the Xb footnote linkage appearing on visits 8 through 11 across the page break (I initially suspected this was a model error; the source shows the model was right). Three honest wrinkles, all surfaced by the tool itself in `ambiguities`: (1) the table title and VISIT/WEEK header labels are corrupted glyphs in the rendered PDF (broken font embedding); wording was recovered from the text layer; (2) the printed grid contains a genuinely blank spacer column between visits 5 and 7, represented as an ambiguity note rather than a fabricated "visit 6"; (3) "Study drug record / Medications dispensed / Medications returned" is printed as one bordered row with a three-line label and is extracted as one row, flagged.

**protocol5 (atomoxetine, Appendix I Time and Events Schedule + Appendix II Schedule of Blood Collections, rotated landscape, pages 50-51).** Locator: correct, one candidate covering both. Both tables extracted separately, which is the multi-SoA requirement working. Row-by-row check against the text dump: correct, including the "Cocaine Infusion Session #" row with numeric cells (1&2, 3...8), the starred footnotes and the Xa-Xf footnotes. A useful internal check passes: in Appendix II, every row's extracted per-day sample counts times its per-sample volume equals its extracted Total Volume (e.g. 45 PK samples x 5 mL = 225 mL), across all rows and the 390 mL grand total.

**protocol9 (lofexidine, Table 4 Schedule of Measures, 4 rotated pages 26-29, footnote page with no table on it).** Locator: correct after a fix this protocol forced (backward growth through below-threshold rotated pages). Full cell-by-cell check of page 27: exact, including VAS-E's irregular 1X pattern on days 1,3,4,6,8,10 and MCGI starting at day 4. The footnotes-only page 29 was correctly pulled in and its definitions linked. Two honest warts, both self-reported in `ambiguities`: the document superscripts CRF form numbers (01)-(33) on row labels, which the tool records as markers that resolve to no footnote text (correct: the definitions are not on these pages); and several rows (Morphine, Lofexidine dosing, Drop Out Day) mark occurrence with grey cell shading and no printed character, which the tool refuses to turn into invented "X"s and instead describes. If shaded-equals-scheduled is the intended reading, a human must confirm it; that is a question for a clinical SME, written down rather than guessed.

**protocol12 (modafinil, Table 3 Overview of Study Assessments, page 48, with its footnote block on page 49 under the heading "Notes on the Schedule of Assessments").** Locator: correct (includes page 50, which is narrative; the extractor correctly took nothing from it). Spot checks exact: the Pregnancy test row's five distinct markers across columns (Xg at weeks 1-3, Xb at 4 and 8, Xc at 12, plain X at follow-up), 3X/week values, "X wk 6" cells verbatim, the vertical RANDOMIZATION divider represented as a divider column, and all 14 footnote definitions captured from the following page and linked. One judgment call flagged by the tool: "Xc Xe" printed side by side in one cell is one cell value with two markers.

**protocol15 (cabergoline, Table 1, single dense page 25).** Locator: correct (over-includes the neighboring narrative pages; harmless). Full check of the trickiest rows against the page image: exact, including Serum prolactin (Xa, Xa, Xa, Xc in the correct four columns), CCQ-NOW's week-12 Xb (where every neighboring row uses Xc; the document's own inconsistency, preserved), "Weekly x 2 weeks" and "3 X/week for 2 weeks" verbatim including the document's own spacing ("3 X"), and all five footnote definitions.

Overall: across the five protocols I found no dropped assessment rows and no dropped visit columns in the committed outputs. The errors that remain are representational judgment calls, and in every case I checked, the tool had already flagged the situation in `ambiguities` rather than silently picking.

## Where it breaks, and what it does when it breaks

- **Scanned protocols (no text layer).** The locator sees empty pages and finds nothing. The UI says so and offers the manual page-range override; extraction from images still works via that path, but you have to find the pages yourself. Wiring OCR into the locator is the obvious fix (below).
- **SoAs longer than 12 pages.** The locator caps a candidate at 12 pages. Longer schedules are extracted as adjacent ranges and merged when row labels overlap; if a sponsor starts a completely new grid with reused generic row names, merge could over-combine. It fails visibly (inspect titles), not silently.
- **Very large tables can still hit the output-token ceiling on a single 2-page chunk.** The API detects `max_tokens` truncation and returns an explicit error instead of a truncated, half-parseable table.
- **Nondeterminism.** Two runs on the same pages produce the same grid but can differ in marker spelling ("Xa" vs "a") and in ambiguity phrasing. Within any single output the linkage is self-consistent, which is what the UI relies on.
- **Small-superscript misreads remain possible.** Vision at 150 dpi on 8 pt superscripts is the sharpest edge of this design. I did not catch one in the five committed outputs, but I would not claim the rate is zero; the source-page toggle in the UI exists precisely to make this cheap to check.
- **Vercel limits.** Extraction requests are capped at 300 s (`maxDuration`); a pathological table could exceed it and the client surfaces the failure. Payloads auto-downscale image quality to fit under 4.5 MB, which slightly increases misread risk on very long ranges.
- **Latency ceiling.** A 2-page chunk at `effort=low` is typically 20–45 seconds; a 4-page SoA is two chunks in parallel, so wall time tracks the slower chunk rather than the sum. Dense tables still take longer because output tokens still have to be decoded. See below.
- **The locator is heuristic.** On protocols far outside these idioms (a schedule with no X-style marks and no recognizable title, for example an EU dossier in another language) it may find nothing; the per-page score panel shows you what it saw, and the manual range is the escape hatch. Vision locate is the fallback for scans and unseen titles.

## Why extractions used to take 1–3 minutes (and what changed)

The dominant cost was **not** network or vision input. It was two things stacked: Anthropic's default `effort=high` adaptive thinking on Sonnet 5, plus decoding a verbose JSON blob for the whole table in one call.

What this repo now does about it:

1. **`effort=low`.** Extraction is transcription. High-effort thinking was spending tens of seconds before the first output token. This was the largest single win.
2. **Parallel 2-page chunks.** A 4-page SoA is two calls whose wall time is `max(chunk)`, not `sum(chunk)`. Merge is deterministic.
3. **Compact wire format.** Short keys and dense `v[]` arrays cut output tokens ~30-50% versus the public schema; `lib/compact.ts` expands them before the UI sees them.
4. **Opus is opt-in.** It is better on weird layouts, not faster. Using it as the default would have made large SoAs slower.

What still floors latency: Sonnet still emits one token at a time. A dense 80-column grid on two pages will take longer than a 9-column one. Prompt caching of the system prompt is on (`ephemeral`); it saves input processing, not decoding.

## What I would build next with two more weeks

1. **OCR fallback in the locator** (Tesseract WASM client-side, or the model itself on thumbnails) so scanned protocols locate automatically.
2. **A second-pass verifier**: re-send the extracted JSON with the page images and ask the model to diff its own output against the pixels, specifically hunting dropped rows/columns and marker misreads; then surface the diff in the UI. Recall is the graded failure, and self-checking is the cheapest recall insurance.
3. **Cross-request table merging** so 10+ page SoAs come back as one table.
4. **Deterministic post-validation**: schema-level lints (duplicate row labels across a page seam, markers with no footnote, footnotes with no marker, colspan overlaps) rendered as warnings next to ambiguities. Some of these exist implicitly; making them first-class would catch model slips mechanically.
5. **A golden-set regression harness**: the five verified outputs become fixtures; any prompt or model change re-runs the batch and diffs cell-by-cell, so quality changes are measured instead of vibed. Plus more protocols from ClinicalTrials.gov to widen the idiom coverage.
6. **Editable output**: let a human correct a cell in the UI and export the corrected JSON, turning verification effort into training/eval data.

## AI tools used

- **Claude Code** wrote effectively all of the code in this repo, benchmarked the candidate PDF libraries on the actual protocols, and did the page-image-versus-JSON verification passes (with the page renders and extracted grids compared directly). It also hit and diagnosed the real integration potholes: pdfjs v6 being unparseable by Next 14's webpack (pinned v4, worker served from `public/`), rotated-page text ordering changing between pdf.js versions (locator made line-structure-agnostic), and the Anthropic SDK requiring streaming for long generations.
- **Claude Sonnet 5** is the default extraction engine; **Opus 5** is the optional quality engine; **Haiku 4.5** is the vision locator.
- Where AI hurt: nothing catastrophic, but two things needed human-style discipline: the extractor occasionally varies surface details between runs (marker spelling), which cost a verification cycle to characterize; and it is tempting to accept a plausible-looking extraction without checking, since the failure mode of a good model is confident, tidy, and occasionally wrong. The per-protocol verification section above is the countermeasure, and it did catch one thing worth chasing (the NPI-X Xb linkage), where the model turned out to be right and my suspicion wrong.

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
scripts/extract-batch.ts   batch runner that produced outputs/ (npm run extract)
scripts/self-check.ts      compact-schema + merge sanity checks
scripts/dump.ts            prints an output JSON as a compact grid (verification aid)
scripts/debug-signals.ts   prints per-page locator scores for a PDF (debugging aid)
outputs/                   committed structured outputs for the five protocols
public/outputs/            same files, served to the UI as loadable samples
```

Note on the source PDFs: per the assignment's ground rules the five protocol documents are not committed to this repository; only the structured outputs are. To reproduce, place the PDFs anywhere and run `npm run extract -- /path/to/protocolN.pdf`.

## Assumptions and open questions for a clinical SME

- In protocol9, do grey-shaded cells with no printed character mean "activity occurs on this day"? The tool preserves the ambiguity; a data manager would need to rule.
- In protocol1, is the blank column between visits 5 and 7 a formatting artifact or a removed Visit 6? The output records it as an ambiguity rather than inventing a column.
- When a footnote's text contradicts the grid (protocol5's `**` note says chemistries happen "on days 6 and 13" while the grid marks day 13 but not day 6), both are preserved verbatim; reconciliation is a human call.
