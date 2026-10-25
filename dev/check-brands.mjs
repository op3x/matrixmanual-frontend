// Fails when shipped HTML or JS names a real vendor or product.
// README, dev/, and assets are out of scope: the sample PDF still carries a
// fictional cover until those files are replaced, and the README may name formats.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['dev', 'node_modules', '.git', 'assets']);

export const BRAND_NAMES = [
  'Rockwell',
  'Allen-Bradley',
  'Studio 5000',
  'Logix',
  'Siemens',
  'TIA Portal',
  'Schneider',
  'Mitsubishi',
  'GX Works',
  'Omron',
  'CX-Programmer',
  'Beckhoff',
  'TwinCAT',
  'CODESYS',
  'SolidWorks',
  'Inventor',
  'Fusion',
  'Creo',
  'AutoCAD',
  'Stripe',
  'Acme',
];

function brandPattern(name) {
  const parts = name.split(/[- ]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const body = parts.join('[-\\s]+');
  const source = name.includes(' ') || name.includes('-') ? body : `\\b${body}\\b`;
  return new RegExp(source, 'i');
}

const PATTERNS = BRAND_NAMES.map((name) => ({ name, re: brandPattern(name) }));

function excerpt(text, index) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 60);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

export async function findBrandHits(rootDir) {
  const hits = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!/\.(html|js)$/i.test(entry.name)) continue;
      const text = await readFile(full, 'utf8');
      for (const { name, re } of PATTERNS) {
        const match = re.exec(text);
        if (match) {
          hits.push({
            file: path.relative(rootDir, full),
            name,
            excerpt: excerpt(text, match.index),
          });
        }
      }
    }
  }
  await walk(rootDir);
  return hits;
}

export async function assertNoBrandNames(rootDir) {
  const hits = await findBrandHits(rootDir);
  if (!hits.length) return;
  const lines = hits.map((hit) => `${hit.file}: ${hit.name} — ${hit.excerpt}`);
  throw new Error('shipped HTML/JS names a vendor or product:\n' + lines.join('\n'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hits = await findBrandHits(root);
  if (hits.length) {
    for (const hit of hits) console.error(`${hit.file}: ${hit.name} — ${hit.excerpt}`);
    process.exitCode = 1;
  } else {
    console.log('PASS shipped HTML and JS do not name vendors');
  }
}
