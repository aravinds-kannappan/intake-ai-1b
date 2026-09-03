import { expandExtraction } from '../lib/compact';
import { chunkPages, mergeExtractions } from '../lib/merge';
import { trimCandidatePages } from '../lib/pages';
import { parseExtraction } from '../lib/extraction';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const compact = expandExtraction({
  tables: [
    {
      title: 'Schedule of Events',
      pages: [1],
      columns: [
        ['Screening', 'V1', '1', '-7', null, '±3'],
        ['Treatment', 'V2', '2', '1', null, null],
      ],
      rows: [
        { k: 'c', lab: 'Safety' },
        { k: 'a', lab: 'ECG', cat: 'Safety', c: { '0': 'X', '1': ['X', 'a'] } },
      ],
      fn: [['a', 'If clinically indicated']],
      notes: [],
      amb: [],
    },
  ],
});

assert(compact.tables[0].columns[0].visitNumber === '1', 'vn expands');
assert(compact.tables[0].rows[1].kind === 'assessment', 'k=a expands');
assert(compact.tables[0].rows[1].cells.length === 2, 'sparse cells');
assert(compact.tables[0].footnotes[0].marker === 'a', 'fn expands');
assert(
  compact.tables[0].footnotes[0].appliesTo.some((t) => t.target === 'cell'),
  'appliesTo rebuilt'
);

const left = {
  tables: [
    {
      ...compact.tables[0],
      pages: [1],
      columns: compact.tables[0].columns.slice(0, 1),
      rows: compact.tables[0].rows.map((r) => ({
        ...r,
        cells: r.cells.filter((c) => c.col === 'c1'),
      })),
    },
  ],
};
const right = {
  tables: [
    {
      ...compact.tables[0],
      id: 't9',
      pages: [2],
      columns: compact.tables[0].columns.slice(1),
      rows: compact.tables[0].rows.map((r) => ({
        ...r,
        cells: r.cells.filter((c) => c.col === 'c2'),
      })),
    },
  ],
};
const merged = mergeExtractions([left, right]);
assert(merged.tables.length === 1, 'continuation tables merge');
assert(merged.tables[0].columns.length === 2, 'columns unioned');

assert(chunkPages([1, 2, 3], 1).length === 3, '1-page chunks');
assert(
  trimCandidatePages(
    [1, 2, 3, 4],
    [
      { page: 1, score: 10, signals: ['title: x'] },
      { page: 2, score: 0, signals: [] },
      { page: 3, score: 8, signals: ['3 grid-like rows'] },
      { page: 4, score: 0, signals: [] },
    ]
  ).join(',') === '1,3,4',
  'trim keeps ends + grid'
);

const committed = JSON.parse(readFileSync(join('outputs', 'protocol1.json'), 'utf8'));
const roundTrip = parseExtraction(JSON.stringify(committed));
assert(roundTrip.tables[0].rows.length === committed.tables[0].rows.length, 'full schema still parses');

console.log('self-check ok');
