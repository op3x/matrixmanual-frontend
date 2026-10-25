// Checks privacy, terms, and support: axe, layout, footer links, and SMS opt-in.
// Uses the local mock. Does not call production.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const pages = ['index.html', 'upload.html', '404.html', 'privacy.html', 'terms.html', 'refunds.html', 'support.html'];
const CONSENT = 'I agree to receive text messages from ManualOS at this number: support replies, account alerts, and manual-status alerts. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.';

function read(name) {
  return readFile(path.join(root, name), 'utf8');
}

function footerOf(html) {
  const start = html.lastIndexOf('<footer');
  const end = html.lastIndexOf('</footer>');
  if (start === -1 || end === -1) return '';
  return html.slice(start, end);
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
    child.on('exit', (code) => {
      if (code) reject(new Error('mock exited ' + code + ' ' + buffer));
    });
  });
}

async function runAxe(page, label) {
  const hasAxe = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!hasAxe) await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const out = await axe.run(document, { resultTypes: ['violations'] });
    return out.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      help: item.help,
      nodes: item.nodes.slice(0, 8).map((node) => ({
        target: node.target.join(' '),
        html: node.html.slice(0, 180),
        failure: (node.failureSummary || '').slice(0, 300),
      })),
    }));
  });
  if (violations.length) {
    throw new Error(label + ' axe:\n' + JSON.stringify(violations, null, 2));
  }
  console.log('PASS axe 0 violations: ' + label);
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function main() {
  await mkdir(shotDir, { recursive: true });
  const html = {};
  for (const name of pages) html[name] = await read(name);
  const config = await read('_config.yml');
  if (!/exclude:[\s\S]*- dev\b/.test(config)) throw new Error('_config.yml does not exclude dev');
  if (await readFile(path.join(root, '.nojekyll')).then(() => true).catch(() => false)) {
    throw new Error('.nojekyll would publish dev/');
  }

  for (const name of pages) {
    const footer = footerOf(html[name]);
    for (const href of ['/support.html', '/privacy.html', '/terms.html', '/refunds.html']) {
      if (!footer.includes('href="' + href + '"')) throw new Error(name + ' footer missing ' + href);
    }
    if (/hello@manualos\.com/i.test(html[name])) throw new Error(name + ' still uses hello@');
  }

  const banned = ['Twilio', 'Stripe', 'Anthropic', 'Claude', 'OpenAI', 'Bandwidth', 'Vonage', 'Plivo', 'Telnyx', 'Formspree', 'Getform', 'Typeform', 'GitHub'];
  for (const name of ['privacy.html', 'terms.html', 'refunds.html', 'support.html']) {
    for (const word of banned) {
      if (html[name].includes(word)) throw new Error(name + ' contains ' + word);
    }
  }
  if (/\[LOG RETENTION\]/.test(html['privacy.html'])) throw new Error('privacy still has the log retention placeholder');
  if (!html['privacy.html'].includes('Hosting logs are kept for 30 days.') || !html['privacy.html'].includes('<strong>Hosting logs:</strong> 30 days.')) {
    throw new Error('privacy missing 30-day hosting logs');
  }
  for (const name of ['privacy.html', 'terms.html', 'refunds.html']) {
    const addressCount = (html[name].match(/\[\[OP3X_MAILING_ADDRESS\]\]/g) || []).length;
    const dateCount = (html[name].match(/\[\[EFFECTIVE_DATE\]\]/g) || []).length;
    const legalCount = (html[name].match(/\[\[OP3X_LEGAL_NAME\]\]/g) || []).length;
    if (addressCount !== 0) throw new Error(name + ' still has the mailing-address placeholder');
    if (dateCount !== 1) throw new Error(name + ' effective date placeholder count ' + dateCount);
    if (legalCount !== 0) throw new Error(name + ' still has the legal-name placeholder');
    if (!html[name].includes('Op3x LLC')) throw new Error(name + ' missing Op3x LLC');
    if (!html[name].includes('250 Trent Lane, Loves Park, IL 61111')) throw new Error(name + ' missing mailing address');
    if (/\[MAILING ADDRESS\]|\[EFFECTIVE DATE\]/.test(html[name])) throw new Error(name + ' still uses an old placeholder');
  }
  if (/\[\[REFUND_WINDOW\]\]/.test(Object.values(html).join('\n'))) throw new Error('refund window placeholder is still present');
  const sitemap = await read('sitemap.xml');
  if (!sitemap.includes('https://manualos.com/refunds.html')) throw new Error('sitemap missing refunds.html');
  if (/31-day|31 days|within 31 days/.test(Object.values(html).join('\n') + sitemap)) throw new Error('a page still states a 31-day refund window');
  if (/unused credits from the refunded purchase/.test(html['terms.html'] + html['refunds.html'])) throw new Error('old unused-credits refund bullet is still present');
  const refundRule = [
    'A purchase can be refunded until its first manual is delivered, within these limits:',
    '<strong>Starter:</strong> you can get a full refund within 30 days of purchase, as long as no manual from that purchase has been delivered.',
    '<strong>Pro:</strong> each monthly charge can be refunded until that billing period ends, as long as no manual has been delivered in that period. Ask before your plan renews.',
    "Once a manual is delivered, that purchase or charge can't be refunded, except where required by law.",
    'from the email address you used at checkout.',
    "A run that fails, or a file ManualOS can't read, doesn't use a credit.",
    "and we'll help.",
    'Your finished PDF is stored for up to 24 hours so you can download it, then deleted. Save your copy.',
  ];
  for (const phrase of refundRule) {
    if (!html['terms.html'].includes(phrase)) throw new Error('terms refund rule diverges: ' + phrase);
    if (!html['refunds.html'].includes(phrase)) throw new Error('refunds page missing: ' + phrase);
  }
  if (!html['terms.html'].includes('the credits and access from that purchase end.')) throw new Error('terms missing access-ends sentence');
  const chargeback = "access is suspended while a dispute is open, restored if it's decided in ManualOS's favor, and permanently revoked if ManualOS loses it.";
  if (!html['terms.html'].includes(chargeback)) throw new Error('terms missing chargeback rule');
  if (!html['refunds.html'].includes(chargeback)) throw new Error('refunds missing chargeback rule');
  if (/Integrator|at any hour|tel:/i.test(html['refunds.html'])) throw new Error('refunds page includes Integrator, a phone line, or after-hours wording');
  if (!html['refunds.html'].includes('<title>Refunds and cancellation | ManualOS</title>')) throw new Error('refunds title');
  if (!html['refunds.html'].includes('content="Refunds until your first manual is delivered (Starter within 30 days, Pro within the billing period), how to cancel Pro, and why a rejected file never uses a credit."')) throw new Error('refunds meta description');
  if (!html['refunds.html'].includes('href="https://manualos.com/refunds.html"')) throw new Error('refunds canonical');
  if (!html['refunds.html'].includes('Prices are in USD, plus applicable taxes.')) throw new Error('refunds missing price note');
  if (!html['terms.html'].includes('refunds until the first manual is delivered')) throw new Error('terms meta description still describes the old refund window');
  if (!html['terms.html'].includes('All prices are plus applicable taxes.')) throw new Error('terms missing tax note');
  if (!html['terms.html'].includes('each monthly charge can be refunded until that billing period ends, as long as no manual has been delivered in that period.')) throw new Error('terms missing Pro billing-period refund');
  for (const name of ['terms.html', 'privacy.html', 'refunds.html']) {
    if (/Integrator|\$249|\$2,490|white-label/i.test(html[name])) throw new Error(name + ' still mentions Integrator');
  }
  if (/\{\{LAUNCH_DATE\}\}/.test(Object.values(html).join('\n'))) throw new Error('a page still uses {{LAUNCH_DATE}}');
  const temp = 'Some file types are briefly written to temporary storage during conversion and deleted right after.';
  const kept = 'Uploaded files are processed and deleted when the job finishes; they are not kept.';
  if (!html['privacy.html'].includes(temp) || !html['privacy.html'].includes(kept)) throw new Error('privacy missing temporary-storage retention wording');
  if (!html['privacy.html'].includes('up to 24 hours')) throw new Error('privacy missing 24-hour PDF line');
  if (!html['support.html'].includes('backend PR #8')) throw new Error('support script missing backend PR #8 note');
  if (/team seats/i.test(html['terms.html'] + html['privacy.html'])) throw new Error('team seats were invented');
  if (/at any hour/.test(Object.values(html).join('\n'))) throw new Error('an at-any-hour line is still present');
  if (/within \d+ (hour|business day)|response time|we will respond|promptly|immediately/i.test(html['support.html'] + html['terms.html'] + html['refunds.html'])) {
    throw new Error('support, terms, or refunds promise a response time');
  }
  if (!/State of Illinois/.test(html['terms.html'])) throw new Error('terms missing Illinois law');
  const smsNeed = ['support replies', 'account alerts', 'manual-status alerts', 'Message frequency varies', 'Msg &amp; data rates may apply', 'Reply STOP to opt out', 'Reply HELP for help', 'support@manualos.com', 'Mobile numbers and SMS opt-in consent are not shared with or sold to third parties or affiliates for marketing'];
  for (const name of ['privacy.html', 'terms.html']) {
    for (const phrase of smsNeed) {
      if (!html[name].includes(phrase)) throw new Error(name + ' missing SMS phrase: ' + phrase);
    }
  }
  if (!html['support.html'].includes(CONSENT.replace('&', '&amp;'))) throw new Error('checkbox sentence missing');
  if (/id="sms-consent"[^>]*\schecked\b/.test(html['support.html'])) throw new Error('checkbox is checked in HTML');
  if (!html['support.html'].includes("var SUPPORT_PHONE_DISPLAY = '';")) throw new Error('phone constant missing or not empty');
  if (!html['support.html'].includes("var API_BASE = 'https://manualforge-backend-production.up.railway.app';")) throw new Error('API_BASE missing');
  if (!html['support.html'].includes("source: 'website-support-form'")) throw new Error('consent source missing');
  if (!html['support.html'].includes("API_BASE + '/api/support/sms-consent'")) throw new Error('consent URL missing');
  if (/formspree|getform|basin\.|typeform|google.com\/forms/i.test(html['support.html'])) throw new Error('third-party form service');
  await assertNoBrandNames(root);
  console.log('PASS static checks and brand names');

  const { child, base } = await startMock();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/favicon|Failed to load resource|net::ERR|mailto/i.test(text)) return;
      pageErrors.push(text);
    });
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('click', (event) => {
        const link = event.target && event.target.closest && event.target.closest('a[href^="mailto:"]');
        if (!link) return;
        event.preventDefault();
        window.__mailto = link.href;
      }, true);
    });

    for (const width of [390, 1280]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
      for (const name of ['support.html', 'privacy.html', 'terms.html', 'refunds.html', '404.html', 'index.html']) {
        await page.goto(base + '/' + name, { waitUntil: 'networkidle0' });
        const extra = await overflow(page);
        if (extra > 1) throw new Error(name + ' overflows by ' + extra + 'px at ' + width);
        await runAxe(page, name + ' ' + width);
      }
      await page.goto(base + '/upload.html', { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.body.dataset.phase && document.body.dataset.phase !== 'checking', { timeout: 8000 });
      const uploadExtra = await overflow(page);
      if (uploadExtra > 1) throw new Error('upload.html overflows by ' + uploadExtra + 'px at ' + width);
      await runAxe(page, 'upload.html ' + width);
    }

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.goto(base + '/support.html', { waitUntil: 'networkidle0' });
    const phoneState = await page.$eval('#support-phone-line', (el) => ({
      hidden: el.hidden,
      display: getComputedStyle(el).display,
      link: document.getElementById('support-phone-link').textContent.trim(),
      href: document.getElementById('support-phone-link').getAttribute('href'),
    }));
    if (!phoneState.hidden || phoneState.display !== 'none' || phoneState.link || phoneState.href) {
      throw new Error('support phone should be hidden until set ' + JSON.stringify(phoneState));
    }
    const checked = await page.$eval('#sms-consent', (el) => el.checked);
    if (checked) throw new Error('checkbox starts checked');
    const label = await page.$eval('label[for="sms-consent"]', (el) => el.textContent.trim());
    if (label !== CONSENT) throw new Error('checkbox label mismatch: ' + label);

    for (const name of ['support.html', 'privacy.html', 'terms.html', 'refunds.html']) {
      await page.goto(base + '/' + name, { waitUntil: 'networkidle0' });
      const stem = name.replace('.html', '');
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.screenshot({ path: path.join(shotDir, stem + '_390.png'), fullPage: true });
      await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
      await page.screenshot({ path: path.join(shotDir, stem + '_1280.png'), fullPage: true });
    }
    for (const width of [390, 1280]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1100, deviceScaleFactor: 1 });
      await page.goto(base + '/privacy.html#sms', { waitUntil: 'networkidle0' });
      const sms = await page.$('#sms');
      await sms.screenshot({ path: path.join(shotDir, 'privacy_sms_' + width + '.png') });
      const extra = await overflow(page);
      if (extra > 1) throw new Error('privacy sms overflows at ' + width);
    }

    async function consentCount() {
      const list = await fetch(base + '/__mock/requests').then((res) => res.json());
      return list.filter((item) => item.path === '/api/support/sms-consent');
    }

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.goto(base + '/support.html', { waitUntil: 'networkidle0' });
    await page.type('#support-name', 'Ada Lovelace');
    await page.type('#support-email', 'ada@example.com');
    await page.type('#support-message', 'The manual link stopped working.');
    await page.click('#sms-consent');
    await page.click('#support-submit');
    await page.waitForFunction(() => document.getElementById('form-error').textContent.includes('highlighted'));
    const early = await consentCount();
    if (early.length) throw new Error('consent posted before a phone number was entered');
    await runAxe(page, 'support validation errors');

    await page.type('#support-phone', '(217) 555-0199');
    const before = (await consentCount()).length;
    await page.click('#support-submit');
    await page.waitForFunction(() => !document.getElementById('form-status').hidden);
    const posted = (await consentCount()).slice(before);
    if (posted.length !== 1 || posted[0].status !== 200) throw new Error('consent response ' + JSON.stringify(posted));
    if (posted[0].phone !== '(217) 555-0199' || posted[0].consentTextVersion !== 'support-sms-v2' || posted[0].source !== 'website-support-form') {
      throw new Error('consent body ' + JSON.stringify(posted[0]));
    }
    if (posted[0].fields.join(',') !== 'phone,consentTextVersion,source') throw new Error('consent keys ' + posted[0].fields.join(','));
    const mailto = await page.$eval('#email-opener', (el) => el.getAttribute('href'));
    if (!mailto.startsWith('mailto:support@manualos.com?')) throw new Error('mailto target ' + mailto);
    const body = decodeURIComponent(mailto.split('body=')[1]);
    if (!body.includes('The manual link stopped working.') || !body.includes('Ada Lovelace') || !body.includes('Text opt-in: yes')) {
      throw new Error('mailto body ' + body);
    }
    await runAxe(page, 'support after opt-in');

    await page.goto(base + '/support.html', { waitUntil: 'networkidle0' });
    await page.type('#support-name', 'Grace Hopper');
    await page.type('#support-email', 'grace@example.com');
    await page.type('#support-message', 'Please cancel Pro.');
    const beforePlain = (await consentCount()).length;
    await page.click('#support-submit');
    await page.waitForFunction(() => !document.getElementById('form-status').hidden);
    const plain = (await consentCount()).slice(beforePlain);
    if (plain.length) throw new Error('unchecked form posted consent ' + JSON.stringify(plain));
    const plainMail = await page.$eval('#email-opener', (el) => decodeURIComponent(el.getAttribute('href')));
    if (!plainMail.includes('Please cancel Pro.') || plainMail.includes('Text opt-in: yes')) throw new Error('plain mailto ' + plainMail);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('/api/support/sms-consent')) {
        req.respond({ status: 500, contentType: 'application/json', body: '{"error":"no"}' });
        return;
      }
      req.continue();
    });
    await page.goto(base + '/support.html', { waitUntil: 'networkidle0' });
    await page.type('#support-name', 'Grace Hopper');
    await page.type('#support-email', 'grace@example.com');
    await page.type('#support-phone', '2175550199');
    await page.type('#support-message', 'Need the PDF again.');
    await page.click('#sms-consent');
    await page.click('#support-submit');
    await page.waitForFunction(() => document.getElementById('form-error').textContent.includes('opt-in'));
    const failedHidden = await page.$eval('#form-status', (el) => el.hidden);
    if (!failedHidden) throw new Error('email opened after a failed opt-in');
    await runAxe(page, 'support opt-in failure');

    if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));
    console.log('PASS support form, consent POST, and layouts');
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
