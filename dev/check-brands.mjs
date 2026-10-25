// Fails when shipped HTML or JS names a real vendor or product,
// or the retired sample names CP-200, CP200, and Acme.
// A third-party video site is a vendor name anywhere in shipped HTML or JS,
// including text, alt, aria-label, title, src, and href. No embed URL is exempt.
// Grok is a vendor name. The only allowed occurrence is the exact footer
// line "Hero video created with Grok." in <p class="hero-video-credit">
// inside <footer>. Any other Grok text, including alt, title, aria-label,
// a link, or a credit next to the video, still fails.
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
  'Grok',
];

function brandPattern(name) {
  const parts = name.split(/[- ]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const body = parts.join('[-\\s]+');
  const source = name.includes(' ') || name.includes('-') ? body : `\\b${body}\\b`;
  return new RegExp(source, 'i');
}

const PATTERNS = BRAND_NAMES.map((name) => ({ name, re: brandPattern(name) }));

const THIRD_PARTY_VIDEO = ['you', 'tube'].join('');

function findThirdPartyVideoHits(text) {
  const hits = [];
  const re = new RegExp(THIRD_PARTY_VIDEO, 'gi');
  for (const match of text.matchAll(re)) hits.push(match.index);
  return hits;
}

export const HERO_CREDIT_TEXT = 'Hero video created with Grok.';

const HERO_CREDIT_RE = /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bhero-video-credit\b[^"']*["'][^>]*>\s*Hero video created with Grok\.\s*<\/p>/gi;

function footerRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/<footer\b[\s\S]*?<\/footer>/gi)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export function maskHeroCredit(text) {
  const ranges = footerRanges(text);
  if (!ranges.length) return text;
  HERO_CREDIT_RE.lastIndex = 0;
  return text.replace(HERO_CREDIT_RE, (match, offset) => {
    const inside = ranges.some(([from, to]) => offset >= from && offset + match.length <= to);
    return inside ? '<p class="hero-video-credit"></p>' : match;
  });
}

function excerpt(text, index) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 60);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

export function findBrandHitsInText(file, text) {
  const hits = [];
  const masked = maskHeroCredit(text);
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(masked);
    if (match) {
      hits.push({
        file,
        name,
        excerpt: excerpt(masked, match.index),
      });
    }
  }
  for (const index of findThirdPartyVideoHits(masked)) {
    hits.push({
      file,
      name: 'third-party video',
      excerpt: excerpt(masked, index),
    });
  }
  return hits;
}

export function heroCreditProblems() {
  const problems = [];
  const cases = [
    ['exact footer credit', '<footer><p class="hero-video-credit">Hero video created with Grok.</p></footer>', false],
    ['credit beside the video', '<div class="hero-film"><p>Created with Grok</p></div>', true],
    ['alt text', '<img alt="Made with Grok">', true],
    ['title', '<video title="Grok film"></video>', true],
    ['aria-label', '<button aria-label="Play the Grok film">Play</button>', true],
    ['linked credit', '<footer><p class="hero-video-credit"><a href="/about">Hero video created with Grok.</a></p></footer>', true],
    ['missing period', '<footer><p class="hero-video-credit">Hero video created with Grok</p></footer>', true],
    ['outside the footer', '<p class="hero-video-credit">Hero video created with Grok.</p>', true],
    ['extra wording', '<footer><p class="hero-video-credit">Hero video created with Grok. A real technician.</p></footer>', true],
  ];
  for (const [label, html, shouldHit] of cases) {
    const hits = findBrandHitsInText(label, html).filter((hit) => hit.name === 'Grok');
    if (shouldHit && !hits.length) problems.push(label + ' should flag Grok');
    if (!shouldHit && hits.length) problems.push(label + ' should allow only the footer credit');
  }
  return problems;
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
      hits.push(...findBrandHitsInText(path.relative(rootDir, full), text));
    }
  }
  await walk(rootDir);
  return hits;
}

export async function assertNoBrandNames(rootDir) {
  const problems = heroCreditProblems();
  const hits = await findBrandHits(rootDir);
  if (!problems.length && !hits.length) return;
  const lines = [
    ...problems,
    ...hits.map((hit) => `${hit.file}: ${hit.name} — ${hit.excerpt}`),
  ];
  throw new Error('shipped HTML/JS names a vendor or product:\n' + lines.join('\n'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = heroCreditProblems();
  const hits = await findBrandHits(root);
  if (problems.length || hits.length) {
    for (const problem of problems) console.error(problem);
    for (const hit of hits) console.error(`${hit.file}: ${hit.name} — ${hit.excerpt}`);
    process.exitCode = 1;
  } else {
    console.log('PASS shipped HTML and JS do not name vendors');
  }
}
