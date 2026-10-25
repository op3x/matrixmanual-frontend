// Checks privacy, terms, support, and cancel: axe, layout, footer links, and email cancel.
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
const pages = ['index.html', 'upload.html', '404.html', 'privacy.html', 'terms.html', 'refunds.html', 'support.html', 'cancel/index.html'];
const CREDIT_LINE = "If a run fails with an error, we give the credit back; if anything goes wrong on our side, email support and we'll restore it.";

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
  for (const name of ['privacy.html', 'terms.html', 'refunds.html', 'support.html', 'cancel/index.html']) {
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
    if (dateCount !== 0) throw new Error(name + ' still has the effective-date token (' + dateCount + ')');
    if (!html[name].includes('data-effective-date') || !html[name].includes('src="/effective-date.js"')) {
      throw new Error(name + ' does not take its effective date from effective-date.js');
    }
    if (legalCount !== 0) throw new Error(name + ' still has the legal-name placeholder');
    if (!html[name].includes('Op3x LLC')) throw new Error(name + ' missing Op3x LLC');
    if (/\[MAILING ADDRESS\]|\[EFFECTIVE DATE\]/.test(html[name])) throw new Error(name + ' still uses an old placeholder');
    if (/data-mailing-address|mailing address/i.test(html[name])) throw new Error(name + ' still shows a mailing address');
  }
  const retiredStreet = '250 ' + String.fromCharCode(84, 114, 101, 110, 116);
  const retiredZip = String.fromCharCode(54, 49, 49, 49, 49);
  for (const name of pages) {
    if (html[name].includes('[OP3X MAILING ADDRESS]') || html[name].includes(retiredStreet) || html[name].includes(retiredZip) || /mailing address/i.test(html[name])) {
      throw new Error(name + ' still contains a mailing-address placeholder or a retired street address');
    }
    if (/\bby mail\b/i.test(html[name])) throw new Error(name + ' still gives a postal instruction');
    const structured = html[name].match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [];
    for (const block of structured) {
      if (/PostalAddress|"address"\s*:/.test(block)) throw new Error(name + ' JSON-LD has an address field');
    }
  }
  const notices = "Notices to us: email <a href=\"mailto:support@manualos.com\">support@manualos.com</a> with 'Legal notice' in the subject line. Notices to you: we'll email the address on your account or post them on the site. Notices are effective when sent.";
  if (!html['terms.html'].includes(notices)) throw new Error('terms notices text missing');
  if (!html['terms.html'].includes('Email: <a href="mailto:support@manualos.com">support@manualos.com</a>. <a href="/support.html">Support form</a>.')) throw new Error('terms contact line changed');
  const privacyContact = 'Questions, privacy requests or complaints: email <a href="mailto:support@manualos.com">support@manualos.com</a> or use our <a href="/support.html">support form</a>.';
  if (!html['privacy.html'].includes(privacyContact)) throw new Error('privacy contact line missing');
  if (!html['privacy.html'].includes('Our privacy contact is the Privacy Officer, Op3x LLC.')) throw new Error('privacy officer line missing');
  if (!html['refunds.html'].includes('Email: <a href="mailto:support@manualos.com">support@manualos.com</a>.')) throw new Error('refunds contact line changed');
  if (/\[\[REFUND_WINDOW\]\]/.test(Object.values(html).join('\n'))) throw new Error('refund window placeholder is still present');
  const sitemap = await read('sitemap.xml');
  if (!sitemap.includes('https://manualos.com/refunds.html')) throw new Error('sitemap missing refunds.html');
  if (/31-day|31 days|within 31 days/.test(Object.values(html).join('\n') + sitemap)) throw new Error('a page still states a 31-day refund window');
  if (/unused credits from the refunded purchase/.test(html['terms.html'] + html['refunds.html'])) throw new Error('old unused-credits refund bullet is still present');
  const refundRule = [
    "A purchase, or a subscription's charge for a billing period, can be refunded within these limits:",
    '<strong>Starter:</strong> you can get a full refund within 30 days of purchase, as long as no manual from that purchase has been delivered.',
    '<strong>Pro:</strong> each monthly charge can be refunded until that billing period ends, as long as no manual has been delivered in that period. Ask before your plan renews.',
    "Once a manual is delivered, that purchase or charge can't be refunded, except where required by law.",
    'from the email address you used at checkout.',
    "If a run fails with an error, we give the credit back; if anything goes wrong on our side, email support and we'll restore it.",
    "and we'll help.",
  ];
  for (const phrase of refundRule) {
    if (!html['terms.html'].includes(phrase)) throw new Error('terms refund rule diverges: ' + phrase);
    if (!html['refunds.html'].includes(phrase)) throw new Error('refunds page missing: ' + phrase);
  }
  if (!html['terms.html'].includes('Your finished PDF is stored for up to 24 hours so you can download it, then deleted; backup copies are deleted within 28 days. Save your copy.')) {
    throw new Error('terms PDF line missing the backup clause');
  }
  if (!html['refunds.html'].includes('Your finished PDF is stored for up to 24 hours so you can download it, then deleted. Save your copy.')) {
    throw new Error('refunds PDF line changed');
  }
  if (html['refunds.html'].includes('backup copies are deleted within 28 days')) throw new Error('refunds includes the backup clause');
  if (/A run that fails|failed run never/.test(Object.values(html).join('\n'))) throw new Error('a page still says every failed run returns a credit');
  const creditLine = "If a run fails with an error, we give the credit back; if anything goes wrong on our side, email support and we'll restore it.";
  const pagesHtml = Object.values(html).join('\n');
  if (pagesHtml.includes("If we can't read your files, or the run ends in an error, it doesn't use a credit.")) throw new Error('old interim credit line remains');
  if (/never uses a credit|doesn['\u2019]t use a credit/i.test(pagesHtml)) throw new Error('a page still makes an absolute credit claim');
  if ((html['index.html'].split(creditLine).length - 1) < 2) throw new Error('homepage credit line missing from the FAQ or JSON-LD');
  if ((html['terms.html'].split(creditLine).length - 1) < 2) throw new Error('terms credit line missing');
  if (!html['refunds.html'].includes(creditLine)) throw new Error('refunds credit line missing');
  if (!html['upload.html'].includes("sessionPlan === 'starter'") || !html['upload.html'].includes(creditLine)) throw new Error('upload credit line is not limited to Starter');
  if (!html['terms.html'].includes('the credits and access from that purchase end.')) throw new Error('terms missing access-ends sentence');
  const chargeback = "Chargebacks and payment disputes: access is suspended while a dispute is open, restored if it's decided in ManualOS's favor, and permanently revoked for the disputed purchase if ManualOS loses it. A dispute doesn't stop you from buying from us again, but we may decline a purchase if we reasonably suspect fraud or abuse.";
  for (const name of ['terms.html', 'refunds.html']) {
    const plain = html[name].replace(/<[^>]+>/g, '');
    if (!plain.includes(chargeback)) throw new Error(name + ' missing chargeback rule');
    if (!html[name].includes('<strong>Chargebacks and payment disputes:</strong>')) throw new Error(name + ' chargeback label changed');
  }
  if (/Integrator|at any hour|tel:/i.test(html['refunds.html'])) throw new Error('refunds page includes Integrator, a phone line, or after-hours wording');
  if (!html['refunds.html'].includes('<title>Refunds and cancellation | ManualOS</title>')) throw new Error('refunds title');
  if (!html['refunds.html'].includes('content="Refund limits for a purchase or a billing period, how to cancel Pro, and when a failed run gives the credit back."')) throw new Error('refunds meta description');
  if (!html['refunds.html'].includes('href="https://manualos.com/refunds.html"')) throw new Error('refunds canonical');
  if (!html['refunds.html'].includes('Prices are in USD, plus applicable taxes.')) throw new Error('refunds missing price note');
  if (!html['terms.html'].includes('content="ManualOS terms: supported file types, Starter and Pro plans, refunds within these limits, and Illinois law."')) throw new Error('terms meta description');
  if (/first manual|Refundable until your first manual/i.test(html['terms.html'] + html['refunds.html'] + html['index.html'])) throw new Error('a page still describes the old first-manual refund window');
  if (!html['terms.html'].includes('All prices are plus applicable taxes.')) throw new Error('terms missing tax note');
  if (!html['terms.html'].includes('each monthly charge can be refunded until that billing period ends, as long as no manual has been delivered in that period.')) throw new Error('terms missing Pro billing-period refund');
  for (const name of ['terms.html', 'privacy.html', 'refunds.html']) {
    if (/Integrator|\$249|\$2,490|white-label/i.test(html[name])) throw new Error(name + ' still mentions Integrator');
  }
  if (/\{\{LAUNCH_DATE\}\}/.test(Object.values(html).join('\n'))) throw new Error('a page still uses {{LAUNCH_DATE}}');
  const temp = 'Some file types are briefly written to temporary storage during conversion and deleted right after.';
  const kept = 'Uploaded files are processed in memory and deleted when the job finishes, including a job that fails.';
  if (!html['privacy.html'].includes(temp) || !html['privacy.html'].includes(kept)) throw new Error('privacy missing temporary-storage retention wording');
  const pdfRetention = 'It is stored on our server for 24 hours so you can download it, then deleted; backup copies are deleted within 28 days.';
  if ((html['privacy.html'].split(pdfRetention).length - 1) !== 3) throw new Error('privacy missing 24-hour PDF line');
  if (/sms-consent|text me|backend PR #8/i.test(html['support.html'])) throw new Error('support still offers a text opt-in');
  if (/team seats/i.test(html['terms.html'] + html['privacy.html'])) throw new Error('team seats were invented');
  if (/at any hour/.test(Object.values(html).join('\n'))) throw new Error('an at-any-hour line is still present');
  const turnaround = 'Approved refunds are processed within 5 business days. Your bank may take 5–10 business days to show the credit.';
  const renewalNotice = 'If you bought before these refund limits applied, the new terms apply from your next renewal, and we will email you at least 14 days before that renewal.';
  const firstRenewal = 'Changes apply from your first renewal at least 14 days after we email you about them.';
  const venue = 'Disputes are brought in the state or federal courts serving Winnebago County, Illinois, and you and we consent to their jurisdiction. Either party may bring an individual claim in small-claims court.';
  const deployDateNote = 'The effective date is filled with the production deploy date when this page is merged.';
  const effectiveDateJs = await read('effective-date.js');
  const effectiveTokenCount = (effectiveDateJs.match(/\[\[EFFECTIVE_DATE\]\]/g) || []).length;
  if (effectiveTokenCount !== 0) throw new Error('effective date token remains (' + effectiveTokenCount + ')');
  if (!effectiveDateJs.includes("var EFFECTIVE_DATE = 'October 25, 2026';")) throw new Error('effective date is not October 25, 2026');
  if (!effectiveDateJs.includes(deployDateNote)) throw new Error('effective-date.js is not marked as the merge edit');
  const mailingConst = "var OP3X_MAILING_ADDRESS = '[OP3X MAILING ADDRESS]';";
  if (effectiveDateJs.split(mailingConst).length - 1 !== 1) throw new Error('mailing address is not one constant in effective-date.js');
  if (!effectiveDateJs.includes("OP3X_MAILING_ADDRESS.charAt(0) !== '['")) throw new Error('placeholder address is still written onto the page');
  const dateCheck = await read('dev/check-effective-date.mjs');
  if (!dateCheck.includes('[[EFFECTIVE_DATE]]') || !dateCheck.includes('mailing address') || !dateCheck.includes('process.exit(1)')) {
    throw new Error('effective-date check does not fail while the token or a mailing address remains');
  }
  for (const name of ['terms.html', 'refunds.html']) {
    if (!html[name].includes(turnaround)) throw new Error(name + ' missing refund turnaround');
    if (html[name].includes(renewalNotice)) throw new Error(name + ' still has the next-renewal notice');
    if (!html[name].includes(firstRenewal)) throw new Error(name + ' missing first-renewal clause');
    if (!html[name].includes(venue)) throw new Error(name + ' missing Winnebago venue');
  }
  if (/arbitration|class-action waiver|class action waiver|jury waiver/i.test(html['terms.html'] + html['refunds.html'] + html['privacy.html'])) {
    throw new Error('arbitration or class waiver text is present');
  }
  const responseScan = (html['support.html'] + html['terms.html'] + html['refunds.html']).split(turnaround).join('');
  if (/within \d+ (hour|business day)|response time|we will respond|promptly|immediately/i.test(responseScan)) {
    throw new Error('support, terms, or refunds promise a response time');
  }
  if (!/State of Illinois/.test(html['terms.html'])) throw new Error('terms missing Illinois law');
  if (/account alerts/.test(html['support.html'] + html['privacy.html'] + html['terms.html'])) {
    throw new Error('account alerts is still promised');
  }
  const cancelSentence = "Cancel anytime online: use the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Pro until the end of the period you've paid for.";
  const cancelCopy = 'Cancel anytime online: use the one-click cancel email at <a href="/cancel">manualos.com/cancel</a>. Cancelling stops future charges, and you keep Pro until the end of the period you\'ve paid for.';
  const cancelEffect = "Your cancellation takes effect when we receive your email. We'll email you a confirmation within one business day, and you won't be charged again. If a renewal charge goes through after you've sent it, we'll refund it.";
  if (!html['terms.html'].includes(cancelCopy) || !html['refunds.html'].includes(cancelCopy)) throw new Error('email cancel sentence missing');
  if (!html['index.html'].includes(cancelSentence)) throw new Error('JSON-LD cancel sentence missing');
  for (const name of pages) {
    if (!html[name].includes(cancelCopy)) throw new Error(name + ' footer missing the cancel sentence');
    if (/Manage plan|self-serve/i.test(html[name])) throw new Error(name + ' still says Manage plan or self-serve');
    if (/data-mp-section|app\.link\.com|merchant of record/i.test(html[name])) throw new Error(name + ' still has managed-payments copy');
  }
  for (const name of ['terms.html', 'refunds.html']) {
    if (/Email backup|online option/.test(html[name])) throw new Error(name + ' still frames email as a backup');
  }
  const cancelPage = html['cancel/index.html'];
  const mailto = 'mailto:support@manualos.com?subject=Cancel%20my%20ManualOS%20Pro%20subscription&body=Please%20cancel%20my%20ManualOS%20Pro%20subscription.%20My%20account%20email%20is%20the%20address%20this%20message%20is%20sent%20from.';
  if (cancelPage.includes('id="cancel-form"') || cancelPage.includes('id="cancel-submit"') || /Manage plan/.test(cancelPage)) {
    throw new Error('cancel page still has a Manage plan control');
  }
  if (/\/billing-portal|\/access-link|checkout-config\.js/.test(cancelPage)) throw new Error('cancel page still calls the backend');
  if (!cancelPage.includes('id="send-cancel-email"') || !cancelPage.includes(mailto.replace('&body', '&amp;body'))) throw new Error('cancel mailto missing');
  if (!cancelPage.includes('>Send cancellation email</a>')) throw new Error('cancel button label missing');
  if (!cancelPage.includes(cancelEffect)) throw new Error('cancel effect sentence missing');
  if (!cancelPage.includes('Or email <span id="cancel-address">support@manualos.com</span>')) throw new Error('cancel fallback address missing');
  if (!cancelPage.includes('>Cancel my ManualOS Pro subscription</span>')) throw new Error('cancel fallback subject missing');
  if (!cancelPage.includes('aria-label="Copy address, support@manualos.com"') || !cancelPage.includes('aria-label="Copy subject, Cancel my ManualOS Pro subscription"')) {
    throw new Error('copy buttons missing accessible labels');
  }
  if (/data-mp-section|app\.link\.com|merchant of record|mp-cancel-lead/i.test(cancelPage)) throw new Error('cancel page still has managed-payments copy');
  const retention = "We delete support threads, recordings and transcripts as soon as practicable once they're no longer needed.";
  if (!html['privacy.html'].includes(retention)) throw new Error('privacy missing practicable deletion sentence');
  if (!html['privacy.html'].includes('<!-- restore 90-day wording when backend retention PR ships -->')) throw new Error('privacy missing retention restore comment');
  if (/90 days/i.test(html['privacy.html'] + html['support.html'] + html['terms.html'] + html['refunds.html'])) throw new Error('a 90-day retention promise is still present');
  for (const name of ['terms.html', 'privacy.html', 'refunds.html', 'support.html']) {
    if (/Integrator|\$249|\$2,490|per year|yearly/i.test(html[name])) throw new Error(name + ' still mentions an unsold plan');
  }
  if (/To cancel, email/.test(html['terms.html'] + html['refunds.html'])) throw new Error('email-only cancel sentence remains');
  if (/By buying a plan or uploading files, you agree to them/.test(html['terms.html'])) throw new Error('browsewrap sentence remains');
  if (!html['terms.html'].includes('You accept them when you check the box at checkout')) throw new Error('terms assent sentence missing');
  if (/doing business as/i.test(html['terms.html'])) throw new Error('terms still says doing business as');
  const footerLine = '© 2026 Op3x LLC. ManualOS is operated by Op3x LLC.';
  for (const name of ['index.html', 'upload.html', '404.html', 'privacy.html', 'terms.html', 'refunds.html', 'support.html', 'cancel/index.html']) {
    if (!html[name].includes('<p class="legal">' + footerLine + '</p>')) throw new Error(name + ' footer is not the Op3x operator line');
  }
  if (/a service of|a product of/i.test(Object.values(html).join('\n'))) throw new Error('a page still says a service of or a product of');
  if (/never stored|after you leave the page|isn['\u2019]t kept|send your files/i.test(Object.values(html).join('\n'))) throw new Error('a page still says files are never stored, aren\'t kept, disappear after you leave, or that we send your files');
  const allowedRetention = new Set(['24 hour', '24 hours', '30 day', '30 days', '28 day', '28 days']);
  for (const name of pages) {
    const visible = html[name].replace(/<!--[\s\S]*?-->/g, '');
    const duration = /\b(\d+)\s*(hour|hours|day|days)\b/gi;
    let match;
    while ((match = duration.exec(visible))) {
      const phrase = (match[1] + ' ' + match[2]).toLowerCase();
      if (allowedRetention.has(phrase)) continue;
      const around = visible.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
      if (/\b(keep|kept|store|stored|delet|retention|backup|expire|expired)\w*/i.test(around)) {
        throw new Error(name + ' has a retention period other than 24 hours, 30 days, or 28 days: ' + phrase);
      }
    }
  }
  const homepageLine = "To write your manual, we send content extracted from your files, such as program logic, comments, and part details, to a third-party service provider that helps write the manual. We delete your uploaded files when the job finishes. Download your PDF right away, because we delete it 24 hours after it's made. Our provider deletes what we send it within 30 days, unless it must keep it longer to enforce its usage policy or comply with the law. Full details are in our Privacy Policy.";
  if (!html['index.html'].includes('"text": "' + homepageLine + '"')) throw new Error('JSON-LD FAQ answer missing');
  if (!html['index.html'].includes(homepageLine.replace('Privacy Policy.', '<a href="/privacy.html">Privacy Policy</a>.'))) throw new Error('homepage visible retention line missing');
  const faqHeading = 'Who can see my PLC program?</h3>';
  const faqStart = html['index.html'].indexOf(faqHeading);
  const faqItem = html['index.html'].slice(faqStart + faqHeading.length, html['index.html'].indexOf('</div>', faqStart));
  const faqParagraphs = [...faqItem.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((part) => part[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  if (faqParagraphs.length !== 1 || faqParagraphs[0] !== homepageLine) throw new Error('visible FAQ text does not match the retention statement');
  if (html['index.html'].includes('You get the PDF when the job is done.')) throw new Error('FAQ repeats the 24-hour download sentence');
  const metaPrice = 'Starter is $39 once for 3 manuals, plus applicable taxes. Pro is $79 per month, plus applicable taxes.';
  if ((html['index.html'].split(metaPrice).length - 1) !== 3) throw new Error('homepage meta descriptions do not state plus applicable taxes');
  const readyCard = "Your PDF is ready. Download it right away, because it's deleted 24 hours after it's made.";
  const expiredManual = "This manual isn't available. Manuals are deleted 24 hours after they're made. Generate it again from your files.";
  if (!html['upload.html'].includes(readyCard)) throw new Error('upload ready card missing');
  if ((html['upload.html'].match(new RegExp(expiredManual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length < 2) throw new Error('upload expired message missing');
  const privacyVisible = html['privacy.html'].replace(/<!--[\s\S]*?-->/g, '');
  if (privacyVisible.includes('Only the buyer who made it can download it')) throw new Error('buyer-only download line ships before backend #19');
  if (!html['privacy.html'].includes('TODO backend #19')) throw new Error('privacy missing the backend #19 download TODO');
  if (!privacyVisible.includes("Anyone who has the job link can download it during those 24 hours, so don't share it.")) throw new Error('privacy missing the pre-#19 download line');
  if (!html['privacy.html'].includes('Backup copies, which can include generated PDFs and job status from the last 24 hours, are deleted within 28 days.')) throw new Error('privacy missing the backups line');
  if (!html['terms.html'].includes('Each generated PDF is stored for 24 hours so you can download it, then deleted; backup copies are deleted within 28 days. Download your copy right away.')) throw new Error('terms download line missing');
  const trainNearModel = /\btrain\w{0,3}\b[\s\S]{0,40}\bmodels?\b|\bmodels?\b[\s\S]{0,40}\btrain\w{0,3}\b/i;
  for (const name of pages) {
    if (trainNearModel.test(html[name])) throw new Error(name + ' still says files are used to train models');
  }
  const indexOutsideCredit = html['index.html'].replace(/<([a-z0-9]+)\b[^>]*\bclass="[^"]*\bcredit(?:-note)?\b[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, '');
  if (/\bAI\b/i.test(indexOutsideCredit)) throw new Error('homepage mentions AI outside the credit');
  const homepageProvider = 'a third-party service provider that helps write the manual';
  if ((html['index.html'].match(new RegExp(homepageProvider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length < 3) {
    throw new Error('homepage provider wording is missing from the privacy box, FAQ, or JSON-LD');
  }
  if (!html['privacy.html'].includes('to a third-party AI model provider')) throw new Error('privacy dropped the outside AI provider line');
  if (!html['terms.html'].includes('partly by an AI model')) throw new Error('terms dropped the outside AI model line');
  if (!html['index.html'].includes('Full details are in our <a href="/privacy.html">Privacy Policy</a>.')) throw new Error('homepage privacy link missing');
  if (html['index.html'].includes('at https://manualos.com/privacy.html')) throw new Error('JSON-LD still appends the privacy URL');
  if (html['index.html'].includes('Full details are in our Privacy Policy. You get the PDF when the job is done.')) throw new Error('JSON-LD FAQ answer appends the extra download sentence');
  if (!html['terms.html'].includes('ManualOS is operated by Op3x LLC ("ManualOS," "we," "us")')) throw new Error('terms operator sentence missing');
  const indexMarkup = html['index.html'].slice(0, html['index.html'].lastIndexOf('<script>'));
  const configJs = await read('checkout-config.js');
  const autoRenew = 'Renews automatically at $79 plus applicable taxes each month until you cancel. Cancel anytime online: use the one-click cancel email at <a href="/cancel">manualos.com/cancel</a>. Cancelling stops future charges, and you keep Pro until the end of the period you\'ve paid for. Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.';
  const proConsent = 'I agree to the <a href="https://manualos.com/terms.html">ManualOS Terms</a> and authorize Op3x LLC to charge my card $79/month (USD, plus applicable taxes), renewing automatically each month until I cancel.';
  const starterConsent = 'I agree to the <a href="https://manualos.com/terms.html">ManualOS Terms</a> and authorize Op3x LLC to make this one-time charge. This isn\'t a subscription.';
  const starterRefund = '$39 one time for 3 manuals, plus applicable taxes. Full refund within 30 days of purchase, as long as no manual from that purchase has been delivered, except where the law requires otherwise.';
  const directSeller = 'Op3x LLC is the seller of ManualOS. Op3x LLC processes payments and refunds for these purchases and handles payment disputes.';
  if (/CHECKOUT_SELLER_MODE|MANAGED_PAYMENTS_ON/.test(html['index.html'] + configJs)) throw new Error('a frontend seller constant is still present');
  if (!configJs.includes("'/api/checkout-config'") || !html['index.html'].includes('src="/checkout-config.js"')) throw new Error('checkout config is not loaded from the backend');
  if (!html['terms.html'].includes('src="/checkout-config.js"') || !html['refunds.html'].includes('src="/checkout-config.js"') || !html['privacy.html'].includes('src="/checkout-config.js"')) throw new Error('legal pages do not load checkout config');
  if (!configJs.includes('3000')) throw new Error('checkout config has no 3 second fallback');
  if (!html['index.html'].includes('termsAccepted: true') || /termsConsent/.test(html['index.html'])) throw new Error('checkout payload must send termsAccepted and not termsConsent');
  if (!html['index.html'].includes("getAttribute('data-checkout-config')")) throw new Error('Pay stays enabled before checkout config settles');
  if (/while managed payments are on/.test(html['terms.html'] + html['refunds.html'])) throw new Error('managed-payments jargon remains');
  if (!html['terms.html'].includes('Changes apply to purchases made after the effective date.')) throw new Error('terms missing purchases-after-effective-date sentence');
  if (!html['terms.html'].includes('Changes apply from your first renewal at least 14 days after we email you about them.')) throw new Error('terms changes clause missing');
  const smsRecords = 'Opt-outs are kept indefinitely, and consent records are kept for 5 years after the last message or the opt-out, whichever is later.';
  if (html['privacy.html'].includes(smsRecords) || /#sms|text messages|Text messages/i.test(html['privacy.html'] + html['terms.html'])) {
    throw new Error('privacy or terms still has a text-message section');
  }
  if (/until you opt out or ask us to delete it/.test(html['privacy.html'])) throw new Error('old SMS retention sentence remains');
  if (/<strong>\s*Open items\./.test(html['privacy.html'] + html['terms.html'] + html['refunds.html'])) throw new Error('Open items box is still visible');
  if (/data-statement|data-seller-mp|data-seller-direct|data-mp-section|merchant of record|app\.link\.com/i.test(configJs)) throw new Error('checkout config still toggles card copy');
  const aiRetention = 'Our AI model provider deletes the text we send it, and what it returns, within 30 days, unless it must keep it longer to enforce its usage policy or to comply with the law.';
  const emailShare = 'an email provider, to receive and answer support emails';
  const toolShare = 'automated tools, including AI assistants, that help us run and support the service; they access your information only to do that work.';
  if (!html['privacy.html'].includes(aiRetention)) throw new Error('privacy AI retention line does not match the provider terms');
  if ((html['privacy.html'].match(new RegExp(aiRetention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length < 2) throw new Error('privacy AI retention line is missing from processing or retention');
  if (/It deletes the data within 30 days|usage policies/.test(html['privacy.html'])) throw new Error('old AI retention line remains');
  if (!html['privacy.html'].includes(emailShare) || !html['privacy.html'].includes(toolShare)) throw new Error('privacy sharing list is missing the email provider or automated tools');
  if (html['index.html'].includes(aiRetention) || html['index.html'].includes(emailShare) || html['index.html'].includes(toolShare)) throw new Error('privacy-only sharing or retention copy is on the homepage');
  if (/\bLink\b|LINK\.COM|Stripe/.test(configJs)) throw new Error('checkout config script names a provider');
  if (!indexMarkup.includes('<label for="pro-consent">' + proConsent + '</label>')) throw new Error('pro checkbox label is not the approved sentence');
  if (!indexMarkup.includes('<label for="starter-consent">' + starterConsent + '</label>')) throw new Error('starter checkbox label is not the approved sentence');
  if (!indexMarkup.includes('id="pro-auto-renew">' + autoRenew + '</p>')) throw new Error('pro renewal, cancel, and refund lines are not beside Pay');
  if (!indexMarkup.includes('id="starter-renew-terms">' + starterRefund + '</p>')) throw new Error('starter refund line is not beside Buy');
  if (/data-seller-note|data-seller-direct|data-seller-mp|data-statement|merchant of record|authorized reseller|LINK\.COM/i.test(indexMarkup)) throw new Error('reseller or card-statement copy is still on the pricing cards');
  if (/will appear on your card statement/.test(html['index.html'])) throw new Error('old card-statement clause is still in the disclosure');
  if (/plus applicable tax(?!es)/.test(html['index.html'])) throw new Error('checkout still says applicable tax');
  if (/By continuing you agree|Refundable within 30 days if no manual has been delivered/.test(indexMarkup)) throw new Error('old starter agreement line remains');
  if (!html['index.html'].includes('Starter $39 once · 3 manuals. Pro $79 a month · unlimited. Plus applicable taxes.')) throw new Error('homepage pricing line missing taxes');
  if (!html['index.html'].includes('One-time purchase of 3 manuals, plus applicable taxes.')) throw new Error('starter offer description missing taxes');
  if (!html['index.html'].includes('Monthly subscription with unlimited manuals, plus applicable taxes.')) throw new Error('pro offer description missing taxes');
  for (const name of pages) {
    if (/\$39|\$79/.test(html[name]) && !/tax/i.test(html[name])) throw new Error(name + ' states a price without tax');
  }
  if (/\$249|\$2,490|Start Integrator|integrator-consent/.test(html['index.html'])) throw new Error('homepage still sells Integrator');
  for (const name of ['terms.html', 'refunds.html']) {
    if (!html[name].includes('<p data-direct-section>' + directSeller + '</p>')) throw new Error(name + ' missing direct seller section');
  }
  if (/billing-portal|access-link/.test(html['cancel/index.html'])) {
    throw new Error('cancel page still names a billing backend route');
  }
  if (/\bStripe\b|bought through Link|Link account/.test(html['index.html'] + html['cancel/index.html'] + html['terms.html'] + html['refunds.html'])) {
    throw new Error('a provider name is in the new copy');
  }
  for (const id of ['starter-consent', 'pro-consent']) {
    const tag = (html['index.html'].match(new RegExp('<input[^>]*id="' + id + '"[^>]*>')) || [''])[0];
    if (!tag) throw new Error('missing ' + id);
    if (/\schecked\b/.test(tag)) throw new Error(id + ' starts checked');
    if (!/\srequired\b/.test(tag)) throw new Error(id + ' is not required');
    if (!html['index.html'].includes('for="' + id + '"')) throw new Error(id + ' has no label');
  }
  if (!html['support.html'].includes("var SUPPORT_PHONE_DISPLAY = '';")) throw new Error('phone constant missing or not empty');
  if (/sms-consent|CONSENT_TEXT|text me|API_BASE/i.test(html['support.html'])) throw new Error('support script still posts a text opt-in');
  if (/formspree|getform|basin\.|typeform|google.com\/forms/i.test(html['support.html'])) throw new Error('third-party form service');
  const shipped = Object.values(html).join('\n');
  for (const phrase of ['self-serve', 'Manage plan', 'text me', 'sms-consent', 'did not use a credit', 'does not use a credit']) {
    if (shipped.toLowerCase().includes(phrase.toLowerCase())) throw new Error('shipped page still contains ' + phrase);
  }
  if (/provided by Op3x/i.test(shipped)) throw new Error('hidden checkout copy still says provided by');
  if (!html['upload.html'].includes(CREDIT_LINE) || !html['index.html'].includes(CREDIT_LINE)) throw new Error('approved credit line missing');
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
      for (const name of ['support.html', 'privacy.html', 'terms.html', 'refunds.html', '404.html', 'index.html', 'cancel/']) {
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
    const smsBox = await page.$('#sms-consent');
    if (smsBox) throw new Error('support still has a text opt-in');

    for (const name of ['support.html', 'privacy.html', 'terms.html', 'refunds.html']) {
      await page.goto(base + '/' + name, { waitUntil: 'networkidle0' });
      const stem = name.replace('.html', '');
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.screenshot({ path: path.join(shotDir, stem + '_390.png'), fullPage: true });
      await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
      await page.screenshot({ path: path.join(shotDir, stem + '_1280.png'), fullPage: true });
    }
    async function smsPosts() {
      const list = await fetch(base + '/__mock/requests').then((res) => res.json());
      return list.filter((item) => item.path === '/api/support/sms-consent');
    }

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.goto(base + '/support.html', { waitUntil: 'networkidle0' });
    await page.type('#support-name', 'Ada Lovelace');
    await page.type('#support-email', 'ada@example.com');
    await page.click('#support-submit');
    await page.waitForFunction(() => document.getElementById('form-error').textContent.includes('highlighted'));
    if ((await smsPosts()).length) throw new Error('support posted a text opt-in');
    await runAxe(page, 'support validation errors');

    await page.type('#support-message', 'The manual link stopped working.');
    await page.click('#support-submit');
    await page.waitForFunction(() => !document.getElementById('form-status').hidden);
    if ((await smsPosts()).length) throw new Error('support posted a text opt-in after send');
    const mailto = await page.$eval('#email-opener', (el) => el.getAttribute('href'));
    if (!mailto.startsWith('mailto:support@manualos.com?')) throw new Error('mailto target ' + mailto);
    const body = decodeURIComponent(mailto.split('body=')[1]);
    if (!body.includes('The manual link stopped working.') || !body.includes('Ada Lovelace') || /text opt-in/i.test(body)) {
      throw new Error('mailto body ' + body);
    }
    await runAxe(page, 'support after send');

    await page.goto(base + '/index.html#pricing', { waitUntil: 'networkidle0' });
    const proGate = await page.evaluate(() => {
      const input = document.getElementById('pro-consent');
      const label = document.querySelector('label[for="pro-consent"]');
      input.focus({ focusVisible: true });
      const style = getComputedStyle(input);
      return {
        tied: !!(label && label.htmlFor === 'pro-consent'),
        checked: input.checked,
        buttonDisabled: document.querySelector('[data-checkout="pro"]').disabled,
        outlineStyle: style.outlineStyle,
        outlineWidth: parseFloat(style.outlineWidth),
        label: label.textContent.replace(/\s+/g, ' ').trim(),
        termsHref: label.querySelector('a').href,
        renewal: document.getElementById('pro-auto-renew').textContent.replace(/\s+/g, ' ').trim(),
        renewalNextToPay: document.getElementById('pro-auto-renew').nextElementSibling === document.querySelector('[data-checkout="pro"]'),
        renewalNextToConsent: document.getElementById('pro-auto-renew').previousElementSibling === document.getElementById('pro-consent').closest('.consent-row'),
        reseller: document.body.textContent.includes('authorized reseller') || document.body.textContent.includes('LINK.COM'),
      };
    });
    if (!proGate.tied || proGate.checked || !proGate.buttonDisabled || proGate.reseller) {
      throw new Error('pro consent gate ' + JSON.stringify(proGate));
    }
    if (proGate.outlineStyle === 'none' || !(proGate.outlineWidth > 0)) throw new Error('pro checkbox focus is not visible ' + JSON.stringify(proGate));
    if (proGate.label !== 'I agree to the ManualOS Terms and authorize Op3x LLC to charge my card $79/month (USD, plus applicable taxes), renewing automatically each month until I cancel.' || proGate.termsHref !== 'https://manualos.com/terms.html') {
      throw new Error('pro label ' + JSON.stringify(proGate));
    }
    if (proGate.renewal !== "Renews automatically at $79 plus applicable taxes each month until you cancel. Cancel anytime online: use the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Pro until the end of the period you've paid for. Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise." || !proGate.renewalNextToPay || !proGate.renewalNextToConsent) {
      throw new Error('pro auto-renewal disclosure ' + JSON.stringify(proGate));
    }
    const beforeUnchecked = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').length;
    await page.evaluate(() => document.querySelector('[data-checkout="pro"]').click());
    const afterUnchecked = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').length;
    const stayedDisabled = await page.$eval('[data-checkout="pro"]', (el) => el.disabled && !document.getElementById('pro-consent').checked && location.pathname.endsWith('/index.html'));
    if (afterUnchecked !== beforeUnchecked || !stayedDisabled) throw new Error('Buy started checkout before the box was ticked');
    await page.focus('#pro-consent');
    await page.keyboard.press('Space');
    const proEnabled = await page.$eval('[data-checkout="pro"]', (el) => !el.disabled && document.getElementById('pro-consent').checked);
    if (!proEnabled) throw new Error('keyboard did not enable Start Pro');
    await page.click('#pro-consent');
    const proDisabledAgain = await page.$eval('[data-checkout="pro"]', (el) => el.disabled && !document.getElementById('pro-consent').checked);
    if (!proDisabledAgain) throw new Error('clearing the box left Start Pro enabled');
    await page.keyboard.press('Space');
    const beforeCheckout = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').length;
    await page.click('[data-checkout="pro"]');
    await page.waitForFunction(() => location.pathname.endsWith('/upload.html'));
    const checkout = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').slice(beforeCheckout);
    if (checkout.length !== 1 || checkout[0].status !== 200) throw new Error('checkout response ' + JSON.stringify(checkout));
    if (checkout[0].plan !== 'pro' || checkout[0].renewalConsent !== true || checkout[0].termsAccepted !== true || checkout[0].termsConsent !== undefined || checkout[0].termsVersion !== 'terms-rev-a-m2' || checkout[0].disclosureVersion !== 'pro-renew-b2-mp' || !checkout[0].fields.includes('termsAccepted') || checkout[0].fields.includes('termsConsent') || checkout[0].fields.includes('terms_version')) {
      throw new Error('checkout body ' + JSON.stringify(checkout[0]));
    }

    await page.goto(base + '/index.html#pricing', { waitUntil: 'networkidle0' });
    const starterDisabled = await page.$eval('[data-checkout="starter"]', (el) => el.disabled && !document.getElementById('starter-consent').checked);
    if (!starterDisabled) throw new Error('starter button starts enabled');
    const starterLabel = await page.$eval('label[for="starter-consent"]', (el) => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      href: el.querySelector('a').href,
    }));
    if (starterLabel.text !== "I agree to the ManualOS Terms and authorize Op3x LLC to make this one-time charge. This isn't a subscription." || starterLabel.href !== 'https://manualos.com/terms.html') {
      throw new Error('starter label ' + JSON.stringify(starterLabel));
    }
    const beforeStarterClick = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').length;
    await page.evaluate(() => document.querySelector('[data-checkout="starter"]').click());
    const afterStarterClick = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').length;
    if (afterStarterClick !== beforeStarterClick) throw new Error('Buy Starter posted checkout before the box was ticked');
    await page.click('#starter-consent');
    const starterEnabled = await page.$eval('[data-checkout="starter"]', (el) => !el.disabled);
    if (!starterEnabled) throw new Error('ticking the box did not enable Buy Starter');
    await page.click('[data-checkout="starter"]');
    await page.waitForFunction(() => location.pathname.endsWith('/upload.html'));
    const starter = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').pop();
    if (starter.plan !== 'starter' || starter.renewalConsent !== false || starter.termsAccepted !== true || starter.termsConsent !== undefined || starter.disclosureVersion !== 'starter-disclosure-b2-mp' || starter.fields.includes('termsConsent') || starter.fields.includes('terms_version')) {
      throw new Error('starter body ' + JSON.stringify(starter));
    }

    for (const width of [390, 1280]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
      const beforeNav = await fetch(base + '/__mock/requests').then((res) => res.json());
      await page.goto(base + '/cancel/?session_id=cs_test_pro', { waitUntil: 'networkidle0' });
      const extra = await overflow(page);
      if (extra > 1) throw new Error('cancel overflows by ' + extra + 'px at ' + width);
      await runAxe(page, 'cancel email ' + width);
      await page.screenshot({ path: path.join(shotDir, 'cancel_' + width + '.png'), fullPage: true });
      const afterNav = await fetch(base + '/__mock/requests').then((res) => res.json());
      const posts = afterNav.slice(beforeNav.length).filter((item) => item.method === 'POST' && (item.path === '/billing-portal' || item.path === '/access-link' || item.path === '/api/support/sms-consent'));
      if (posts.length) throw new Error('cancel page called the backend ' + JSON.stringify(posts));
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const cancelState = await page.evaluate(() => {
      const button = document.getElementById('send-cancel-email');
      const lead = document.getElementById('mp-cancel-lead');
      const effect = document.getElementById('cancel-effect').textContent.replace(/\s+/g, ' ').trim();
      const fallback = document.getElementById('cancel-fallback').textContent.replace(/\s+/g, ' ').trim();
      return {
        label: button.textContent.trim(),
        href: button.getAttribute('href'),
        buttons: [...document.querySelectorAll('button')].map((el) => el.id),
        forms: document.querySelectorAll('form').length,
        lead: lead !== null,
        effect,
        fallback,
        addressLabel: document.getElementById('copy-address').getAttribute('aria-label'),
        subjectLabel: document.getElementById('copy-subject').getAttribute('aria-label'),
        managePlan: /Manage plan/i.test(document.body.textContent),
      };
    });
    const expectedEffect = "Your cancellation takes effect when we receive your email. We'll email you a confirmation within one business day, and you won't be charged again. If a renewal charge goes through after you've sent it, we'll refund it.";
    if (cancelState.label !== 'Send cancellation email' || cancelState.forms || cancelState.lead || cancelState.managePlan) {
      throw new Error('cancel page controls ' + JSON.stringify(cancelState));
    }
    if (cancelState.buttons.join(',') !== 'copy-address,copy-subject') throw new Error('cancel buttons ' + cancelState.buttons.join(','));
    if (cancelState.effect !== expectedEffect) throw new Error('cancel effect ' + cancelState.effect);
    if (!cancelState.fallback.startsWith('Or email support@manualos.com') || !cancelState.fallback.includes('with the subject Cancel my ManualOS Pro subscription')) {
      throw new Error('cancel fallback ' + cancelState.fallback);
    }
    if (cancelState.addressLabel !== 'Copy address, support@manualos.com' || cancelState.subjectLabel !== 'Copy subject, Cancel my ManualOS Pro subscription') {
      throw new Error('copy labels ' + JSON.stringify(cancelState));
    }
    const href = cancelState.href.replace(/&amp;/g, '&');
    const query = href.split('?')[1] || '';
    const params = new URLSearchParams(query);
    if (!href.startsWith('mailto:support@manualos.com?') || params.get('subject') !== 'Cancel my ManualOS Pro subscription' || params.get('body') !== 'Please cancel my ManualOS Pro subscription. My account email is the address this message is sent from.') {
      throw new Error('mailto ' + href);
    }
    await page.evaluate(() => {
      window.__copied = [];
      if (!navigator.clipboard) navigator.clipboard = {};
      navigator.clipboard.writeText = (value) => {
        window.__copied.push(value);
        return Promise.resolve();
      };
    });
    await page.click('#copy-address');
    await page.waitForFunction(() => document.getElementById('copy-status').textContent === 'Copied the support email address.');
    await page.click('#copy-subject');
    await page.waitForFunction(() => document.getElementById('copy-status').textContent === 'Copied the cancellation subject.');
    const copied = await page.evaluate(() => window.__copied);
    if (copied.join('|') !== 'support@manualos.com|Cancel my ManualOS Pro subscription') throw new Error('copied ' + JSON.stringify(copied));
    await runAxe(page, 'cancel after copy 390');
    const afterCopy = await fetch(base + '/__mock/requests').then((res) => res.json());
    const copyPosts = afterCopy.filter((item) => item.method === 'POST' && (item.path === '/billing-portal' || item.path === '/access-link'));
    if (copyPosts.length) throw new Error('copy buttons called the backend');

    async function setConfig(body) {
      const res = await fetch(base + '/__mock/checkout-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('mock config ' + res.status);
    }

    async function renderedSeller(target) {
      return target.evaluate(() => {
        function shown(selector) {
          const el = document.querySelector(selector);
          if (!el) return null;
          return !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let text = '';
        let node;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (!parent || parent.closest('[hidden]')) continue;
          text += node.textContent;
        }
        return {
          note: shown('[data-seller-note]'),
          statement: shown('[data-statement]'),
          mpCharge: shown('[data-seller-mp]'),
          directCharge: shown('[data-seller-direct]'),
          mpSection: shown('[data-mp-section]'),
          directSection: shown('[data-direct-section]'),
          text: text.replace(/\s+/g, ' ').trim(),
        };
      });
    }

    function expectSeller(state, mode, where) {
      if (where === 'index') {
        if (state.note !== null || state.mpSection !== null || state.statement !== null || state.mpCharge !== null || state.directCharge !== null) {
          throw new Error(where + ' ' + mode + ' visibility ' + JSON.stringify(state));
        }
        const renewalLine = "Renews automatically at $79 plus applicable taxes each month until you cancel. Cancel anytime online: use the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Pro until the end of the period you've paid for. Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.";
        const starterLine = "Full refund within 30 days of purchase, as long as no manual from that purchase has been delivered, except where the law requires otherwise.";
        if (!state.text.includes(renewalLine) || !state.text.includes(starterLine)) throw new Error(where + ' missing renewal or refund disclosure');
        if (!state.text.includes('authorize Op3x LLC to charge my card $79/month (USD, plus applicable taxes)')) throw new Error(where + ' missing pro authorization');
        if (/merchant of record|app\.link\.com|authorized reseller|LINK\.COM|link\.com|full online alternative|first manual/i.test(state.text)) throw new Error(where + ' still shows retired copy');
      } else if (where === 'privacy.html') {
        if (state.mpSection !== null) throw new Error(where + ' still has a managed-payments section');
        if (!state.text.includes('Our payment processor handles checkout, cards, receipts, and subscriptions under its own privacy policy.')) {
          throw new Error(where + ' dropped the direct processor wording');
        }
        if (/merchant of record|app\.link\.com|\bLink\b/.test(state.text)) throw new Error(where + ' still names Link');
      } else {
        if (state.mpSection !== null || state.directSection !== true) throw new Error(where + ' ' + mode + ' sections ' + JSON.stringify(state));
        if (/merchant of record|app\.link\.com|Link is the reseller|full online alternative/i.test(state.text)) throw new Error(where + ' still shows managed-payments copy');
        if (/\bLink\b/.test(state.text)) throw new Error(where + ' leaked Link');
        if (!state.text.includes('Op3x LLC is the seller of ManualOS')) throw new Error(where + ' missing direct seller');
      }
      if (where === 'privacy.html' || where === 'terms.html' || where === 'refunds.html') {
        const retiredStreet = '250 ' + String.fromCharCode(84, 114, 101, 110, 116);
        const retiredZip = String.fromCharCode(54, 49, 49, 49, 49);
        if (/mailing address/i.test(state.text) || state.text.includes('[OP3X MAILING ADDRESS]') || state.text.includes(retiredStreet) || state.text.includes(retiredZip)) {
          throw new Error(where + ' still shows a mailing address');
        }
        if (where === 'terms.html' && !state.text.includes("Notices to us: email support@manualos.com with 'Legal notice' in the subject line. Notices to you: we'll email the address on your account or post them on the site. Notices are effective when sent.")) {
          throw new Error(where + ' notices text missing');
        }
        if (where === 'terms.html' && !state.text.includes('Email: support@manualos.com. Support form.')) throw new Error(where + ' contact line changed');
        if (where === 'privacy.html' && (!state.text.includes('Questions, privacy requests or complaints: email support@manualos.com or use our support form.') || !state.text.includes('Our privacy contact is the Privacy Officer, Op3x LLC.'))) {
          throw new Error(where + ' privacy contact changed');
        }
        if (where === 'refunds.html' && !state.text.includes('Email: support@manualos.com.')) throw new Error(where + ' contact line changed');
      }
    }

    await setConfig({ managedPayments: false, fail: false, hold: false });
    for (const name of ['index.html#pricing', 'terms.html', 'refunds.html', 'privacy.html']) {
      await page.goto(base + '/' + name, { waitUntil: 'networkidle0' });
      expectSeller(await renderedSeller(page), 'direct', name.startsWith('index') ? 'index' : name);
    }
    await page.goto(base + '/index.html#pricing', { waitUntil: 'networkidle0' });
    await page.click('#pro-consent');
    await page.click('[data-checkout="pro"]');
    await page.waitForFunction(() => location.pathname.endsWith('/upload.html'));
    const directCheckout = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').pop();
    if (!directCheckout || directCheckout.termsAccepted !== true || directCheckout.termsConsent !== undefined || directCheckout.disclosureVersion !== 'pro-renew-b2-direct' || (directCheckout.fields || []).includes('terms_version')) throw new Error('direct checkout ' + JSON.stringify(directCheckout));

    await setConfig({ managedPayments: true, fail: true, hold: false });
    for (const name of ['index.html#pricing', 'terms.html', 'refunds.html', 'privacy.html']) {
      const beforeFail = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/api/checkout-config').length;
      await page.goto(base + '/' + name, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((start) => fetch('/__mock/requests').then((res) => res.json()).then((list) => {
        const configs = list.filter((item) => item.path === '/api/checkout-config');
        return configs.length > start && configs[configs.length - 1].status === 500 && document.documentElement.getAttribute('data-checkout-config') === 'direct';
      }), { timeout: 8000 }, beforeFail);
      expectSeller(await renderedSeller(page), 'direct', name.startsWith('index') ? 'index' : name);
    }
    const failedConfig = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/api/checkout-config').pop();
    if (!failedConfig || failedConfig.status !== 500) throw new Error('config failure was not recorded ' + JSON.stringify(failedConfig));

    await setConfig({ managedPayments: true, fail: false, hold: true });
    await page.goto(base + '/terms.html', { waitUntil: 'domcontentloaded' });
    expectSeller(await renderedSeller(page), 'direct', 'terms.html');
    await page.goto(base + '/refunds.html', { waitUntil: 'domcontentloaded' });
    expectSeller(await renderedSeller(page), 'direct', 'refunds.html');
    await page.goto(base + '/index.html#pricing', { waitUntil: 'domcontentloaded' });
    const pendingConfig = await page.evaluate(() => document.documentElement.getAttribute('data-checkout-config'));
    if (pendingConfig) throw new Error('checkout config settled before the request returned: ' + pendingConfig);
    expectSeller(await renderedSeller(page), 'direct', 'index');
    await page.click('#pro-consent');
    const heldDisabled = await page.$eval('[data-checkout="pro"]', (el) => el.disabled);
    if (!heldDisabled) throw new Error('Start Pro enabled before checkout config settled');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-checkout-config') === 'direct', { timeout: 5000 });
    const afterTimeout = await page.$eval('[data-checkout="pro"]', (el) => !el.disabled && document.getElementById('pro-consent').checked);
    if (!afterTimeout) throw new Error('Pay stayed disabled after the 3 second direct fallback');
    await setConfig({ managedPayments: true, fail: false, hold: false, release: true });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-checkout-config') === 'mp');
    const resetConsent = await page.evaluate(() => !document.getElementById('pro-consent').checked && document.querySelector('[data-checkout="pro"]').disabled);
    if (!resetConsent) throw new Error('managed-payments config did not clear consent after the direct fallback');
    expectSeller(await renderedSeller(page), 'mp', 'index');
    await page.goto(base + '/terms.html', { waitUntil: 'networkidle0' });
    expectSeller(await renderedSeller(page), 'mp', 'terms.html');
    await page.goto(base + '/refunds.html', { waitUntil: 'networkidle0' });
    expectSeller(await renderedSeller(page), 'mp', 'refunds.html');
    await page.goto(base + '/privacy.html', { waitUntil: 'networkidle0' });
    expectSeller(await renderedSeller(page), 'mp', 'privacy.html');

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
