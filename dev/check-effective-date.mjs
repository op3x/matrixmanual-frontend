// Fails while the unfilled effective-date token remains in the published site.
// At merge, set the one value in effective-date.js to the production deploy date.
// dev/ is not published and is not scanned.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['dev', 'node_modules', '.git', 'assets']);
const TOKEN = '[[EFFECTIVE_DATE]]';
const ADDRESS = /mailing address|\[OP3X MAILING ADDRESS\]|\[\[OP3X_MAILING_ADDRESS\]\]/i;

async function walk(dir, hits, addressHits) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, hits, addressHits);
      continue;
    }
    if (!/\.(html|js|css|xml|txt|md|yml|webmanifest)$/.test(entry.name)) continue;
    const text = await readFile(full, 'utf8');
    const count = text.split(TOKEN).length - 1;
    if (count) hits.push(path.relative(root, full) + ' (' + count + ')');
    if (entry.name.endsWith('.html') && ADDRESS.test(text)) addressHits.push(path.relative(root, full));
  }
}

const hits = [];
const addressHits = [];
await walk(root, hits, addressHits);
if (hits.length) {
  console.error('[[EFFECTIVE_DATE]] is still in the published site. Set the production deploy date in effective-date.js.');
  for (const hit of hits) console.error('  ' + hit);
  process.exit(1);
}
if (addressHits.length) {
  console.error('A page still shows a mailing address or the address placeholder.');
  for (const hit of addressHits) console.error('  ' + hit);
  process.exit(1);
}
console.log('PASS effective date is hard-coded and no page shows a mailing address');
