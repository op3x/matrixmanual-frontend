// Fails when shipped HTML or JS names a real vendor or product,
// or the retired sample names CP-200, CP200, and Acme.
// dev/ is out of scope: the upload check types sample values into the form.
// Binary assets are not scanned.
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
  'CP-200',
  'CP200',
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

function rangesOf(text, re) {
  const flags = re.flags.includes('g') ? re : new RegExp(re.source, re.flags + 'g');
  const ranges = [];
  let match;
  while ((match = flags.exec(text))) {
    ranges.push([match.index, match.index + match[0].length, match[0]]);
    if (match[0].length === 0) flags.lastIndex += 1;
  }
  return ranges;
}

function mpSectionRanges(text) {
  const re = /<([a-z0-9]+)[^>]*\sdata-mp-section\b[^>]*>[\s\S]*?<\/\1>/gi;
  const ranges = [];
  let match;
  while ((match = re.exec(text))) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

function inside(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

// "Link" is allowed only inside data-mp-section.
// app.link.com is allowed only inside data-mp-section.
// LINK.COM is never allowed.
export function disallowedLinkHits(text) {
  const sections = mpSectionRanges(text);
  const hits = [];
  for (const [index, , raw] of rangesOf(text, /\bLink\b/g)) {
    if (!inside(sections, index)) hits.push({ index, raw, reason: 'Link outside a managed-payments section' });
  }
  for (const [index, , raw] of rangesOf(text, /LINK\.COM/g)) {
    hits.push({ index, raw, reason: 'LINK.COM is not allowed' });
  }
  for (const [index, , raw] of rangesOf(text, /link\.com/g)) {
    const appHost = text.slice(Math.max(0, index - 4), index) === 'app.';
    if (!(appHost && inside(sections, index))) hits.push({ index, raw, reason: 'app.link.com outside a managed-payments section' });
  }
  return hits;
}

export function assertLinkExceptions() {
  const cases = [
    ['<p>Pay with Link.</p>', true],
    ['<p data-statement hidden>Appears on your card statement as LINK.COM* MANUALOS</p>', true],
    ['<p data-mp-section hidden>Link is the seller and the merchant of record.</p>', false],
    ['<p>Link is the seller.</p>', true],
    ['<p data-mp-section hidden>Card shows LINK.COM* MANUALOS</p>', true],
    ['<p>Use the link below.</p>', false],
    ['<a class="skip-link" href="#main">Skip</a>', false],
    ['<p>Cancel at link.com today.</p>', true],
    ['<p data-mp-section hidden>Subscriptions can also be managed or cancelled from the reseller\'s order-management site (link.com).</p>', true],
    ['<p><a href="https://app.link.com">app.link.com</a></p>', true],
    ['<p data-mp-section hidden><a href="https://app.link.com">app.link.com</a></p>', false],
  ];
  for (const [sample, expectHit] of cases) {
    const got = disallowedLinkHits(sample).length > 0;
    if (got !== expectHit) throw new Error('link exception case failed: ' + sample);
  }
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
      const file = path.relative(rootDir, full);
      for (const { name, re } of PATTERNS) {
        const match = re.exec(text);
        if (match) hits.push({ file, name, excerpt: excerpt(text, match.index) });
      }
      for (const hit of disallowedLinkHits(text)) {
        hits.push({ file, name: 'Link', excerpt: excerpt(text, hit.index) + ' (' + hit.reason + ')' });
      }
    }
  }
  await walk(rootDir);
  return hits;
}

export async function assertNoBrandNames(rootDir) {
  assertLinkExceptions();
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
