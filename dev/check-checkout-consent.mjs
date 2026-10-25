// Headless Playwright check: each pricing card discloses the charge and leaves Terms to checkout.
// Does not call production. Screenshots go to SCREENSHOT_DIR.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

function loadPlaywright() {
  const fromHere = createRequire(import.meta.url);
  const candidates = ['playwright-core', '/tmp/pw/node_modules/playwright-core'];
  for (const name of candidates) {
    try { return fromHere(name); } catch { /* try the next location */ }
  }
  throw new Error('Install playwright-core to run this check.');
}
const { chromium } = loadPlaywright();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.env.SCREENSHOT_DIR || '/opt/cursor/artifacts/screenshots';
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const proDisclosure = "Renews automatically at $79 plus applicable taxes each month until you cancel. Cancel anytime online: use the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Pro until the end of the period you've paid for. Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise. You'll accept the Terms at checkout.";
const starterDisclosure = "$39 one time for 3 manuals, plus applicable taxes. Full refund within 30 days of purchase, as long as no manual from that purchase has been delivered, except where the law requires otherwise. You'll accept the Terms at checkout.";

function startMock() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dev/mock-api.mjs'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('mock did not start')), 8000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/MOCK (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, base: match[1] });
      }
    });
    child.on('exit', (code) => {
      if (code) reject(new Error('mock exited ' + code));
    });
  });
}

async function readCards(page) {
  return page.evaluate(() => {
    function text(id) {
      return document.getElementById(id).innerText.replace(/\s+/g, ' ').trim();
    }
    const pro = document.querySelector('[data-checkout="pro"]');
    const starter = document.querySelector('[data-checkout="starter"]');
    return {
      checkbox: document.querySelector('#pricing input[type="checkbox"]') !== null,
      proDisabled: pro.disabled,
      starterDisabled: starter.disabled,
      note: document.getElementById('pro-seller-note') !== null,
      statement: document.getElementById('pro-statement') !== null,
      variants: document.querySelectorAll('[data-seller-direct],[data-seller-mp],[data-statement]').length,
      pro: text('pro-auto-renew'),
      starter: text('starter-renew-terms'),
    };
  });
}

function expectCards(state) {
  if (state.checkbox || state.proDisabled || state.starterDisabled || state.note || state.statement || state.variants) {
    throw new Error('buy state ' + JSON.stringify(state));
  }
  if (state.pro !== proDisclosure) throw new Error('pro disclosure ' + state.pro);
  if (state.starter !== starterDisclosure) throw new Error('starter disclosure ' + state.starter);
  if (/merchant of record|app\.link\.com|authorized reseller|LINK\.COM|link\.com/i.test(state.pro + state.starter)) {
    throw new Error('still has retired copy ' + JSON.stringify(state));
  }
}

const { child, base } = await startMock();
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  await mkdir(shotDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.goto(base + '/index.html#pricing', { waitUntil: 'domcontentloaded' });
  expectCards(await readCards(page));
  await page.locator('#pricing').screenshot({ path: path.join(shotDir, 'pricing-cards.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expectCards(await readCards(page));
  await page.locator('#pricing').screenshot({ path: path.join(shotDir, 'pricing-cards-390.png') });
  console.log('PASS pricing cards disclose the charge without a consent checkbox');
} finally {
  await browser.close();
  child.kill('SIGTERM');
}
