import { readFileSync } from 'node:fs';
const f = process.argv[2];
const j = JSON.parse(readFileSync(f, 'utf8'));
for (const t of j.tables) {
  console.log(`\n### ${t.title} (pages ${t.pages}) cols=${t.columns.length} rows=${t.rows.length} fn=${t.footnotes.length}`);
  console.log('COLS: ' + t.columns.map((c: any) => `${c.id}=${c.label}${c.path?.length ? '<' + c.path.join('/') + '>' : ''}${c.studyDay ? ' d:' + c.studyDay : ''}${c.studyWeek ? ' w:' + c.studyWeek : ''}${c.markers?.length ? '^' + c.markers.join(',') : ''}`).join(' | '));
  for (const r of t.rows) {
    const cells = (r.cells || []).map((c: any) => `${c.col}:${c.value}${c.colspan ? '*' + c.colspan : ''}${c.markers?.length ? '^' + c.markers.join(',') : ''}`).join(' ');
    console.log(`${r.kind === 'category' ? '== ' : '   '}${r.label}${r.markers?.length ? '^' + r.markers.join(',') : ''}  ${cells}`);
  }
  console.log('FOOTNOTES: ' + t.footnotes.map((fn: any) => fn.marker).join(', '));
  console.log('NOTES: ' + (t.notes || []).length + ' | AMBIGUITIES: ' + (t.ambiguities || []).length);
}
