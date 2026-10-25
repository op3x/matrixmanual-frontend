// Checks first-party campaign tags and the checkout POST.
// Uses the local mock. The checkout request is intercepted and is not sent.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_NAMES } from './check-brands.mjs';

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
const pages = ['index.html', 'upload.html', '404.html', 'privacy.html', 'terms.html', 'refunds.html', 'support.html'];
const PRIVACY_LINE = 'If you arrive from a link with campaign tags, we store those tags in your browser and attach them to your checkout so we know which ad or post brought you; no third-party analytics or tracking cookies are used.';
const DAY = 24 * 60 * 60 * 1000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isIso(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

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
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code) reject(new Error('mock exited ' + code + ' ' + buffer));
    });
  });
}

async function readAttr(page) {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('mos_attr');
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return { thrown: String(err) };
    }
  });
}

async function arm(page) {
  const hits = [];
  const external = [];
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('request', (req) => {
    try {
      const host = new URL(req.url()).hostname;
      if (host && host !== '127.0.0.1' && host !== 'localhost') external.push(req.url());
    } catch (err) { /* ignore unparseable urls */ }
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/create-checkout-session')) {
      let body = null;
      try { body = JSON.parse(req.postData() || ''); } catch { body = null; }
      hits.push({ url: req.url(), body });
      req.respond({ status: 500, contentType: 'application/json', body: '{"error":"intercepted"}' });
      return;
    }
    req.continue();
  });
  return { hits, external, pageErrors };
}

