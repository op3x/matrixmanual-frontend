// SMS opt-in on support.html rejects obvious non-US numbers and shows the inline error.
// Requires puppeteer-core and Chrome. Does not call production.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadPuppeteer() {
  const candidates = ['puppeteer-core', '/tmp/manualos-test/node_modules/puppeteer-core'];
  for (const name of candidates) {
    try { return require(name); } catch { /* try the next location */ }
  }
  throw new Error('Install puppeteer-core to run this check.');
}
const puppeteer = loadPuppeteer();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const INVALID = 'Enter a valid US mobile number.';
const rejected = [
  '0000000000',
  '1111111111',
  '2222222222',
  '12222222222',
  '0125551212',
  '1125551212',
  '2120123456',
  '2121550199',
  '(217) 555-0100',
  '(217) 555-0199',
  '+1 (217) 555-0199',
];
const accepted = ['(217) 555-1212', '2025551212', '+1 415 555 2671'];

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
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, base: match[0] });
      }
    });
    child.on('exit', (code) => {
      if (code) reject(new Error('mock exited ' + code));
    });
  });
}

async function fill(page, base, phone, consent) {
  await page.goto(base + '/support.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((value, optIn) => {
    document.getElementById('support-name').value = 'Ada Lovelace';
    document.getElementById('support-email').value = 'ada@example.com';
    document.getElementById('support-message').value = 'The manual link stopped working.';
    document.getElementById('support-phone').value = value;
    document.getElementById('sms-consent').checked = optIn;
  }, phone, consent);
  await page.click('#support-submit');
}

async function phoneState(page) {
  return page.evaluate(() => {
    const input = document.getElementById('support-phone');
    const error = document.getElementById('support-phone-error');
    const style = getComputedStyle(error);
    const rect = error.getBoundingClientRect();
    return {
      invalid: input.getAttribute('aria-invalid'),
      described: input.getAttribute('aria-describedby') || '',
      hidden: error.hidden,
      text: error.textContent,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0,
      role: error.getAttribute('role'),
      focus: document.activeElement && document.activeElement.id,
      formError: document.getElementById('form-error').textContent,
      statusHidden: document.getElementById('form-status').hidden,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

async function main() {
  const { child, base } = await startMock();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    page.on('dialog', (dialog) => dialog.dismiss());
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('click', (event) => {
        const link = event.target && event.target.closest && event.target.closest('a[href^="mailto:"]');
        if (link) event.preventDefault();
      }, true);
    });
    await page.goto(base + '/support.html', { waitUntil: 'networkidle0' });

    for (const phone of rejected) {
      await fill(page, base, phone, true);
      await page.waitForFunction(() => document.getElementById('support-phone-error').textContent.length > 0);
      const state = await phoneState(page);
      if (state.text !== INVALID || state.hidden || !state.visible || state.invalid !== 'true') {
        throw new Error(phone + ' was accepted ' + JSON.stringify(state));
      }
      if (!state.described.includes('support-phone-error') || !state.described.includes('phone-hint')) {
        throw new Error(phone + ' error is not described ' + JSON.stringify(state));
      }
      if (state.role !== 'alert' || state.focus !== 'support-phone' || state.statusHidden !== true) {
        throw new Error(phone + ' inline error ' + JSON.stringify(state));
      }
      if (!state.formError.includes('highlighted') || state.overflow > 1) {
        throw new Error(phone + ' form ' + JSON.stringify(state));
      }
      console.log('PASS rejects ' + phone);
    }

    const axePath = '/tmp/manualos-test/node_modules/axe-core/axe.min.js';
    await access(axePath);
    await page.addScriptTag({ path: axePath });
    const violations = await page.evaluate(async () => {
      const out = await window.axe.run(document, { resultTypes: ['violations'] });
      return out.violations.map((item) => ({ id: item.id, nodes: item.nodes.length }));
    });
    if (violations.length) throw new Error('support phone error axe: ' + JSON.stringify(violations));
    console.log('PASS axe on the inline phone error');

    await fill(page, base, '555-0100', true);
    await page.waitForFunction(() => document.getElementById('support-phone-error').textContent.length > 0);
    const short = await phoneState(page);
    if (short.text !== 'Enter a phone number with at least 10 digits.') {
      throw new Error('short number ' + JSON.stringify(short));
    }
    console.log('PASS rejects a short 555-01xx');

    await fill(page, base, '', true);
    await page.waitForFunction(() => document.getElementById('support-phone-error').textContent.length > 0);
    const empty = await phoneState(page);
    if (empty.text !== 'Enter the mobile number that should receive texts.') {
      throw new Error('empty opt-in ' + JSON.stringify(empty));
    }
    console.log('PASS still requires a number when opting in');

    for (const phone of accepted) {
      await fill(page, base, phone, true);
      await page.waitForFunction(() => document.getElementById('form-error').textContent.includes('opt-in'));
      const state = await phoneState(page);
      if (state.text || state.invalid || !state.hidden) {
        throw new Error(phone + ' was rejected ' + JSON.stringify(state));
      }
      console.log('PASS allows ' + phone);
    }

    await fill(page, base, '0000000000', false);
    await page.waitForFunction(() => !document.getElementById('form-status').hidden);
    const optional = await phoneState(page);
    if (optional.text || optional.invalid) throw new Error('optional phone blocked ' + JSON.stringify(optional));
    console.log('PASS leaves an unchecked opt-in alone');
  } finally {
    child.kill('SIGKILL');
    const proc = browser.process();
    if (proc && !proc.killed) proc.kill('SIGKILL');
  }
}

main().then(() => {
  process.exit(0);
}, (err) => {
  console.error(err);
  process.exit(1);
});
