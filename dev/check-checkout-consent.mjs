// Headless Playwright check: the Pro checkout consent shows exactly one seller variant.
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

async function readConsent(page) {
  return page.evaluate(() => {
    const label = document.querySelector('label[for="pro-consent"]');
    const direct = label.querySelector('[data-seller-direct]');
    const mp = label.querySelector('[data-seller-mp]');
    function shown(el) {
      if (!el || el.hidden || el.closest('[hidden]')) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }
    return {
      direct: shown(direct),
      mp: shown(mp),
      text: label.innerText.replace(/\s+/g, ' ').trim(),
      mode: document.documentElement.getAttribute('data-checkout-config'),
    };
  });
}

function expectOne(state, mode) {
  const shown = Number(state.direct) + Number(state.mp);
  if (state.mode !== mode || shown !== 1) {
    throw new Error(mode + ' consent did not render exactly one variant ' + JSON.stringify(state));
  }
  if (mode === 'mp') {
    if (!state.mp || state.direct) throw new Error('mp variant hidden ' + JSON.stringify(state));
    if (!state.text.includes("ManualOS's authorized reseller to charge my card $79 plus applicable taxes each month")) {
      throw new Error('mp consent text ' + state.text);
    }
    if (state.text.includes('Op3x LLC to charge my card')) throw new Error('direct variant leaked into mp consent');
  } else {
    if (!state.direct || state.mp) throw new Error('direct variant hidden ' + JSON.stringify(state));
    if (!state.text.includes('Op3x LLC to charge my card $79 plus applicable taxes each month')) throw new Error('direct consent text ' + state.text);
    if (state.text.includes('authorized reseller') || /\bLink\b/.test(state.text)) throw new Error('reseller variant leaked into direct consent');
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
  async function shot(mode) {
    await page.goto(base + '/index.html?seller=' + mode + '#pricing', { waitUntil: 'networkidle' });
    await page.waitForFunction((expected) => document.documentElement.getAttribute('data-checkout-config') === expected, mode);
    const state = await readConsent(page);
    expectOne(state, mode);
    const card = page.locator('article.is-pro .plan-buy');
    await card.screenshot({ path: path.join(shotDir, 'checkout-consent-' + mode + '.png') });
    console.log('PASS ' + mode + ' consent shows one variant');
  }
  await shot('mp');
  const posted = await fetch(base + '/__mock/checkout-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ managedPayments: false, fail: false, hold: false }),
  });
  if (!posted.ok) throw new Error('could not switch checkout config');
  await shot('direct');
} finally {
  await browser.close();
  child.kill('SIGTERM');
}