async function clickPlan(page, hits, plan) {
  const before = hits.length;
  const selector = '[data-checkout="' + plan + '"]';
  await page.waitForSelector(selector, { visible: true, timeout: 8000 });
  await page.$eval(selector, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(selector);
  const start = Date.now();
  while (hits.length <= before) {
    if (Date.now() - start > 8000) throw new Error('no checkout request for ' + plan);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await page.waitForFunction(() => /couldn/.test(document.getElementById('checkout-error').textContent), { timeout: 8000 });
  return hits[hits.length - 1];
}

function assertPrimary(attribution) {
  assert(attribution && typeof attribution === 'object' && !Array.isArray(attribution), 'attribution missing');
  assert(attribution.utm_source === 'test', 'utm_source ' + JSON.stringify(attribution));
  assert(attribution.utm_campaign === 'x', 'utm_campaign ' + JSON.stringify(attribution));
  assert(attribution.landing_path === '/', 'landing_path ' + attribution.landing_path);
  assert(!attribution.landing_path.includes('?'), 'landing path includes a query');
  assert(attribution.referrer_host === 'news.example', 'referrer_host ' + attribution.referrer_host);
  assert(isIso(attribution.first_seen_at), 'first_seen_at ' + attribution.first_seen_at);
  assert(Math.abs(Date.now() - Date.parse(attribution.first_seen_at)) < 60000, 'first_seen_at is not from this visit');
  for (const key of ['utm_medium', 'utm_term', 'utm_content', 'gclid', 'msclkid', 'latest']) {
    assert(!(key in attribution), 'unexpected ' + key);
  }
  const packed = JSON.stringify(attribution);
  assert(!packed.includes('story') && !packed.includes('https://'), 'referrer url leaked ' + packed);
}

async function staticChecks() {
  const attr = await readFile(path.join(root, 'assets/attribution.js'), 'utf8');
  if (/document\.cookie|sendBeacon|XMLHttpRequest|\bfetch\s*\(|gtag|googletagmanager|google-analytics/i.test(attr)) {
    throw new Error('attribution script sets a cookie or makes a request');
  }
  if (!attr.includes("var KEY = 'mos_attr';")) throw new Error('storage key is not mos_attr');
  for (const name of BRAND_NAMES) {
    if (attr.toLowerCase().includes(name.toLowerCase())) throw new Error('attribution.js names ' + name);
  }
  for (const name of pages) {
    const html = await readFile(path.join(root, name), 'utf8');
    if (!html.includes('src="/assets/attribution.js"')) throw new Error(name + ' missing attribution script');
  }
  const privacy = await readFile(path.join(root, 'privacy.html'), 'utf8');
  const collectStart = privacy.indexOf('What we collect');
  const collectEnd = privacy.indexOf('How your files are processed');
  if (collectStart === -1 || collectEnd === -1 || collectEnd < collectStart) throw new Error('privacy collect section missing');
  if (!privacy.slice(collectStart, collectEnd).includes(PRIVACY_LINE)) throw new Error('privacy collect section missing the campaign line');
  console.log('PASS attribution script, page hooks, and privacy line');
}

async function main() {
  await staticChecks();
  const { child, base } = await startMock();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    const { hits, external, pageErrors } = await arm(page);

    await page.goto(base + '/?utm_source=test&utm_campaign=x', {
      waitUntil: 'domcontentloaded',
      referer: 'https://news.example/story?id=9',
    });
    const ready = await page.evaluate(() => typeof window.mosReadAttribution === 'function');
    assert(ready, 'mosReadAttribution is not installed');
    const stored = await readAttr(page);
    assertPrimary(stored);
    const cookies = await page.cookies();
    assert(cookies.length === 0, 'cookies were set ' + JSON.stringify(cookies));
    const docCookie = await page.evaluate(() => document.cookie);
    assert(docCookie === '', 'document.cookie is ' + docCookie);

    const starter = await clickPlan(page, hits, 'starter');
    assert(starter.url.includes('/create-checkout-session'), 'checkout url ' + starter.url);
    assert(starter.body && starter.body.plan === 'starter', 'starter plan ' + JSON.stringify(starter.body));
    assert(Object.keys(starter.body).sort().join(',') === 'attribution,plan', 'starter keys ' + Object.keys(starter.body).join(','));
    assertPrimary(starter.body.attribution);
    assert(JSON.stringify(starter.body.attribution) === JSON.stringify(stored), 'posted attribution differs from storage');
    console.log('PASS checkout body includes attribution for utm_source=test&utm_campaign=x');

    const pro = await clickPlan(page, hits, 'pro');
    assert(pro.body && pro.body.plan === 'pro', 'pro plan ' + JSON.stringify(pro.body));
    assert(JSON.stringify(pro.body.attribution) === JSON.stringify(stored), 'pro attribution changed');
    console.log('PASS Pro checkout sends the same attribution');

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const kept = await readAttr(page);
    assert(JSON.stringify(kept) === JSON.stringify(stored), 'a URL without campaign tags overwrote the record');
    const again = await clickPlan(page, hits, 'starter');
    assert(JSON.stringify(again.body.attribution) === JSON.stringify(stored), 'checkout dropped the stored attribution');
    console.log('PASS first touch survives a later visit with no campaign tags');

    await page.goto(base + '/?gclid=later-click&msclkid=later-ms', { waitUntil: 'domcontentloaded' });
    const clickOnly = await readAttr(page);
    assert(JSON.stringify(clickOnly) === JSON.stringify(stored), 'a click id without utm params overwrote the record');
    console.log('PASS a click id alone does not replace the first touch');

    await page.goto(base + '/upload.html?utm_source=second&utm_medium=email&utm_campaign=later', {
      waitUntil: 'domcontentloaded',
      referer: 'https://mail.example/inbox',
    });
    const both = await readAttr(page);
    assert(both.utm_source === 'test' && both.utm_campaign === 'x', 'first touch params changed');
    assert(both.landing_path === '/' && both.referrer_host === 'news.example', 'first touch path or referrer changed');
    assert(both.first_seen_at === stored.first_seen_at, 'first_seen_at changed');
    assert(both.latest && both.latest.utm_source === 'second', 'latest source ' + JSON.stringify(both.latest));
    assert(both.latest.utm_medium === 'email' && both.latest.utm_campaign === 'later', 'latest campaign ' + JSON.stringify(both.latest));
    assert(both.latest.landing_path === '/upload.html', 'latest path ' + both.latest.landing_path);
    assert(both.latest.referrer_host === 'mail.example', 'latest referrer ' + both.latest.referrer_host);
    assert(isIso(both.latest.first_seen_at), 'latest timestamp ' + both.latest.first_seen_at);
    assert(!('gclid' in both.latest), 'latest picked up an old click id');
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const posted = await clickPlan(page, hits, 'starter');
    assert(JSON.stringify(posted.body.attribution) === JSON.stringify(both), 'checkout did not send first and latest');
    console.log('PASS a new utm visit keeps the first touch and stores latest');

    await page.evaluate(() => localStorage.clear());
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const absent = await readAttr(page);
    assert(absent === null, 'organic visit created a record ' + JSON.stringify(absent));
    const plain = await clickPlan(page, hits, 'pro');
    assert(plain.body && plain.body.plan === 'pro', 'plain plan ' + JSON.stringify(plain.body));
    assert(!('attribution' in plain.body), 'missing record still sent attribution ' + JSON.stringify(plain.body));
    assert(Object.keys(plain.body).join(',') === 'plan', 'plain keys ' + Object.keys(plain.body).join(','));
    console.log('PASS a missing record omits attribution');

    const long = 'n'.repeat(140);
    await page.goto(base + '/privacy.html?utm_source=' + encodeURIComponent(long) + '&utm_term=' + encodeURIComponent('  pad  ') + '&utm_campaign=cap', {
      waitUntil: 'domcontentloaded',
      referer: base + '/',
    });
    const capped = await readAttr(page);
    assert(capped.utm_source === 'n'.repeat(100), 'cap length ' + (capped.utm_source || '').length);
    assert(capped.utm_term === 'pad', 'term was not trimmed: ' + JSON.stringify(capped.utm_term));
    assert(capped.landing_path === '/privacy.html', 'privacy path ' + capped.landing_path);
    assert(!('referrer_host' in capped), 'same-site referrer stored ' + capped.referrer_host);
    assert(!('latest' in capped), 'capped visit should be a new first touch');
    console.log('PASS values are capped at 100 characters and an internal referrer is dropped');

    await page.evaluate((age) => {
      const data = JSON.parse(localStorage.getItem('mos_attr'));
      data.first_seen_at = new Date(Date.now() - age).toISOString();
      localStorage.setItem('mos_attr', JSON.stringify(data));
    }, 90 * DAY + 1000);
    await page.goto(base + '/terms.html', { waitUntil: 'domcontentloaded' });
    const expired = await readAttr(page);
    assert(expired === null, 'expired record was kept ' + JSON.stringify(expired));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const afterExpiry = await clickPlan(page, hits, 'starter');
    assert(!('attribution' in afterExpiry.body), 'expired record was sent');
    console.log('PASS attribution expires after 90 days');

    await page.goto(base + '/?utm_source=fresh&utm_campaign=new', { waitUntil: 'domcontentloaded' });
    await page.evaluate((age) => {
      const data = JSON.parse(localStorage.getItem('mos_attr'));
      data.first_seen_at = new Date(Date.now() - age).toISOString();
      localStorage.setItem('mos_attr', JSON.stringify(data));
    }, 89 * DAY);
    await page.goto(base + '/refunds.html', { waitUntil: 'domcontentloaded' });
    const still = await readAttr(page);
    assert(still && still.utm_source === 'fresh', 'record inside 90 days was dropped');
    console.log('PASS a record inside 90 days is kept');

    await page.evaluate(() => localStorage.clear());
    await page.goto(base + '/?utm_source=%20%20', { waitUntil: 'domcontentloaded' });
    assert(await readAttr(page) === null, 'blank campaign tag created a record');
    await page.goto(base + '/404.html?utm_content=banner&msclkid=ms-404', { waitUntil: 'domcontentloaded' });
    const from404 = await readAttr(page);
    assert(from404.landing_path === '/404.html', '404 path ' + from404.landing_path);
    assert(from404.utm_content === 'banner' && from404.msclkid === 'ms-404', '404 tags ' + JSON.stringify(from404));
    console.log('PASS blank tags are ignored and other pages capture tags');

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.mosReadAttribution = null; });
    const broken = await clickPlan(page, hits, 'starter');
    assert(broken.body.plan === 'starter' && !('attribution' in broken.body), 'a missing reader broke checkout ' + JSON.stringify(broken.body));
    console.log('PASS checkout still posts when the reader is missing');

    const stray = external.filter((url) => !url.includes('/create-checkout-session'));
    assert(!stray.length, 'unexpected external requests: ' + stray.join(', '));
    assert(!pageErrors.length, 'page errors: ' + pageErrors.join(' | '));
    console.log('PASS no cookies and no third-party requests');

    const blocked = await browser.newPage();
    const blockedErrors = [];
    blocked.on('pageerror', (err) => blockedErrors.push(String(err)));
    await blocked.evaluateOnNewDocument(() => {
      const thrower = function () { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.getItem = thrower;
      Storage.prototype.setItem = thrower;
      Storage.prototype.removeItem = thrower;
    });
    const blockedHits = [];
    await blocked.setRequestInterception(true);
    blocked.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/create-checkout-session')) {
        let body = null;
        try { body = JSON.parse(req.postData() || ''); } catch { body = null; }
        blockedHits.push({ url: req.url(), body });
        req.respond({ status: 500, contentType: 'application/json', body: '{"error":"intercepted"}' });
        return;
      }
      req.continue();
    });
    await blocked.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await blocked.goto(base + '/?utm_source=test&utm_campaign=x', { waitUntil: 'domcontentloaded' });
    const blockedHit = await clickPlan(blocked, blockedHits, 'starter');
    assert(blockedHit.body && blockedHit.body.plan === 'starter', 'blocked plan ' + JSON.stringify(blockedHit.body));
    assert(!('attribution' in blockedHit.body), 'blocked storage sent attribution');
    assert(!blockedErrors.length, 'blocked storage broke the page: ' + blockedErrors.join(' | '));
    console.log('PASS blocked storage does not break the page or checkout');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
