// Headless Playwright check: each plan checkbox uses the approved sentence,
// and Buy stays disabled until that box is ticked.
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

const PRO_LABEL = 'I agree to the ManualOS Terms and authorize Op3x LLC to charge my card $79/month (USD, plus applicable taxes), renewing automatically each month until I cancel.';
const STARTER_LABEL = "I agree to the ManualOS Terms and authorize Op3x LLC to make this one-time charge. This isn't a subscription.";
const PRO_BESIDE = "Renews automatically at $79 plus applicable taxes each month until you cancel. Cancel anytime online: use the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Pro until the end of the period you've paid for. Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.";
const STARTER_BESIDE = 'Full refund within 30 days of purchase, as long as no manual from that purchase has been delivered, except where the law requires otherwise.';

async function readConsent(page) {
  return page.evaluate(() => {
    const label = document.querySelector('label[for="pro-consent"]');
    const starter = document.querySelector('label[for="starter-consent"]');
    const button = document.querySelector('[data-checkout="pro"]');
    const box = document.getElementById('pro-consent');
    const renewal = document.getElementById('pro-auto-renew');
    const starterRefund = document.getElementById('starter-renew-terms');
    const starterButton = document.querySelector('[data-checkout="starter"]');
    return {
      text: label.innerText.replace(/\s+/g, ' ').trim(),
      starter: starter.innerText.replace(/\s+/g, ' ').trim(),
      href: label.querySelector('a').href,
      starterHref: starter.querySelector('a').href,
      renewal: renewal.innerText.replace(/\s+/g, ' ').trim(),
      starterRefund: starterRefund.innerText.replace(/\s+/g, ' ').trim(),
      nextToBuy: renewal.nextElementSibling === button,
      nextToConsent: renewal.previousElementSibling === box.closest('.consent-row'),
      starterNextToBuy: starterRefund.nextElementSibling === starterButton,
      variants: document.querySelectorAll('[data-seller-direct],[data-seller-mp],[data-statement]').length,
      disabled: button.disabled,
      checked: box.checked,
      starterDisabled: starterButton.disabled,
    };
  });
}

function expectLabel(state) {
  if (state.variants || state.checked || !state.disabled || !state.starterDisabled) {
    throw new Error('consent gate ' + JSON.stringify(state));
  }
  if (state.text !== PRO_LABEL || state.href !== 'https://manualos.com/terms.html') {
    throw new Error('pro label ' + JSON.stringify(state));
  }
  if (state.starter !== STARTER_LABEL || state.starterHref !== 'https://manualos.com/terms.html') {
    throw new Error('starter label ' + JSON.stringify(state));
  }
  if (state.renewal !== PRO_BESIDE || !state.nextToBuy || !state.nextToConsent || !state.starterRefund.includes(STARTER_BESIDE) || !state.starterNextToBuy) {
    throw new Error('disclosure is not beside the checkbox and Buy ' + JSON.stringify(state));
  }
  if (/authorized reseller|LINK\.COM|merchant of record|app\.link\.com/i.test(state.text + state.starter + state.renewal + state.starterRefund)) {
    throw new Error('retired copy ' + state.text);
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
  const state = await readConsent(page);
  expectLabel(state);
  const card = page.locator('article.is-pro .plan-buy');
  await card.screenshot({ path: path.join(shotDir, 'checkout-consent.png') });
  await page.click('#pro-consent');
  const enabled = await page.$eval('[data-checkout="pro"]', (el) => !el.disabled && document.getElementById('pro-consent').checked);
  if (!enabled) throw new Error('ticking the box did not enable Buy');
  await page.click('#pro-consent');
  const disabledAgain = await page.$eval('[data-checkout="pro"]', (el) => el.disabled && !document.getElementById('pro-consent').checked);
  if (!disabledAgain) throw new Error('clearing the box left Buy enabled');
  console.log('PASS consent label, and Buy stays disabled until ticked');
} finally {
  await browser.close();
  child.kill('SIGTERM');
}
