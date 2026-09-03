import { expandExtraction } from '../lib/compact';
import { chunkPages, mergeExtractions } from '../lib/merge';
import { parseExtraction } from '../lib/extraction';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const compact = expandExtraction({
  tables: [
    {
      id: 't1',
      title: 'Schedule of Events',
      pages: [1],
      columns: [
        { id: 'c1', path: ['Screening'], label: 'V1', vn: '1', d: '-7', wk: null, w: '±3', m: [] },
        { id: 'c2', path: ['Treatment'], label: 'V2', vn: '2', d: '1', wk: null, w: null, m: ['a'] },
      ],
      rows: [
        { id: 'r1', k: 'c', lab: 'Safety', cat: null, m: [], v: [] },
        { id: 'r2', k: 'a', lab: 'ECG', cat: 'Safety', m: [], v: ['X', 'Xa'], mm: [[], ['a']] },
      ],
      fn: [{ m: 'a', t: 'If clinically indicated', cont: false, at: [{ t: 'cell', r: 'r2', c: 'c2' }] }],
      notes: [],
      amb: [],
    },
  ],
});

assert(compact.tables[0].columns[0].visitNumber === '1', 'vn expands');
assert(compact.tables[0].rows[1].kind === 'assessment', 'k=a expands');
assert(compact.tables[0].rows[1].cells[1].value === 'Xa' || compact.tables[0].rows[1].cells[1].markers.includes('a'), 'cell markers');
assert(compact.tables[0].footnotes[0].marker === 'a', 'fn expands');

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
assert(merged.tables[0].pages.join(',') === '1,2', 'pages unioned');
assert(
  merged.tables[0].rows.find((r) => r.label === 'ECG')!.cells.length === 2,
  'cells unioned across pages'
);

const chunks = chunkPages([1, 2, 3, 4, 5], 2);
assert(chunks.length === 3 && chunks[2][0] === 5, 'chunkPages');

const committed = JSON.parse(
  readFileSync(join('outputs', 'protocol1.json'), 'utf8')
);
const roundTrip = parseExtraction(JSON.stringify(committed));
assert(roundTrip.tables[0].rows.length === committed.tables[0].rows.length, 'full schema still parses');

console.log('self-check ok');
