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
const pages = ['index.html', 'upload.html', '404.html', 'privacy.html', 'terms.html', 'refunds.html', 'support.html', 'cancel/index.html'];
const CONSENT = 'Yes, text me at this number. I agree to receive support replies and order/manual-status texts from ManualOS (Op3x LLC). Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel. Consent is not a condition of purchase. See Terms (/terms.html#sms) and Privacy (/privacy.html#sms).';

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
    if (!html[name].includes('<span data-mailing-address>Email support@manualos.com for our mailing address.</span>')) {
      throw new Error(name + ' missing the mailing-address fallback');
    }
    if (/\[MAILING ADDRESS\]|\[EFFECTIVE DATE\]/.test(html[name])) throw new Error(name + ' still uses an old placeholder');
  }
  const retiredStreet = '250 ' + String.fromCharCode(84, 114, 101, 110, 116);
  const retiredZip = String.fromCharCode(54, 49, 49, 49, 49);
  for (const name of pages) {
    if (html[name].includes('[OP3X MAILING ADDRESS]') || html[name].includes(retiredStreet) || html[name].includes(retiredZip)) {
      throw new Error(name + ' still contains a mailing-address placeholder or a retired street address');
    }
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
    "If we can't read your files, or the run ends in an error, it doesn't use a credit.",
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
  const creditLine = "If we can't read your files, or the run ends in an error, it doesn't use a credit.";
  if ((html['index.html'].split(creditLine).length - 1) < 2) throw new Error('homepage credit line missing from the FAQ or JSON-LD');
  if (!html['terms.html'].includes('the credits and access from that purchase end.')) throw new Error('terms missing access-ends sentence');
  const chargeback = "Chargebacks and payment disputes: access is suspended while a dispute is open, restored if it's decided in ManualOS's favor, and permanently revoked for the disputed purchase if ManualOS loses it. A dispute doesn't stop you from buying from us again, but we may decline a purchase if we reasonably suspect fraud or abuse.";
  for (const name of ['terms.html', 'refunds.html']) {
    const plain = html[name].replace(/<[^>]+>/g, '');
    if (!plain.includes(chargeback)) throw new Error(name + ' missing chargeback rule');
    if (!html[name].includes('<strong>Chargebacks and payment disputes:</strong>')) throw new Error(name + ' chargeback label changed');
  }
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
  const kept = 'Uploaded files are processed in memory and deleted when the job finishes, including a job that fails.';
  if (!html['privacy.html'].includes(temp) || !html['privacy.html'].includes(kept)) throw new Error('privacy missing temporary-storage retention wording');
  const pdfRetention = 'It is stored on our server for 24 hours so you can download it, then deleted; backup copies are deleted within 28 days.';
  if ((html['privacy.html'].split(pdfRetention).length - 1) !== 3) throw new Error('privacy missing 24-hour PDF line');
  if (!html['support.html'].includes('backend PR #8')) throw new Error('support script missing backend PR #8 note');
  if (/team seats/i.test(html['terms.html'] + html['privacy.html'])) throw new Error('team seats were invented');
  if (/at any hour/.test(Object.values(html).join('\n'))) throw new Error('an at-any-hour line is still present');
  const turnaround = 'Approved refunds are processed within 5 business days. Your bank may take 5–10 business days to show the credit.';
  const renewalNotice = 'If you bought before these refund limits applied, the new terms apply from your next renewal, and we will email you at least 14 days before that renewal.';
  const firstRenewal = 'Changes apply from your first renewal at least 14 days after we email you about them.';
  const venue = 'Disputes are brought in the state or federal courts serving Winnebago County, Illinois, and you and we consent to their jurisdiction. Either party may bring an individual claim in small-claims court.';
  const deployDateNote = 'The effective date is filled with the production deploy date when this page is merged.';
  const effectiveDateJs = await read('effective-date.js');
  const effectiveTokenCount = (effectiveDateJs.match(/\[\[EFFECTIVE_DATE\]\]/g) || []).length;
  if (effectiveTokenCount !== 1) throw new Error('effective date is not a single edit (' + effectiveTokenCount + ')');
  if (!effectiveDateJs.includes(deployDateNote)) throw new Error('effective-date.js is not marked as the merge edit');
  const mailingConst = "var OP3X_MAILING_ADDRESS = '[OP3X MAILING ADDRESS]';";
  if (effectiveDateJs.split(mailingConst).length - 1 !== 1) throw new Error('mailing address is not one constant in effective-date.js');
  if (!effectiveDateJs.includes("querySelectorAll('[data-mailing-address]')")) throw new Error('mailing address is not rendered into the legal pages');
  if (!await read('dev/check-effective-date.mjs').then((text) => text.includes('[[EFFECTIVE_DATE]]') && text.includes('process.exit(1)'))) {
    throw new Error('effective-date check does not fail while the token remains');
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
  if (!html['terms.html'].includes('ManualOS (Op3x LLC)') || !html['privacy.html'].includes('ManualOS (Op3x LLC)')) {
    throw new Error('SMS copy is missing ManualOS (Op3x LLC)');
  }
  const smsNeed = ['support replies', 'order/manual-status texts', 'Message frequency varies', 'Msg &amp; data rates may apply', 'Reply STOP to opt out', 'Reply HELP for help', 'support@manualos.com', 'Mobile numbers and SMS opt-in consent are not shared with or sold to third parties or affiliates for marketing'];
  if (/account alerts/.test(html['support.html'] + html['privacy.html'] + html['terms.html'])) {
    throw new Error('account alerts is still promised');
  }
  const cancelCopy = 'You can cancel online, self-serve, from our <a href="/cancel">Manage plan</a> link.';
  const mpCancel = 'You can manage or cancel your subscription online at the reseller\'s order-management site, <a href="https://app.link.com">app.link.com</a>. That is a full online alternative.';
  if (!html['terms.html'].includes(cancelCopy) || !html['refunds.html'].includes(cancelCopy)) throw new Error('online cancel link missing');
  if (!html['terms.html'].includes('<p data-mp-section hidden>' + mpCancel) || !html['refunds.html'].includes('<p data-mp-section hidden>' + mpCancel)) {
    throw new Error('managed-payments cancel alternative is missing');
  }
  const emailBackup = '<p><strong>Email backup.</strong> If you cannot use an online option, email <a href="mailto:support@manualos.com?subject=Cancel%20my%20ManualOS%20Pro%20subscription">support@manualos.com</a> and we will cancel it for you.</p>';
  for (const name of ['terms.html', 'refunds.html']) {
    const portalAt = html[name].indexOf(cancelCopy);
    const mpAt = html[name].indexOf('<p data-mp-section hidden>' + mpCancel);
    const emailAt = html[name].indexOf(emailBackup);
    if (portalAt < 0 || mpAt < 0 || emailAt < 0 || !(portalAt < mpAt && mpAt < emailAt)) {
      throw new Error(name + ' cancel order is not portal, then link.com, then email backup');
    }
  }
  const cancelPage = html['cancel/index.html'];
  const cancelFormAt = cancelPage.indexOf('id="cancel-form"');
  const cancelLeadAt = cancelPage.indexOf('id="mp-cancel-lead"');
  if (cancelFormAt < 0 || cancelLeadAt < 0 || cancelFormAt > cancelLeadAt || !cancelPage.includes(mpCancel)) {
    throw new Error('cancel page does not put the portal form before app.link.com');
  }
  if (cancelPage.includes('Request received')) throw new Error('cancel page still says Request received');
  if (!cancelPage.includes("var ACCESS_LINK_PATH = '/access-link'")) throw new Error('access-link path missing');
  if (!cancelPage.includes('Check your email for a secure link to manage or cancel your plan.')) throw new Error('access-link confirmation missing');
  if (!cancelPage.includes('Online cancellation is temporarily unavailable. Please try again shortly.')) throw new Error('access-link failure copy missing');
  if (!cancelPage.includes('Enter a valid email address.')) throw new Error('invalid-email copy missing');
  if (!cancelPage.includes('Too many requests. Try again later.')) throw new Error('rate-limit copy missing');
  if (!cancelPage.includes('<strong>Email backup.</strong>')) throw new Error('email backup is not labeled');
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
  const homepageLine = "To write your manual, we send content extracted from your files, such as program logic, comments, and part details, to a third-party service provider that helps write the manual. We delete your uploaded files when the job finishes. Download your PDF right away. You can re-download it for 24 hours after it's made, and then it's deleted. Our provider deletes what we send it within 30 days, unless it must keep it longer to enforce its usage policy or comply with the law. Full details are in our Privacy Policy.";
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
  const readyCard = "Your PDF is ready. Download it right away. You can re-download it for 24 hours after it's made, and then it's deleted.";
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
  const resellerNote = 'Your purchase is processed by our authorized reseller, which is the merchant of record. ManualOS is provided by Op3x LLC.';
  const statementLine = 'Appears on your card statement as LINK.COM* MANUALOS';
  const mpSeller = 'Link is the reseller and the merchant of record. Link processes payments and refunds, and Link handles payment disputes. Link may still refund a purchase within its own refund window.';
  const autoRenew = 'Renews automatically at $79 plus applicable taxes each month until you cancel at <a href="/cancel">manualos.com/cancel</a>.';
  const privacyMp = 'Link collects payment and billing details as the merchant of record under its own privacy policy.';
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
  if (!html['privacy.html'].includes(smsRecords)) throw new Error('privacy missing SMS records sentence');
  if (/until you opt out or ask us to delete it/.test(html['privacy.html'])) throw new Error('old SMS retention sentence remains');
  if (/<strong>\s*Open items\./.test(html['privacy.html'] + html['terms.html'] + html['refunds.html'])) throw new Error('Open items box is still visible');
  if (!html['privacy.html'].includes('<p data-mp-section hidden>' + privacyMp + '</p>')) throw new Error('privacy missing Link merchant-of-record sentence');
  const aiRetention = 'Our AI model provider deletes the text we send it, and what it returns, within 30 days, unless it must keep it longer to enforce its usage policy or to comply with the law.';
  const emailShare = 'an email provider, to receive and answer support emails';
  const toolShare = 'automated tools, including AI assistants, that help us run and support the service; they access your information only to do that work.';
  if (!html['privacy.html'].includes(aiRetention)) throw new Error('privacy AI retention line does not match the provider terms');
  if ((html['privacy.html'].match(new RegExp(aiRetention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length < 2) throw new Error('privacy AI retention line is missing from processing or retention');
  if (/It deletes the data within 30 days|usage policies/.test(html['privacy.html'])) throw new Error('old AI retention line remains');
  if (!html['privacy.html'].includes(emailShare) || !html['privacy.html'].includes(toolShare)) throw new Error('privacy sharing list is missing the email provider or automated tools');
  if (html['index.html'].includes(aiRetention) || html['index.html'].includes(emailShare) || html['index.html'].includes(toolShare)) throw new Error('privacy-only sharing or retention copy is on the homepage');
  if (/\bLink\b|LINK\.COM|Stripe/.test(configJs)) throw new Error('checkout config script names a provider');
  if (!indexMarkup.includes('data-seller-direct>Op3x LLC to charge my card $79')) throw new Error('variant (a) checkbox is missing');
  if (!indexMarkup.includes('data-seller-mp hidden>ManualOS\'s authorized reseller to charge my card $79 plus applicable taxes')) throw new Error('reseller checkbox is not hidden by default');
  if (!indexMarkup.includes('id="pro-auto-renew">' + autoRenew)) throw new Error('pro auto-renewal disclosure is not beside Pay');
  if (!indexMarkup.includes('data-seller-note hidden>' + resellerNote)) throw new Error('reseller disclosure is not hidden by default');
  if ((indexMarkup.match(/data-statement hidden>Appears on your card statement as LINK\.COM\* MANUALOS/g) || []).length !== 2) throw new Error('statement line is missing beside a buy button');
  if (/will appear on your card statement/.test(html['index.html'])) throw new Error('old card-statement clause is still in the disclosure');
  if (/plus applicable tax(?!es)/.test(html['index.html'])) throw new Error('checkout still says applicable tax');
  if (!indexMarkup.includes('$39 one time for 3 manuals, plus applicable taxes. Refundable within 30 days if no manual has been delivered.')) throw new Error('starter disclosure missing');
  if (!html['index.html'].includes('Starter $39 once · 3 manuals. Pro $79 a month · unlimited. Plus applicable taxes.')) throw new Error('homepage pricing line missing taxes');
  if (!html['index.html'].includes('One-time purchase of 3 manuals, plus applicable taxes.')) throw new Error('starter offer description missing taxes');
  if (!html['index.html'].includes('Monthly subscription with unlimited manuals, plus applicable taxes.')) throw new Error('pro offer description missing taxes');
  for (const name of pages) {
    if (/\$39|\$79/.test(html[name]) && !/tax/i.test(html[name])) throw new Error(name + ' states a price without tax');
  }
  if (/\$249|\$2,490|Start Integrator|integrator-consent/.test(html['index.html'])) throw new Error('homepage still sells Integrator');
  for (const name of ['terms.html', 'refunds.html']) {
    if (!html[name].includes('<p data-direct-section>' + directSeller + '</p>')) throw new Error(name + ' missing direct seller section');
    if (!html[name].includes('<p data-mp-section hidden>' + mpSeller)) throw new Error(name + ' missing hidden merchant-of-record section');
  }
  if (!html['cancel/index.html'].includes("var BILLING_PORTAL_PATH = '/billing-portal'")) {
    throw new Error('billing portal path constant missing');
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
  for (const name of ['privacy.html', 'terms.html']) {
    for (const phrase of smsNeed) {
      if (!html[name].includes(phrase)) throw new Error(name + ' missing SMS phrase: ' + phrase);
    }
  }
  if (!html['support.html'].includes(CONSENT)) throw new Error('consentText constant is not the backend v3 label');
  if (!html['support.html'].includes('consentText: CONSENT_TEXT')) throw new Error('consent POST does not send consentText');
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
    if (posted[0].phone !== '(217) 555-0199' || posted[0].consentTextVersion !== 'support-sms-v3' || posted[0].consentText !== CONSENT || posted[0].source !== 'website-support-form') {
      throw new Error('consent body ' + JSON.stringify(posted[0]));
    }
    if (posted[0].fields.join(',') !== 'phone,consentTextVersion,consentText,source') throw new Error('consent keys ' + posted[0].fields.join(','));
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
        sellerHidden: document.getElementById('pro-seller-note').hidden,
        statementHidden: document.getElementById('pro-statement').hidden,
        statement: document.getElementById('pro-statement').textContent,
        directHidden: label.querySelector('[data-seller-direct]').hidden,
        mpHidden: label.querySelector('[data-seller-mp]').hidden,
        label: label.textContent.replace(/\s+/g, ' ').trim(),
        renewal: document.getElementById('pro-auto-renew').textContent.replace(/\s+/g, ' ').trim(),
        renewalNextToPay: document.getElementById('pro-auto-renew').nextElementSibling === document.querySelector('[data-checkout="pro"]'),
        renewalNextToConsent: document.getElementById('pro-auto-renew').previousElementSibling === document.getElementById('pro-consent').closest('.consent-row'),
      };
    });
    if (!proGate.tied || proGate.checked || !proGate.buttonDisabled || proGate.sellerHidden || proGate.statementHidden || !proGate.directHidden || proGate.mpHidden) {
      throw new Error('pro consent gate ' + JSON.stringify(proGate));
    }
    if (proGate.statement !== 'Appears on your card statement as LINK.COM* MANUALOS') throw new Error('statement ' + proGate.statement);
    if (proGate.outlineStyle === 'none' || !(proGate.outlineWidth > 0)) throw new Error('pro checkbox focus is not visible ' + JSON.stringify(proGate));
    if (!proGate.label.includes("ManualOS's authorized reseller to charge my card $79 plus applicable taxes each month")) {
      throw new Error('pro label ' + proGate.label);
    }
    if (proGate.renewal !== 'Renews automatically at $79 plus applicable taxes each month until you cancel at manualos.com/cancel.' || !proGate.renewalNextToPay || !proGate.renewalNextToConsent) {
      throw new Error('pro auto-renewal disclosure ' + JSON.stringify(proGate));
    }
    await page.focus('#pro-consent');
    await page.keyboard.press('Space');
    const proEnabled = await page.$eval('[data-checkout="pro"]', (el) => !el.disabled && document.getElementById('pro-consent').checked);
    if (!proEnabled) throw new Error('keyboard did not enable Start Pro');
    const beforeCheckout = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').length;
    await page.click('[data-checkout="pro"]');
    await page.waitForFunction(() => location.pathname.endsWith('/upload.html'));
    const checkout = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').slice(beforeCheckout);
    if (checkout.length !== 1 || checkout[0].status !== 200) throw new Error('checkout response ' + JSON.stringify(checkout));
    if (checkout[0].plan !== 'pro' || checkout[0].renewalConsent !== true || checkout[0].termsAccepted !== true || checkout[0].termsConsent !== undefined || checkout[0].termsVersion !== 'terms-rev-a-m2' || checkout[0].disclosureVersion !== 'pro-renew-b2-mp' || !checkout[0].fields.includes('termsAccepted') || checkout[0].fields.includes('termsConsent')) {
      throw new Error('checkout body ' + JSON.stringify(checkout[0]));
    }

    await page.goto(base + '/index.html#pricing', { waitUntil: 'networkidle0' });
    const starterDisabled = await page.$eval('[data-checkout="starter"]', (el) => el.disabled);
    if (!starterDisabled) throw new Error('starter button starts enabled');
    await page.click('#starter-consent');
    await page.click('[data-checkout="starter"]');
    await page.waitForFunction(() => location.pathname.endsWith('/upload.html'));
    const starter = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/create-checkout-session').pop();
    if (starter.plan !== 'starter' || starter.renewalConsent !== false || starter.termsAccepted !== true || starter.termsConsent !== undefined || starter.disclosureVersion !== 'starter-disclosure-b2-mp' || starter.fields.includes('termsConsent')) {
      throw new Error('starter body ' + JSON.stringify(starter));
    }

    await page.goto(base + '/cancel/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    const portalOrder = await page.evaluate(() => {
      const form = document.getElementById('cancel-form');
      const lead = document.getElementById('mp-cancel-lead');
      const mail = document.getElementById('email-backup');
      return {
        leadHidden: lead.hidden,
        leadText: lead.textContent.replace(/\s+/g, ' ').trim(),
        formBeforeLead: Boolean(form.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING),
        leadBeforeEmail: Boolean(lead.compareDocumentPosition(mail) & Node.DOCUMENT_POSITION_FOLLOWING),
        backup: mail.textContent.replace(/\s+/g, ' ').trim(),
      };
    });
    if (portalOrder.leadHidden || !portalOrder.formBeforeLead || !portalOrder.leadBeforeEmail || !portalOrder.backup.startsWith('Email backup.') || !portalOrder.leadText.startsWith('You can manage or cancel your subscription online at the reseller\'s order-management site, app.link.com.')) {
      throw new Error('cancel page does not put the portal form first ' + JSON.stringify(portalOrder));
    }
    const beforeCancelPosts = await fetch(base + '/__mock/requests').then((res) => res.json());
    const beforePortal = beforeCancelPosts.filter((item) => item.path === '/billing-portal').length;
    const beforeAccess = beforeCancelPosts.filter((item) => item.path === '/access-link').length;
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-error').textContent === 'Enter the email you used at checkout.');
    const earlyPosts = await fetch(base + '/__mock/requests').then((res) => res.json());
    const earlyPortal = earlyPosts.filter((item) => item.path === '/billing-portal').slice(beforePortal);
    const earlyAccess = earlyPosts.filter((item) => item.path === '/access-link').slice(beforeAccess);
    if (earlyPortal.length || earlyAccess.length) throw new Error('cancel posted without an email or checkout reference');
    await page.type('#cancel-email', 'buyer@example.com');
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-status-text').textContent === 'Check your email for a secure link to manage or cancel your plan.');
    const accessLink = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/access-link').pop();
    if (!accessLink || accessLink.status !== 202 || accessLink.email !== 'buyer@example.com' || accessLink.fields.join(',') !== 'email') {
      throw new Error('access-link body ' + JSON.stringify(accessLink));
    }
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, accessFail: true }),
    });
    await page.goto(base + '/cancel/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.type('#cancel-email', 'buyer@example.com');
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-error').textContent === 'Online cancellation is temporarily unavailable. Please try again shortly.');
    const accessFailed = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/access-link').pop();
    if (!accessFailed || accessFailed.status !== 500) throw new Error('access-link failure ' + JSON.stringify(accessFailed));
    const accessBackup = await page.$eval('#email-backup', (el) => el.textContent.includes('Email backup.'));
    if (!accessBackup) throw new Error('email backup missing after access-link failure');
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, accessFail: false, accessStatus: 400, portalStatus: 0 }),
    });
    await page.goto(base + '/cancel/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.type('#cancel-email', 'buyer@example.com');
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-error').textContent === 'Enter a valid email address.');
    const accessInvalid = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/access-link').pop();
    if (!accessInvalid || accessInvalid.status !== 400 || accessInvalid.email !== 'buyer@example.com') throw new Error('access-link 400 ' + JSON.stringify(accessInvalid));
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, accessFail: false, accessStatus: 429, portalStatus: 0 }),
    });
    await page.goto(base + '/cancel/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.type('#cancel-email', 'buyer@example.com');
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-error').textContent === 'Too many requests. Try again later.');
    const accessLimited = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/access-link').pop();
    if (!accessLimited || accessLimited.status !== 429) throw new Error('access-link 429 ' + JSON.stringify(accessLimited));
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, accessFail: false, accessStatus: 0, portalStatus: 0 }),
    });
    await page.goto(base + '/cancel/?session_id=cs_test_pro', { waitUntil: 'networkidle0' });
    await page.click('#cancel-submit');
    await page.waitForFunction(() => location.pathname.endsWith('/refunds.html'));
    const linked = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/billing-portal').pop();
    if (!linked || linked.session_id !== 'cs_test_pro' || linked.fields.join(',') !== 'session_id') throw new Error('portal body ' + JSON.stringify(linked));
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, portalFail: true, portalStatus: 0, accessStatus: 0 }),
    });
    await page.goto(base + '/cancel/?session_id=cs_test_pro', { waitUntil: 'networkidle0' });
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-error').textContent === 'Online cancellation is temporarily unavailable. Please try again shortly.');
    const failedPortal = await page.evaluate(() => {
      const form = document.getElementById('cancel-form');
      const lead = document.getElementById('mp-cancel-lead');
      const mail = document.getElementById('email-backup');
      const error = document.getElementById('cancel-error').textContent;
      return {
        leadHidden: lead.hidden,
        formBeforeLead: Boolean(form.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING),
        backup: mail.textContent.includes('Email backup.'),
        requestReceived: document.body.textContent.includes('Request received'),
        error,
      };
    });
    if (failedPortal.leadHidden || !failedPortal.formBeforeLead || !failedPortal.backup || failedPortal.requestReceived || failedPortal.error !== 'Online cancellation is temporarily unavailable. Please try again shortly.') {
      throw new Error('portal failure fell back to email only ' + JSON.stringify(failedPortal));
    }
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, portalFail: false, portalStatus: 400, accessStatus: 0 }),
    });
    await page.goto(base + '/cancel/?session_id=cs_test_expired', { waitUntil: 'networkidle0' });
    const beforeExpired = await fetch(base + '/__mock/requests').then((res) => res.json());
    const beforeExpiredAccess = beforeExpired.filter((item) => item.path === '/access-link').length;
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-error').textContent === 'Enter the email you used at checkout.');
    const expiredPortal = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/billing-portal').pop();
    const expiredAccess = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/access-link').slice(beforeExpiredAccess);
    if (!expiredPortal || expiredPortal.status !== 400 || expiredPortal.session_id !== 'cs_test_expired' || expiredAccess.length) {
      throw new Error('expired portal did not ask for the checkout email ' + JSON.stringify({ expiredPortal, expiredAccess }));
    }
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, portalFail: false, portalStatus: 429, accessStatus: 0 }),
    });
    await page.goto(base + '/cancel/?session_id=cs_test_limited', { waitUntil: 'networkidle0' });
    const beforeLimited = await fetch(base + '/__mock/requests').then((res) => res.json());
    const beforeLimitedAccess = beforeLimited.filter((item) => item.path === '/access-link').length;
    await page.click('#cancel-submit');
    await page.waitForFunction(() => document.getElementById('cancel-error').textContent === 'Too many requests. Try again later.');
    const limitedPortal = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/billing-portal').pop();
    const limitedAccess = (await fetch(base + '/__mock/requests').then((res) => res.json())).filter((item) => item.path === '/access-link').slice(beforeLimitedAccess);
    if (!limitedPortal || limitedPortal.status !== 429 || limitedAccess.length) {
      throw new Error('portal 429 chained another request ' + JSON.stringify({ limitedPortal, limitedAccess }));
    }
    await fetch(base + '/__mock/checkout-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedPayments: true, fail: false, hold: false, portalFail: false, portalStatus: 0, accessStatus: 0 }),
    });

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
      const reseller = "Your purchase is processed by our authorized reseller, which is the merchant of record. ManualOS is provided by Op3x LLC.";
      const statement = 'Appears on your card statement as LINK.COM* MANUALOS';
      const mpOn = mode === 'mp';
      if (where === 'index') {
        if (state.note !== mpOn || state.statement !== mpOn || state.mpCharge !== mpOn || state.directCharge !== !mpOn) {
          throw new Error(where + ' ' + mode + ' visibility ' + JSON.stringify(state));
        }
        const renewalLine = 'Renews automatically at $79 plus applicable taxes each month until you cancel at manualos.com/cancel.';
        if (!state.text.includes(renewalLine)) throw new Error(where + ' missing auto-renewal disclosure');
        if (mpOn && (!state.text.includes(reseller) || !state.text.includes(statement) || !state.text.includes("ManualOS's authorized reseller to charge my card $79 plus applicable taxes each month") || !state.text.includes('That is a full online alternative.'))) {
          throw new Error(where + ' mp copy missing ' + state.text.slice(0, 400));
        }
        if (!mpOn && (state.text.includes('link.com') || state.text.includes('authorized reseller') || state.text.includes('LINK.COM') || /\bLink\b/.test(state.text))) {
          throw new Error(where + ' leaked reseller copy');
        }
        if (!mpOn && !state.text.includes('Op3x LLC to charge my card $79')) throw new Error(where + ' missing direct charge');
      } else if (where === 'privacy.html') {
        const sentence = 'Link collects payment and billing details as the merchant of record under its own privacy policy.';
        if (state.mpSection !== mpOn) throw new Error(where + ' ' + mode + ' sections ' + JSON.stringify(state));
        if (!state.text.includes('Our payment processor handles checkout, cards, receipts, and subscriptions under its own privacy policy.')) {
          throw new Error(where + ' dropped the direct processor wording');
        }
        if (mpOn && !state.text.includes(sentence)) throw new Error(where + ' mp section missing');
        if (!mpOn && (state.text.includes(sentence) || /\bLink\b/.test(state.text))) throw new Error(where + ' leaked Link');
      } else {
        if (state.mpSection !== mpOn || state.directSection !== !mpOn) throw new Error(where + ' ' + mode + ' sections ' + JSON.stringify(state));
        if (mpOn && (!state.text.includes('Link is the reseller and the merchant of record') || !state.text.includes('Link may still refund a purchase within its own refund window') || !state.text.includes('That is a full online alternative.'))) {
          throw new Error(where + ' mp section missing');
        }
        if (!mpOn && (state.text.includes('link.com') || state.text.includes('Link is the seller') || /\bLink\b/.test(state.text))) throw new Error(where + ' leaked Link');
        if (mpOn && state.text.includes('Op3x LLC is the seller')) throw new Error(where + ' still shows the direct seller');
        if (!mpOn && !state.text.includes('Op3x LLC is the seller of ManualOS')) throw new Error(where + ' missing direct seller');
      }
      if (where === 'privacy.html' || where === 'terms.html' || where === 'refunds.html') {
        const mailingFallback = 'Email support@manualos.com for our mailing address.';
        const retiredStreet = '250 ' + String.fromCharCode(84, 114, 101, 110, 116);
        const retiredZip = String.fromCharCode(54, 49, 49, 49, 49);
        if (!state.text.includes(mailingFallback) || state.text.includes('[OP3X MAILING ADDRESS]') || state.text.includes(retiredStreet) || state.text.includes(retiredZip)) {
          throw new Error(where + ' mailing address is not the fallback');
        }
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
    if (!directCheckout || directCheckout.termsAccepted !== true || directCheckout.termsConsent !== undefined || directCheckout.disclosureVersion !== 'pro-renew-b2-direct') throw new Error('direct checkout ' + JSON.stringify(directCheckout));

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
    await page.waitForFunction(() => document.getElementById('pro-seller-note') && !document.getElementById('pro-seller-note').hidden);
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
