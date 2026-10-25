// Fails while the unfilled effective-date token remains in the published site.
// At merge, set the one value in effective-date.js to the production deploy date.
// dev/ is not published and is not scanned.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['dev', 'node_modules', '.git', 'assets']);
const TOKEN = '[[EFFECTIVE_DATE]]';

async function walk(dir, hits) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, hits);
      continue;
    }
    if (!/\.(html|js|css|xml|txt|md|yml|webmanifest)$/.test(entry.name)) continue;
    const text = await readFile(full, 'utf8');
    const count = text.split(TOKEN).length - 1;
    if (count) hits.push(path.relative(root, full) + ' (' + count + ')');
  }
}

const hits = [];
await walk(root, hits);
if (hits.length) {
  console.error('[[EFFECTIVE_DATE]] is still in the published site. Set the production deploy date in effective-date.js.');
  for (const hit of hits) console.error('  ' + hit);
  process.exit(1);
}
console.log('PASS effective date is hard-coded');
