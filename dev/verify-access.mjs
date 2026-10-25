// Headless checks for post-checkout buyer access on upload.html.
// Covers the email link form, recent manuals, and Pro subscription management.
// Uses dev/mock-api.mjs. Does not call production.
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoBrandNames } from './check-brands.mjs';

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
const shotDir = process.env.SCREENSHOT_DIR || '/opt/cursor/artifacts/screenshots';
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const axePath = '/tmp/manualos-test/node_modules/axe-core/axe.min.js';
const SENT = /If that email has a purchase, we.ve sent the link\. Check your inbox and spam folder\./;
const LIMITED = 'Too many requests, try again in an hour.';
const PAST_DUE = /Your last payment didn.t go through\. Update your card to keep access\./;

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
    child.stderr.on('data', (chunk) => { buffer += chunk.toString(); });
    child.on('exit', (code) => {
      if (code) reject(new Error('mock exited ' + code + ' ' + buffer));
    });
  });
}

async function requests(base) {
  const res = await fetch(base + '/__mock/requests');
  return res.json();
}

async function shoot(page, name, scrollSelector) {
  for (const viewport of [
    { width: 1280, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    const handle = await page.$(scrollSelector);
    if (!handle) throw new Error(`${name} missing ${scrollSelector}`);
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`${name} at ${viewport.width}px overflows by ${overflow}px`);
    const file = path.join(shotDir, `${name}_${viewport.width}.png`);
    await page.screenshot({ path: file });
    const box = await handle.boundingBox();
    if (!box || box.width < 40 || box.height < 20) throw new Error(`${name} at ${viewport.width}px is not visible`);
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const inView = box.y < view.h && box.y + box.height > 0;
    if (!inView) throw new Error(`${name} at ${viewport.width}px is outside the viewport`);
  }
  await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
}

async function runAxe(page, label) {
  const hasAxe = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!hasAxe) await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const out = await axe.run(document, { resultTypes: ['violations'] });
    return out.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      nodes: item.nodes.slice(0, 5).map((node) => node.target.join(' ')),
    }));
  });
  if (violations.length) throw new Error(label + ' axe: ' + JSON.stringify(violations));
  console.log('PASS axe 0 violations: ' + label);
}

async function visibleManageCount(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('button')].filter((el) => {
      if (!/Manage subscription/.test(el.textContent || '')) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (el.hidden || el.closest('[hidden]')) return false;
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 2;
    }).length;
  });
}

