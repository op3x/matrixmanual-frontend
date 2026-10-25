// The home hero uses the v2 film only. The built site must not name the
// third-party host or the old poster, and the footer credit is the exact
// approved line.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.xml', '.txt', '.yml', '.yaml', '.md', '.svg', '.webmanifest']);
const SKIP_DIRS = new Set(['.git', 'dev', 'node_modules']);
const HERO_FILES = {
  'assets/hero/manualos-hero-draft-v3-original.mp4': {
    sha256: '1f0a93ec56863048d29d1e4b6409d0f204a6abb2f3a55fac8839610bfda16b6c',
    bytes: 2614720,
  },
  'assets/hero/frame-v3a.jpg': {
    sha256: 'dc478abd389c0aa038640dcb3fe1049ea57868ecd15b082763853696b7b11ac8',
    bytes: 207069,
  },
};
const FORBIDDEN_HERO = [
  'manualos-hero-draft-v2-muted.mp4',
  'manualos-hero-draft-v3-muted.mp4',
  'manualos-hero-poster-v3.jpg',
  'manualos-hero-poster.jpg',
];
const CREDIT = 'Hero video created with Grok.';
const THIRD_PARTY_VIDEO = ['you', 'tube'].join('');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function walk(dir, onFile) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, onFile);
      continue;
    }
    await onFile(full);
  }
}

export async function heroFilmProblems(rootDir) {
  const problems = [];
  await walk(rootDir, async (full) => {
    const rel = path.relative(rootDir, full);
    const base = path.basename(full).toLowerCase();
    if (rel.startsWith('assets/hero/') && (base.includes('mechanical-intelligence') || base.includes('v1'))) {
      problems.push('unexpected hero file ' + rel);
    }
    const ext = path.extname(full).toLowerCase();
    if (TEXT_EXT.has(ext)) {
      const text = await readFile(full, 'utf8');
      const lower = text.toLowerCase();
      if (lower.includes(THIRD_PARTY_VIDEO)) problems.push(rel + ' names a third-party video site');
      if (lower.includes('video host') || lower.includes('video-cookie') || lower.includes('cookies from the video')) {
        problems.push(rel + ' has a video-host or video-cookie note');
      }
      if (text.includes('-NdfRTpad-M')) problems.push(rel + ' contains the third-party video id');
      if (lower.includes('mechanical-intelligence')) problems.push(rel + ' contains mechanical-intelligence');
      if (text.includes('Play the short film')) problems.push(rel + ' contains Play the short film');
      if (/psyche\s*decode/i.test(text)) problems.push(rel + ' contains Psyche Decode');
    } else if (ext === '.mp4' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
      const bytes = await readFile(full);
      const lower = bytes.toString('latin1').toLowerCase();
      if (lower.includes(THIRD_PARTY_VIDEO)) problems.push(rel + ' bytes name a third-party video site');
      if (lower.includes('-ndfrtpad-m')) problems.push(rel + ' bytes contain the third-party video id');
      if (lower.includes('psyche')) problems.push(rel + ' bytes contain Psyche');
    }
  });

  const heroDir = path.join(rootDir, 'assets/hero');
  let heroNames = [];
  try {
    heroNames = (await readdir(heroDir)).sort();
  } catch {
    problems.push('missing assets/hero');
  }
  const expectedNames = Object.keys(HERO_FILES).map((rel) => path.basename(rel)).sort();
  if (heroNames.join('\n') !== expectedNames.join('\n')) {
    problems.push('assets/hero must contain only the v3 original and frame-v3a, found ' + heroNames.join(', '));
  }
  for (const name of FORBIDDEN_HERO) {
    if (heroNames.includes(name)) problems.push('transcoded hero file remains: ' + name);
  }

  for (const [rel, expected] of Object.entries(HERO_FILES)) {
    let bytes;
    try {
      bytes = await readFile(path.join(rootDir, rel));
    } catch {
      problems.push('missing ' + rel);
      continue;
    }
    if (bytes.length !== expected.bytes) problems.push(rel + ' is ' + bytes.length + ' bytes');
    const actual = sha256(bytes);
    if (actual !== expected.sha256) problems.push(rel + ' sha256 ' + actual + ' != ' + expected.sha256);
    if (!bytes.includes(Buffer.from('c2pa')) || !bytes.includes(Buffer.from('jumb'))) {
      problems.push(rel + ' is missing a c2pa JUMBF label');
    }
  }

  const index = await readFile(path.join(rootDir, 'index.html'), 'utf8');
  if (!index.includes('src="/assets/hero/frame-v3a.jpg"')) problems.push('poster is not in the hero');
  if (!index.includes('fetchpriority="high"')) problems.push('poster is missing fetchpriority=high');
  const videoTag = index.match(/<video\b[^>]*>/i);
  if (!videoTag || !/\bmuted\b/.test(videoTag[0]) || !/\bloop\b/.test(videoTag[0]) || !/\bplaysinline\b/.test(videoTag[0]) || !/\bautoplay\b/.test(videoTag[0]) || /\bcontrols\b/.test(videoTag[0])) {
    problems.push('video must be muted autoplay loop playsinline and must not have controls');
  }
  if (/<video\b[^>]*\bsrc=/i.test(index)) problems.push('video source is in the HTML before the poster can paint');
  if (!index.includes("var SRC = '/assets/hero/manualos-hero-draft-v3-original.mp4';")) problems.push('desktop script is missing the v3 original');
  if ((index.match(/<iframe\b/gi) || []).length) problems.push('built index.html contains an iframe');
  const credits = index.match(/<p class="hero-video-credit">Hero video created with Grok\.<\/p>/g) || [];
  if (credits.length !== 1) problems.push('footer credit count ' + credits.length);
  const footer = index.slice(index.indexOf('<footer'), index.indexOf('</footer>'));
  if (!footer.includes(CREDIT)) problems.push('footer is missing the credit');
  const film = index.slice(index.indexOf('id="hero-film"'), index.indexOf('</footer>'));
  const filmOnly = film.slice(0, film.indexOf('<footer'));
  if (filmOnly.includes(CREDIT) || filmOnly.includes('Created with Grok')) problems.push('credit is next to the video');
  if (index.includes('HERO_FILM_ENABLED') || index.includes('HERO_FILM_ID')) problems.push('third-party film flag remains');
  return problems;
}

export async function assertHeroFilm(rootDir) {
  const problems = await heroFilmProblems(rootDir);
  if (!problems.length) return;
  throw new Error('hero film check failed:\n' + problems.join('\n'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = await heroFilmProblems(root);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else {
    console.log('PASS built site has no third-party video site, the v3 original files match and keep c2pa, and the footer credit is exact');
  }
}