async function openFresh(page, base, query) {
  await page.goto(base + '/upload.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(base + '/upload.html' + (query || ''), { waitUntil: 'domcontentloaded', timeout: 20000 });
}

async function main() {
  await mkdir(shotDir, { recursive: true });
  const index = await readFile(path.join(root, 'index.html'), 'utf8');
  const refunds = await readFile(path.join(root, 'refunds.html'), 'utf8');
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const upload = await readFile(path.join(root, 'upload.html'), 'utf8');
  if (!upload.includes('<meta name="referrer" content="no-referrer">')) throw new Error('upload page missing no-referrer');
  const phrase = 'or use Manage subscription on your upload page';
  const indexHits = index.split(phrase).length - 1;
  if (indexHits < 2) throw new Error('pricing/FAQ missing Manage subscription phrase, count ' + indexHits);
  if (!refunds.includes('from the email address you used at checkout, ' + phrase + '.')) {
    throw new Error('refunds cancel section missing the manage phrase');
  }
  if (/not on production yet|isn.t on production|not deployed on production/i.test(readme)) {
    throw new Error('README still says /jobs is not on production');
  }
  if (!readme.includes('Production serves `/jobs`.')) throw new Error('README missing the production /jobs line');
  await assertNoBrandNames(root);
  console.log('PASS static copy and brand names');

  const { child, base } = await startMock();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    for (const [pathName, label] of [
      ['/jobs?mine', 'mine'],
      ['/jobs/job_recent_starter', 'job'],
      ['/jobs/job_recent_starter/pdf', 'pdf'],
    ]) {
      const res = await fetch(base + pathName);
      if (res.status !== 401) throw new Error(label + ' without X-Session-Id returned ' + res.status);
    }
    console.log('PASS job routes reject a missing X-Session-Id');
    const mineRes = await fetch(base + '/jobs?mine', { headers: { 'X-Session-Id': 'cs_test_local' } });
    const mineBody = await mineRes.json();
    if (!mineBody || !Array.isArray(mineBody.jobs)) throw new Error('mine shape ' + JSON.stringify(mineBody));
    const readyJob = mineBody.jobs.find((job) => job.id === 'job_recent_starter');
    if (!readyJob || readyJob.pdf_available !== true || readyJob.filename !== 'packer-line.L5X') {
      throw new Error('mine job ' + JSON.stringify(mineBody));
    }
    console.log('PASS /jobs?mine returns {jobs:[...]}');

    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/favicon|Failed to load resource|net::ERR/i.test(text)) return;
      pageErrors.push(text);
    });
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });

    await openFresh(page, base, '');
    await page.waitForFunction(() => {
      return document.body.dataset.phase === 'locked'
        && document.documentElement.classList.contains('needs-access-link')
        && getComputedStyle(document.getElementById('access-recovery')).display !== 'none';
    }, { timeout: 8000 });
    const recovery = await page.evaluate(() => ({
      title: document.getElementById('access-recovery-title').textContent,
      note: document.querySelector('#access-recovery .recovery-note').textContent,
      button: document.getElementById('access-link-btn').textContent,
      welcome: document.getElementById('payment-welcome-text').textContent,
      manage: document.getElementById('manage-subscription').hidden,
      recent: document.getElementById('buyer-access').hidden,
    }));
    if (recovery.title !== 'Email me my upload link' || recovery.button !== 'Email me my upload link') {
      throw new Error('recovery labels ' + JSON.stringify(recovery));
    }
    if (!/purchase email/.test(recovery.note)) throw new Error('purchase email note missing ' + recovery.note);
    if (!/No purchase found/.test(recovery.welcome)) throw new Error('welcome ' + recovery.welcome);
    if (!recovery.manage || !recovery.recent) throw new Error('locked page showed buyer tools ' + JSON.stringify(recovery));
    await runAxe(page, 'no session 1280');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await runAxe(page, 'no session 390');
    await shoot(page, 'access_link', '#access-recovery');
    console.log('PASS no-purchase page shows the email link form');

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.type('#access-email', 'buyer@example.com');
    await page.click('#access-link-btn');
    await page.waitForFunction((pattern) => {
      const el = document.getElementById('access-link-status');
      return el && !el.hidden && new RegExp(pattern).test(el.textContent);
    }, { timeout: 8000 }, SENT.source);
    const sentLog = (await requests(base)).filter((entry) => entry.path === '/access-link' && entry.email === 'buyer@example.com');
    if (sentLog.length !== 1 || sentLog[0].status !== 202) throw new Error('access-link 202 ' + JSON.stringify(sentLog));
    await shoot(page, 'access_link_sent', '#access-recovery');
    console.log('PASS email link form accepts 202 without confirming a purchase');

    await page.$eval('#access-email', (el) => { el.value = ''; });
    await page.type('#access-email', 'limited@example.com');
    await page.click('#access-link-btn');
    await page.waitForFunction((expected) => {
      const el = document.getElementById('access-link-status');
      return el && !el.hidden && el.textContent === expected;
    }, { timeout: 8000 }, LIMITED);
    const limitedLog = (await requests(base)).filter((entry) => entry.path === '/access-link' && entry.email === 'limited@example.com');
    if (limitedLog.length !== 1 || limitedLog[0].status !== 429) throw new Error('access-link 429 ' + JSON.stringify(limitedLog));
    if (SENT.test(await page.$eval('#access-link-status', (el) => el.textContent))) {
      throw new Error('429 showed the success sentence');
    }
    await shoot(page, 'access_link_limited', '#access-recovery');
    console.log('PASS email link form shows the hourly limit');

    await page.$eval('#access-email', (el) => { el.value = ''; });
    await page.type('#access-email', 'fail@example.com');
    await page.click('#access-link-btn');
    await page.waitForFunction(() => {
      const el = document.getElementById('access-link-status');
      return el && !el.hidden && /couldn.t send the link/i.test(el.textContent);
    }, { timeout: 8000 });
    const failText = await page.$eval('#access-link-status', (el) => el.textContent);
    if (SENT.test(failText) || failText === LIMITED) throw new Error('error copy ' + failText);
    console.log('PASS email link form explains a send failure');

    async function expectNoMailClaim(email, label) {
      await openFresh(page, base, '');
      await page.waitForFunction(() => document.body.dataset.phase === 'locked', { timeout: 8000 });
      await page.type('#access-email', email);
      await page.click('#access-link-btn');
      await page.waitForFunction(() => {
        const note = document.querySelector('#access-recovery .recovery-note');
        const form = document.getElementById('access-link-form');
        return form && form.hidden && note && /support@manualos\.com/.test(note.textContent) && /can.t email the upload link/i.test(note.textContent);
      }, { timeout: 8000 });
      const claim = await page.evaluate(() => document.body.innerText);
      if (SENT.test(claim)) throw new Error(label + ' claimed a link was sent');
      console.log('PASS ' + label);
    }
    await expectNoMailClaim('unconfigured@example.com', 'a 503 hides the email form and points to support');
    await expectNoMailClaim('nomail@example.com', 'email_configured false does not claim a link was sent');

    await openFresh(page, base, '?session_id=cs_test_invalid');
    await page.waitForFunction(() => document.body.dataset.phase === 'locked', { timeout: 8000 });
    const invalidRecovery = await page.evaluate(() => getComputedStyle(document.getElementById('access-recovery')).display);
    if (invalidRecovery !== 'none') throw new Error('invalid session showed the email form');
    console.log('PASS an inactive purchase does not show the email form');

    await openFresh(page, base, '?session_id=cs_test_local');
    await page.waitForFunction(() => {
      return document.body.dataset.phase === 'ready'
        && document.querySelectorAll('#recent-list li').length >= 2;
    }, { timeout: 8000 });
    const starter = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#recent-list li')].map((li) => ({
        text: li.innerText,
        download: (li.querySelector('[data-download]') || {}).getAttribute ? li.querySelector('[data-download]').getAttribute('data-download') : '',
      }));
      return {
        stored: localStorage.getItem('manualos_session_id'),
        rows,
        inputDisabled: document.getElementById('file-input').disabled,
        issue: !document.getElementById('payment-issue').hidden,
      };
    });
    if (starter.stored !== 'cs_test_local') throw new Error('stored session ' + starter.stored);
    if (starter.issue) throw new Error('starter showed the past-due banner');
    if (starter.inputDisabled) throw new Error('starter upload stayed disabled');
    if (await visibleManageCount(page) !== 0) throw new Error('starter showed Manage subscription');
    const rowText = starter.rows.map((row) => row.text).join('\n');
    if (!rowText.includes('packer-line.L5X') || !rowText.includes('labeler.st') || rowText.includes('archive-old.L5X')) {
      throw new Error('starter rows ' + JSON.stringify(starter.rows));
    }
    const ready = starter.rows.find((row) => row.text.includes('packer-line.L5X'));
    const waiting = starter.rows.find((row) => row.text.includes('labeler.st'));
    if (!ready || ready.download !== 'job_recent_starter') throw new Error('ready row ' + JSON.stringify(ready));
    if (!waiting || waiting.download) throw new Error('in-progress row offered a download ' + JSON.stringify(waiting));
    if (starter.rows[0].text.indexOf('packer-line.L5X') === -1) throw new Error('newest manual was not first');
    const mine = (await requests(base)).filter((entry) => entry.path === '/jobs?mine' && entry.session === 'cs_test_local');
    if (!mine.length || mine.some((entry) => entry.status !== 200)) throw new Error('mine log ' + JSON.stringify(mine));
    await runAxe(page, 'starter recent 1280');
    await shoot(page, 'recent_starter', '#recent-manuals');
    console.log('PASS starter lists the last 24 hours and hides Manage subscription');

    await page.evaluate(() => {
      window.__saved = [];
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = origCreate(blob);
        window.__saved.push({ url, type: blob.type, size: blob.size });
        return url;
      };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute('download')) {
          window.__anchor = { name: this.getAttribute('download'), href: this.href };
          return;
        }
        return origClick.apply(this, arguments);
      };
    });
    await page.click('#recent-list button[data-download="job_recent_starter"]');
    await page.waitForFunction(() => window.__anchor && window.__anchor.href, { timeout: 8000 });
    const saved = await page.evaluate(async () => {
      const res = await fetch(window.__anchor.href);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        name: window.__anchor.name,
        type: window.__saved[0] && window.__saved[0].type,
        head: new TextDecoder().decode(bytes.slice(0, 5)),
      };
    });
    if (saved.name !== 'packer-line-manual.pdf' || saved.type !== 'application/pdf' || saved.head !== '%PDF-') {
      throw new Error('blob download ' + JSON.stringify(saved));
    }
    const pdfLog = (await requests(base)).filter((entry) => entry.path === '/jobs/job_recent_starter/pdf' && entry.status === 200);
    if (pdfLog.length !== 1 || pdfLog[0].session !== 'cs_test_local') {
      throw new Error('pdf log ' + JSON.stringify(pdfLog));
    }
    console.log('PASS recent download fetches the PDF with X-Session-Id and saves a blob');

    await openFresh(page, base, '?session_id=cs_test_pro');
    await page.waitForFunction(() => {
      const button = document.getElementById('manage-subscription');
      const banner = document.getElementById('payment-issue');
      return document.body.dataset.phase === 'ready'
        && button
        && !button.hidden
        && banner.hidden
        && !banner.contains(button)
        && document.querySelector('#recent-list [data-download="job_recent_pro"]');
    }, { timeout: 8000 });
    if (await visibleManageCount(page) !== 1) throw new Error('pro manage count');
    const proStored = await page.evaluate(() => localStorage.getItem('manualos_session_id'));
    if (proStored !== 'cs_test_pro') throw new Error('pro stored ' + proStored);
    await runAxe(page, 'pro manage 1280');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await runAxe(page, 'pro manage 390');
    await shoot(page, 'manage_pro', '#buyer-access');
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }),
      page.click('#manage-subscription'),
    ]);
    if (!page.url().endsWith('/__mock/portal')) throw new Error('portal url ' + page.url());
    const portalText = await page.evaluate(() => document.body.innerText);
    if (!/Subscription management/.test(portalText)) throw new Error('portal body ' + portalText);
    const portalLog = (await requests(base)).filter((entry) => entry.path === '/billing-portal' && entry.session === 'cs_test_pro');
    if (portalLog.length !== 1 || portalLog[0].status !== 200 || portalLog[0].fields.join(',') !== 'session_id') {
      throw new Error('billing log ' + JSON.stringify(portalLog));
    }
    console.log('PASS Pro Manage subscription opens the billing portal');

    await openFresh(page, base, '?session_id=cs_test_past_due');
    await page.waitForFunction(() => {
      const banner = document.getElementById('payment-issue');
      const button = document.getElementById('manage-subscription');
      return document.body.dataset.phase === 'ready' && banner && !banner.hidden && button && banner.contains(button);
    }, { timeout: 8000 });
    const pastDue = await page.evaluate(() => ({
      text: document.getElementById('payment-issue').innerText,
      enabled: !document.getElementById('file-input').disabled,
      plan: document.getElementById('access-message').textContent,
    }));
    if (!PAST_DUE.test(pastDue.text) || !/Manage subscription/.test(pastDue.text)) {
      throw new Error('past-due banner ' + pastDue.text);
    }
    if (!pastDue.enabled || !/Pro plan/.test(pastDue.plan)) throw new Error('past-due access ' + JSON.stringify(pastDue));
    if (await visibleManageCount(page) !== 1) throw new Error('past-due manage count');
    await runAxe(page, 'past due 1280');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await runAxe(page, 'past due 390');
    await shoot(page, 'payment_issue', '#payment-issue');
    console.log('PASS a failed renewal shows the past-due banner and Manage subscription');

    await openFresh(page, base, '?session_id=cs_test_empty');
    await page.waitForFunction(() => document.body.dataset.phase === 'locked', { timeout: 8000 });
    if (await visibleManageCount(page) !== 0) throw new Error('used-up starter showed Manage subscription');
    const emptyRecent = await page.evaluate(() => document.getElementById('buyer-access').hidden);
    if (emptyRecent) throw new Error('used-up starter hid recent manuals');
    console.log('PASS a used-up Starter plan still hides Manage subscription');

    await openFresh(page, base, '?session_id=cs_test_local&jobs=0');
    await page.waitForFunction(() => document.body.dataset.phase === 'ready', { timeout: 8000 });
    const stripped = new URL(page.url());
    if (stripped.searchParams.has('session_id')) throw new Error('session id stayed in the address bar ' + page.url());
    if (stripped.searchParams.get('jobs') !== '0') throw new Error('other query was dropped ' + page.url());
    const kept = await page.evaluate(() => localStorage.getItem('manualos_session_id'));
    if (kept !== 'cs_test_local') throw new Error('session was not kept after stripping the url ' + kept);
    console.log('PASS session id leaves the address bar and stays in browser storage');

    async function expectPortalLock(sessionId, pattern, shotName) {
      await openFresh(page, base, '?session_id=' + sessionId);
      await page.waitForFunction(() => {
        const banner = document.getElementById('payment-issue');
        const button = document.getElementById('manage-subscription');
        return document.body.dataset.phase === 'locked' && banner && !banner.hidden && button && banner.contains(button);
      }, { timeout: 8000 });
      const state = await page.evaluate(() => {
        const pricing = document.getElementById('access-pricing-link');
        const pricingStyle = getComputedStyle(pricing);
        return {
          text: document.body.innerText,
          banner: document.getElementById('payment-issue').innerText,
          inputDisabled: document.getElementById('file-input').disabled,
          generateDisabled: document.getElementById('generate-btn').disabled,
          pricingVisible: !pricing.hidden && pricingStyle.display !== 'none' && pricingStyle.visibility !== 'hidden' && pricing.getBoundingClientRect().height > 2,
          stored: localStorage.getItem('manualos_session_id'),
        };
      });
      if (!pattern.test(state.banner)) throw new Error(sessionId + ' banner ' + state.banner);
      if (!/Manage subscription/.test(state.banner)) throw new Error(sessionId + ' missing manage button');
      if (/Choose a plan/.test(state.text) || state.pricingVisible) throw new Error(sessionId + ' pushed a new purchase ' + JSON.stringify(state));
      if (!state.inputDisabled || !state.generateDisabled) throw new Error(sessionId + ' left upload enabled');
      if (state.stored !== sessionId) throw new Error(sessionId + ' storage ' + state.stored);
      if (await visibleManageCount(page) !== 1) throw new Error(sessionId + ' manage count');
      await runAxe(page, shotName + ' 1280');
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await runAxe(page, shotName + ' 390');
      await shoot(page, shotName, '#payment-issue');
      console.log('PASS ' + shotName + ' keeps Manage subscription and disables upload');
    }
    await expectPortalLock('cs_test_payment_failed', /Your last payment didn.t go through\. Update your card to keep generating manuals\./, 'payment_failed');
    await expectPortalLock('cs_test_canceled', /Your subscription has ended\. Restart it from Manage subscription\./, 'canceled');

    if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));
    console.log('PASS no page errors');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
