// Headless check for upload.html against dev/mock-api.mjs.
// Requires puppeteer-core and Chrome. Does not call production or Stripe.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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
const results = [];

function note(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
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
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, y: window.scrollY }));
    const inView = box.y < view.h && box.y + box.height > 0;
    if (!inView) throw new Error(`${name} at ${viewport.width}px is outside the viewport`);
  }
  await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
}

async function openUpload(page, base, query) {
  await page.goto(`${base}/upload.html${query || '?session_id=cs_test_local'}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => {
    const phase = document.body.dataset.phase;
    return phase === 'ready' || phase === 'success';
  }, { timeout: 8000 });
  if (await page.evaluate(() => document.body.dataset.phase === 'success')) {
    await page.click('#another-btn');
    await page.waitForFunction(() => document.body.dataset.phase === 'ready', { timeout: 8000 });
  }
}

async function addFile(page, filePath) {
  const input = await page.$('#file-input');
  await input.uploadFile(filePath);
  await page.evaluate(() => {
    const input = document.getElementById('file-input');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => !document.getElementById('file-input').dataset.pending);
}

async function waitPhase(page, phase) {
  await page.waitForFunction((expected) => document.body.dataset.phase === expected, { timeout: 15000 }, phase);
}

  async function requests(base) {
  const res = await fetch(base + '/__mock/requests');
  return res.json();
}

const axePath = '/tmp/manualos-test/node_modules/axe-core/axe.min.js';
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
  note('axe 0 violations: ' + label, true);
}

async function assertButtonContrast(page, label) {
  const bad = await page.evaluate(() => {
    function parse(c) {
      const m = String(c).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      if (p.length < 3) return null;
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    function bgOf(el) {
      let node = el;
      while (node) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0.05) return c;
        node = node.parentElement;
      }
      return null;
    }
    const nodes = [...document.querySelectorAll('a.btn, button, .btn-primary, .btn-outline, .file-remove')];
    const problems = [];
    for (const el of nodes) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 2 || rect.height < 2) continue;
      const fg = parse(style.color);
      const bg = bgOf(el);
      if (!fg || !bg || fg.a === 0) continue;
      if (Math.round(fg.r) === Math.round(bg.r) && Math.round(fg.g) === Math.round(bg.g) && Math.round(fg.b) === Math.round(bg.b)) {
        problems.push((el.innerText || el.className || el.id || 'button').replace(/\s+/g, ' ').trim().slice(0, 60));
      }
    }
    return problems;
  });
  if (bad.length) throw new Error(label + ' button text matches its background: ' + bad.join('; '));
  note('button text colour differs from its background: ' + label, true);
}

function fakeZip(uncompressed) {
  const name = Buffer.from('a.txt');
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt32LE(uncompressed >>> 0, 24);
  cd.writeUInt16LE(name.length, 28);
  name.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([cd, eocd]);
}

async function main() {
  await mkdir(shotDir, { recursive: true });
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'manualos-files-'));
  const fixtures = {
    line: path.join(fixtureDir, 'line.L5X'),
    step: path.join(fixtureDir, 'model.step'),
    hold: path.join(fixtureDir, 'hold.L5X'),
    gx3: path.join(fixtureDir, 'project.gx3'),
    cxp: path.join(fixtureDir, 'machine.cxp'),
    zap: path.join(fixtureDir, 'archive.zap15'),
    big: path.join(fixtureDir, 'big.L5X'),
    empty: path.join(fixtureDir, 'empty.L5X'),
    unknown: path.join(fixtureDir, 'unknown.L5X'),
    down: path.join(fixtureDir, 'down.L5X'),
    fail: path.join(fixtureDir, 'fail.L5X'),
    nocredit: path.join(fixtureDir, 'nocredit.L5X'),
    legacy: path.join(fixtureDir, 'legacy.L5X'),
    drop: path.join(fixtureDir, 'drop.L5X'),
    legacyStep: path.join(fixtureDir, 'legacy.step'),
    exp: path.join(fixtureDir, 'routine.exp'),
    zip: path.join(fixtureDir, 'drawings.zip'),
    long: path.join(fixtureDir, 'VeryLongProgramNameForTheMobileFileListCheck.L5X'),
    over: path.join(fixtureDir, 'overlimit.L5X'),
    limit: path.join(fixtureDir, 'limit.L5X'),
    copy: path.join(fixtureDir, 'copy.L5X'),
    zero: path.join(fixtureDir, 'zero.L5X'),
    fat: path.join(fixtureDir, 'fat.zip'),
    huge: path.join(fixtureDir, 'huge.L5X'),
    blank: path.join(fixtureDir, 'blank.L5X'),
    many: path.join(fixtureDir, 'many.L5X'),
    twin: path.join(fixtureDir, 'twin.L5X'),
    again: path.join(fixtureDir, 'again.L5X'),
  };
  await writeFile(fixtures.line, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.step, 'ISO-10303-21;\n');
  await writeFile(fixtures.hold, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.gx3, 'gx');
  await writeFile(fixtures.cxp, 'cx');
  await writeFile(fixtures.zap, 'zap');
  await writeFile(fixtures.big, Buffer.alloc(25 * 1024 * 1024 + 1, 1));
  await writeFile(fixtures.empty, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.unknown, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.down, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.fail, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.nocredit, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.legacy, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.drop, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.legacyStep, 'ISO-10303-21;\n');
  await writeFile(fixtures.exp, 'PROGRAM Main\nEND_PROGRAM');
  await writeFile(fixtures.zip, 'PK');
  await writeFile(fixtures.long, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.over, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.limit, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.copy, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.zero, Buffer.alloc(0));
  await writeFile(fixtures.fat, fakeZip(100 * 1024 * 1024 + 1));
  await writeFile(fixtures.huge, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.blank, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.many, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.twin, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.again, '<RSLogix5000Content></RSLogix5000Content>');
  const manyFiles = [];
  for (let i = 0; i < 26; i += 1) {
    const file = path.join(fixtureDir, `batch-${i}.L5X`);
    await writeFile(file, `<RSLogix5000Content>${i}</RSLogix5000Content>`);
    manyFiles.push(file);
  }

  const html = await readFile(path.join(root, 'upload.html'), 'utf8');
  const index = await readFile(path.join(root, 'index.html'), 'utf8');
  const acceptValues = [...html.matchAll(/accept="([^"]*)"/g)].map((match) => match[1]);
  if (acceptValues.some((value) => /gx3|cxp|zap15/i.test(value))) throw new Error('accept attribute still lists a removed type');
  if (/Mitsubishi GX Works|CX-Programmer|\.gx3|\.cxp|\.zap15/i.test(index)) {
    throw new Error('homepage still claims a removed format');
  }
  note('copy has no supported-format claim for gx3, cxp, or zap15', true);
  const exportHits = [];
  const titleTag = (index.match(/<title>[^<]*<\/title>/) || [''])[0];
  if (/export/i.test(titleTag)) exportHits.push(titleTag);
  for (const tag of index.match(/<meta\b[^>]*>/g) || []) {
    if (/export/i.test(tag) && /description|og:|twitter:/.test(tag)) exportHits.push(tag.slice(0, 160));
  }
  for (const desc of index.match(/"description":\s*"[^"]*"/g) || []) {
    if (/export/i.test(desc)) exportHits.push(desc.slice(0, 160));
  }
  const footer = index.slice(index.indexOf('<footer'), index.indexOf('</footer>'));
  if (/export/i.test(footer)) exportHits.push('footer');
  const heroStart = index.indexOf('id="hero-title"');
  const heroEnd = index.indexOf('class="fan"', heroStart);
  if (/export/i.test(index.slice(heroStart, heroEnd))) exportHits.push('hero');
  if (exportHits.length) throw new Error('export wording remains: ' + exportHits.join(' | '));
  const starterButtons = (index.match(/data-checkout="starter"/g) || []).length;
  const proButtons = (index.match(/data-checkout="pro"/g) || []).length;
  if (starterButtons !== 1 || proButtons !== 1) throw new Error('checkout buttons starter=' + starterButtons + ' pro=' + proButtons);
  note('headline surfaces do not say export, and each plan has one checkout button', true);
  await assertNoBrandNames(root);
  note('shipped HTML and JS do not name vendors', true);
  const copyright = '© 2026 Op3x LLC. ManualOS is a product of Op3x LLC.';
  for (const name of ['index.html', 'upload.html', '404.html']) {
    const pageHtml = name === 'index.html' ? index : await readFile(path.join(root, name), 'utf8');
    const footStart = pageHtml.indexOf('<footer');
    const footEnd = pageHtml.indexOf('</footer>');
    const foot = pageHtml.slice(footStart, footEnd);
    if (!foot.includes(copyright)) throw new Error(name + ' footer copyright');
    for (const href of ['mailto:support@manualos.com', '/terms.html', '/privacy.html', '/refunds.html']) {
      if (!foot.includes(href)) throw new Error(name + ' footer missing ' + href);
    }
    if (/sitemap\.xml/i.test(foot)) throw new Error(name + ' footer still links the sitemap');
    const credits = pageHtml.match(/Hero video created with Grok\./g) || [];
    if (name === 'index.html' && credits.length !== 1) throw new Error('hero credit count ' + credits.length);
    if (name !== 'index.html' && credits.length) throw new Error(name + ' carries the hero credit');
  }
  if (!html.includes('name="referrer" content="no-referrer"')) {
    throw new Error('upload.html is missing Referrer-Policy no-referrer');
  }
  if (/never stored/i.test(index)) throw new Error('homepage still says files are never stored');
  const retention = (index.match(/kept for 24 hours so you can download it again/g) || []).length;
  if (retention < 3) throw new Error('retention sentence count ' + retention);
  const anchorIds = ['how', 'sample', 'pricing', 'faq'];
  const missingAnchors = anchorIds.filter((id) => !index.includes(`id="${id}"`));
  if (missingAnchors.length) throw new Error('homepage missing anchors: ' + missingAnchors.join(', '));
  note('shared footer, referrer policy, and 24-hour PDF retention copy', true);
  note('homepage keeps #how, #sample, #pricing, and #faq', true);

  const { child, base } = await startMock();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const external = [];
    page.on('request', (req) => {
      try {
        const host = new URL(req.url()).hostname;
        if (host && host !== '127.0.0.1' && host !== 'localhost') external.push(req.url());
      } catch (err) { /* ignore unparseable urls */ }
    });
    await page.evaluateOnNewDocument(() => {
      window.__cls = 0;
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) window.__cls += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (err) { /* layout shift observer is unavailable */ }
    });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() !== 'error') return;
      if (/favicon|Failed to load resource|net::ERR/i.test(text)) return;
      pageErrors.push(text);
    });

    await page.setCacheEnabled(false);
    await page.setViewport({ width: 412, height: 823, deviceScaleFactor: 1.75, isMobile: true });
    async function measureCls(query, label) {
      if (!query) {
        await page.goto(base + '/upload.html', { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      }
      const client = await page.createCDPSession();
      await client.send('Network.enable');
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 500,
        downloadThroughput: 40 * 1024,
        uploadThroughput: 40 * 1024,
      });
      try {
        await page.goto(base + '/upload.html' + query, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForFunction(() => {
          const phase = document.body.dataset.phase;
          return phase === 'ready' || phase === 'locked';
        }, { timeout: 15000 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const cls = await page.evaluate(() => window.__cls || 0);
        if (cls >= 0.1) throw new Error(label + ' mobile CLS ' + cls.toFixed(3));
        note('mobile CLS under 0.1: ' + label, true, cls.toFixed(3));
      } finally {
        await client.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        }).catch(() => {});
        await client.detach().catch(() => {});
      }
    }
    await measureCls('?session_id=cs_test_local', 'starter');
    await measureCls('?session_id=cs_test_pro', 'pro');
    await measureCls('?session_id=cs_test_empty', 'zero-credit');
    await measureCls('?session_id=cs_test_invalid', 'invalid session');
    await measureCls('', 'no session');
    await measureCls('?session_id=cs_test_drop', 'network error');
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });

    await openUpload(page, base, '?session_id=cs_test_local');
    const banner = await page.$eval('#access-message', (el) => el.textContent);
    if (!/Starter plan/.test(banner) || !/3 manuals remaining/.test(banner)) throw new Error('banner: ' + banner);
    const acceptPlc = await page.$eval('#file-input', (el) => el.getAttribute('accept'));
    if (!acceptPlc.includes('.l5x') || !acceptPlc.includes('.acd') || acceptPlc.includes('.step')) {
      throw new Error('plc accept ' + acceptPlc);
    }
    await shoot(page, 'selector', '#source-picker');
    note('selector at 1280 and 390', true, banner);

    const generateHint = await page.evaluate(() => {
      const button = document.getElementById('generate-btn');
      const hint = document.getElementById('generate-hint');
      const style = getComputedStyle(hint);
      return {
        disabled: button.disabled,
        described: button.getAttribute('aria-describedby'),
        text: hint.textContent,
        hidden: hint.hidden,
        display: style.display,
      };
    });
    if (!generateHint.disabled || generateHint.described !== 'generate-hint' || generateHint.text !== 'Add a file first' || generateHint.hidden || generateHint.display === 'none') {
      throw new Error('generate hint ' + JSON.stringify(generateHint));
    }
    note('a disabled generate button explains that a file is required', true);

    await page.click('input[value="cad"]');
    const cadText = await page.$eval('#source-guidance', (el) => el.textContent);
    const acceptCad = await page.$eval('#file-input', (el) => el.getAttribute('accept'));
    if (!/STEP/.test(cadText) || !acceptCad.includes('.step') || acceptCad.includes('.l5x')) throw new Error('cad selector');
    await page.focus('input[value="cad"]');
    await page.keyboard.press('ArrowRight');
    const both = await page.$eval('input[name="source"]:checked', (el) => el.value);
    if (both !== 'both') throw new Error('arrow key did not reach both, got ' + both);
    const acceptBoth = await page.$eval('#file-input', (el) => el.getAttribute('accept'));
    if (!acceptBoth.includes('.l5x') || !acceptBoth.includes('.dxf') || /gx3|cxp|zap15/.test(acceptBoth)) {
      throw new Error('both accept ' + acceptBoth);
    }
    note('PLC, CAD, and Both selector, including keyboard', true);

    await page.click('input[value="plc"]');
    for (const [file, pattern] of [
      [fixtures.gx3, /gx3/i],
      [fixtures.cxp, /\.cxp/i],
      [fixtures.zap, /zap15/i],
    ]) {
      await addFile(page, file);
      const alertText = await page.$eval('#upload-error', (el) => el.innerText);
      if (!pattern.test(alertText) || !/did not use a credit/i.test(alertText)) {
        throw new Error('blocked ext ' + file + ': ' + alertText);
      }
    }
    const listed = await page.$$eval('#file-list li', (nodes) => nodes.length);
    if (listed !== 0) throw new Error('rejected files were listed');
    note('client rejects gx3, cxp, and zap15 without listing them', true);

    await addFile(page, fixtures.big);
    let alertText = await page.$eval('#upload-error', (el) => el.innerText);
    if (alertText.trim() !== 'big.L5X is 25.1 MB; each file must be 25 MB or smaller.' || /25\.0 MB/.test(alertText)) {
      throw new Error('size message: ' + alertText);
    }
    const welcomeHiddenOnSize = await page.$eval('#payment-welcome', (el) => el.hidden);
    if (!welcomeHiddenOnSize) throw new Error('welcome stayed after the size error');
    await shoot(page, 'oversize', '#upload-error');
    note('client rejects a file over 25 MB without rounding it down to the limit', true);

    await page.click('input[value="both"]');
    await page.$eval('#manufacturer_name', (el) => { el.value = 'Harbor Line Machinery'; });
    await page.$eval('#product_name', (el) => { el.value = 'Case packer'; });
    await page.$eval('#model', (el) => { el.value = 'CP-200'; });
    await page.$eval('#doc_number', (el) => { el.value = 'OM-CP200'; });
    await page.$eval('#revision', (el) => { el.value = 'B'; });
    await addFile(page, fixtures.hold);
    const hintAfterFile = await page.evaluate(() => {
      const hint = document.getElementById('generate-hint');
      return {
        hidden: hint.hidden,
        described: document.getElementById('generate-btn').getAttribute('aria-describedby'),
      };
    });
    if (!hintAfterFile.hidden || hintAfterFile.described) throw new Error('hint stayed after a file ' + JSON.stringify(hintAfterFile));
    await addFile(page, fixtures.step);
    const names = await page.$$eval('.file-name', (nodes) => nodes.map((node) => node.textContent));
    const sizes = await page.$$eval('.file-size', (nodes) => nodes.map((node) => node.textContent));
    if (names.join(',') !== 'hold.L5X,model.step') throw new Error('names ' + names.join(','));
    if (sizes.some((size) => !size.trim())) throw new Error('missing size');
    await shoot(page, 'file_list', '#file-list');
    note('file list shows names, sizes, and remove buttons', true, sizes.join(', '));

    const removeButtons = await page.$$('.file-remove');
    await removeButtons[1].click();
    const afterRemove = await page.$$eval('.file-name', (nodes) => nodes.map((node) => node.textContent));
    if (afterRemove.join(',') !== 'hold.L5X') throw new Error('remove failed ' + afterRemove.join(','));
    await addFile(page, fixtures.step);
    note('remove button drops one file', true);

    await page.click('#generate-btn');
    await page.waitForFunction(() => document.body.dataset.stage === 'analyzing', { timeout: 8000 });
    const stageText = await page.$eval('#progress-label', (el) => el.textContent);
    if (!/Describing how the equipment works/.test(stageText)) throw new Error('stage ' + stageText);
    const percent = await page.$eval('#progress-fill', (el) => el.value);
    if (Number(percent) < 40) throw new Error('percent ' + percent);
    const generatingLabel = await page.$eval('#generate-btn', (el) => el.textContent);
    if (generatingLabel !== 'Generating…') throw new Error('button during analyze: ' + generatingLabel);
    await runAxe(page, 'progress');
    await shoot(page, 'generating', '#generate-btn');
    await shoot(page, 'progress', '#progress-wrap');
    note('progress shows the analyzing stage', true, stageText + ' / ' + generatingLabel);

    await fetch(base + '/__mock/release', { method: 'POST' });
    await waitPhase(page, 'success');
    const successText = await page.$eval('#success-section', (el) => el.innerText);
    if (!/Coverage: 100%/.test(successText) || !/12 of 12/.test(successText)) throw new Error('coverage missing: ' + successText);
    if (!/could not be rewritten/i.test(successText)) throw new Error('warning missing');
    if (!/Download PDF/.test(successText)) throw new Error('download button missing');
    const pdfHead = await page.evaluate(async () => {
      const link = document.getElementById('download-link');
      const res = await fetch(link.href);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return new TextDecoder().decode(bytes.slice(0, 5));
    });
    if (pdfHead !== '%PDF-') throw new Error('pdf head ' + pdfHead);
    const posted = (await requests(base)).filter((entry) => entry.path === '/jobs' && entry.status === 202);
    const last = posted[posted.length - 1];
    for (const field of ['manufacturer_name', 'product_name', 'model', 'doc_number', 'revision']) {
      if (!last.fields.includes(field)) throw new Error('missing field ' + field);
    }
    if (!/^Bearer \S+/.test(last.authorization || '')) throw new Error('missing bearer ' + JSON.stringify(last));
    if (last.fields.includes('session_id') || last.sessionHeader) throw new Error('session id was sent with a bearer token');
    if (last.files.join(',') !== 'hold.L5X,model.step') throw new Error('posted files ' + last.files.join(','));
    if (!(await page.$eval('#payment-welcome', (el) => el.hidden))) throw new Error('welcome stayed after jobs success');
    const successHeading = await page.$eval('#success-title', (el) => el.tagName);
    if (successHeading !== 'H1') throw new Error('success title is ' + successHeading);
    await runAxe(page, 'success');
    await shoot(page, 'success', '#success-section');
    note('success shows coverage, warning, and a PDF download', true);

    await page.evaluateOnNewDocument(() => {
      window.__downloadClicks = 0;
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.id === 'download-link') window.__downloadClicks = (window.__downloadClicks || 0) + 1;
        return orig.apply(this, arguments);
      };
    });
    await page.goto(base + '/upload.html', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.dataset.phase === 'success', { timeout: 8000 });
    const restored = await page.evaluate(async () => {
      const link = document.getElementById('download-link');
      const res = await fetch(link.href);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        clicks: window.__downloadClicks || 0,
        search: location.search,
        hidden: document.getElementById('success-section').hidden,
        download: link.getAttribute('download') || '',
        head: new TextDecoder().decode(bytes.slice(0, 5)),
      };
    });
    if (restored.clicks !== 0 || /session_id/.test(restored.search) || restored.hidden || restored.head !== '%PDF-' || !/manual\.pdf$/.test(restored.download)) {
      throw new Error('restored download ' + JSON.stringify(restored));
    }
    const restoreLog = await requests(base);
    const restoreList = [...restoreLog].reverse().find((entry) => entry.method === 'GET' && entry.path === '/jobs' && entry.status === 200);
    if (!restoreList || !/^Bearer /.test(restoreList.authorization || '')) {
      throw new Error('job list was not authorized with the bearer token');
    }
    note('a return visit restores the PDF for 24 hours without downloading it again', true);

    await openUpload(page, base);
    await addFile(page, fixtures.empty);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    alertText = await page.$eval('#upload-error', (el) => el.innerText);
    if (!/did not use a credit/i.test(alertText) || !/equipment data/i.test(alertText)) throw new Error('422: ' + alertText);
    if (!(await page.$eval('#payment-welcome', (el) => el.hidden))) throw new Error('welcome stayed after 422');
    await runAxe(page, 'error');
    await shoot(page, 'error', '#upload-error');
    note('422 tells the user the file did not use a credit', true);

    async function expectError(file, pattern, label) {
      await openUpload(page, base);
      await addFile(page, file);
      await page.click('#generate-btn');
      await waitPhase(page, 'error');
      const text = await page.$eval('#upload-error', (el) => el.innerText);
      if (!pattern.test(text)) throw new Error(label + ': ' + text);
      note(label, true);
    }
    await expectError(fixtures.unknown, /did not use a credit/i, '415 rejected file did not use a credit');
    await expectError(fixtures.down, /unavailable/i, '503 says the generator is unavailable and did not use a credit');
    await expectError(fixtures.nocredit, /No credit was used/i, '402 says no credit was used');
    await expectError(fixtures.fail, /credit for this attempt is returned/i, 'failed job says the credit is returned');
    await expectError(fixtures.drop, /couldn.t reach ManualOS/i, 'network error is explained');

    await openUpload(page, base, '?session_id=cs_test_local&jobs=0');
    await page.click('input[value="both"]');
    await addFile(page, fixtures.line);
    await addFile(page, fixtures.step);
    await page.click('#generate-btn');
    await waitPhase(page, 'success');
    const legacyText = await page.$eval('#mode-note', (el) => el.textContent);
    if (!/single-file generator/.test(legacyText) || !/line\.L5X/.test(legacyText)) throw new Error('legacy note: ' + legacyText);
    if (/were not uploaded/.test(legacyText) || !/were not used/.test(legacyText)) throw new Error('legacy note wording: ' + legacyText);
    if (!(await page.$eval('#payment-welcome', (el) => el.hidden))) throw new Error('welcome stayed after legacy success');
    const log = await requests(base);
    const legacyCalls = log.filter((entry) => entry.path === '/generate-manual' && entry.files.includes('line.L5X'));
    if (!legacyCalls.length) throw new Error('legacy endpoint was not called');
    note('jobs=0 uses generate-manual and says only one file was sent', true);

    await openUpload(page, base, '?session_id=cs_test_local');
    await addFile(page, fixtures.legacy);
    await page.click('#generate-btn');
    await waitPhase(page, 'success');
    const auto = await page.$eval('#mode-note', (el) => el.textContent);
    if (!/isn.t on this server yet/.test(auto)) throw new Error('auto fallback note: ' + auto);
    if ((await page.$eval('body', (el) => el.dataset.api)) !== 'legacy') throw new Error('api mode was not legacy');
    if (!(await page.$eval('#payment-welcome', (el) => el.hidden))) throw new Error('welcome stayed after automatic legacy success');
    note('POST /jobs 404 falls back to generate-manual', true);

    const beforeForced = (await requests(base)).filter((entry) => entry.path === '/generate-manual').length;
    await openUpload(page, base, '?session_id=cs_test_local&jobs=1');
    await addFile(page, fixtures.legacy);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const forced = await page.$eval('#upload-error', (el) => el.innerText);
    if (!/isn.t available/.test(forced) || !/Nothing was charged/.test(forced)) throw new Error('jobs=1: ' + forced);
    const afterForced = (await requests(base)).filter((entry) => entry.path === '/generate-manual').length;
    if (afterForced !== beforeForced) throw new Error('jobs=1 fell back');
    note('jobs=1 does not fall back when /jobs is 404', true);

    await page.goto(base + '/upload.html?session_id=cs_test_empty', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => {
      const el = document.getElementById('payment-welcome-text');
      return el && el.textContent === 'Starter credits are used up' && document.body.dataset.phase === 'locked';
    });
    const emptyState = await page.evaluate(() => {
      const link = document.getElementById('access-pricing-link');
      const msg = document.getElementById('access-message');
      const welcome = document.getElementById('payment-welcome');
      const welcomeText = document.getElementById('payment-welcome-text');
      const lr = link.getBoundingClientRect();
      const wr = welcome.getBoundingClientRect();
      const tr = welcomeText.getBoundingClientRect();
      const ws = getComputedStyle(welcome);
      const needle = 'Starter credits are used up';
      const sameRow = lr.top < tr.bottom - 1 && lr.bottom > tr.top + 1;
      const directlyUnder = lr.top >= tr.bottom - 4 && (lr.top - tr.bottom) <= 28;
      const visibleCopies = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.includes(needle)) continue;
        const el = node.parentElement;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.height < 1) continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        visibleCopies.push(el.id || el.className);
      }
      const live = [...document.querySelectorAll('[role="status"]')].filter((el) => {
        if (el.hidden) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && (el.innerText || '').includes(needle);
      }).map((el) => el.id);
      return {
        pricing: !link.hidden && lr.height > 20 && getComputedStyle(link).visibility !== 'hidden',
        aligned: sameRow || directlyUnder,
        linkTop: Math.round(lr.top),
        textTop: Math.round(tr.top),
        inputDisabled: document.getElementById('file-input').disabled,
        generateDisabled: document.getElementById('generate-btn').disabled,
        welcomeHidden: welcome.hidden,
        welcomeShown: ws.display !== 'none' && ws.visibility !== 'hidden' && wr.height > 60,
        welcomeText: welcomeText ? welcomeText.textContent : '',
        topLine: msg.textContent,
        topHidden: msg.getAttribute('aria-hidden') === 'true',
        visibleCopies,
        live,
        phase: document.body.dataset.phase,
      };
    });
    if (!emptyState.pricing || !emptyState.aligned || !emptyState.inputDisabled || !emptyState.generateDisabled || emptyState.welcomeHidden || !emptyState.welcomeShown || emptyState.welcomeText !== 'Starter credits are used up' || /Payment confirmed/.test(emptyState.welcomeText) || emptyState.topLine.trim() || !emptyState.topHidden || emptyState.visibleCopies.length !== 1 || emptyState.live.length !== 1 || emptyState.live[0] !== 'payment-welcome' || emptyState.phase !== 'locked') {
      throw new Error('0-credit state ' + JSON.stringify(emptyState));
    }
    await shoot(page, 'no_credits', '#access-banner');
    await runAxe(page, '0-credit session');
    note('0-credit session disables upload and links to pricing', true);

    await openUpload(page, base, '?session_id=cs_test_pro');
    const pro = await page.$eval('#access-message', (el) => el.textContent);
    if (!/Pro plan/.test(pro) || !/Unlimited/.test(pro)) throw new Error(pro);
    await runAxe(page, 'pro session');
    note('pro session shows unlimited manuals', true);

    await openUpload(page, base, '?session_id=cs_test_past_due');
    const pastDue = await page.$eval('#access-message', (el) => el.textContent);
    if (!/Pro plan/.test(pastDue) || !/Payment needs attention\./.test(pastDue)) throw new Error(pastDue);
    note('a past-due purchase stays entitled and says payment needs attention', true);

    await openUpload(page, base);
    await addFile(page, fixtures.exp);
    await page.click('input[value="cad"]');
    const invalid = await page.$eval('#file-list li', (el) => el.className);
    if (!/is-invalid/.test(invalid)) throw new Error('mode switch did not flag the PLC file');
    const generateDisabled = await page.$eval('#generate-btn', (el) => el.disabled);
    if (!generateDisabled) throw new Error('generate stayed enabled for a mismatched file');
    await page.click('input[value="plc"]');
    await addFile(page, fixtures.zip);
    const zipCount = await page.$$eval('#file-list li', (nodes) => nodes.length);
    if (zipCount < 1) throw new Error('zip was rejected');
    note('switching to CAD flags a PLC file, and EXP and zip can be added for PLC', true);

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await openUpload(page, base);
    await addFile(page, fixtures.long);
    const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (narrowOverflow > 1) throw new Error('long name overflow ' + narrowOverflow);
    note('a long file name does not overflow at 390px', true);

    const uploadTaps = await page.evaluate(() => {
      return [...document.querySelectorAll('footer a, .nav-back, #sign-out')].filter((el) => !el.hidden && getComputedStyle(el).display !== 'none').map((el) => {
        const rect = el.getBoundingClientRect();
        return { text: (el.textContent || '').trim().slice(0, 40), w: Math.round(rect.width), h: Math.round(rect.height) };
      });
    });
    const smallUploadTaps = uploadTaps.filter((item) => item.w < 44 || item.h < 44);
    if (smallUploadTaps.length) throw new Error('upload tap targets ' + JSON.stringify(smallUploadTaps));
    note('upload links are at least 44px on a phone', true);

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await openUpload(page, base);
    const formatLists = await page.evaluate(() => {
      return [...document.querySelectorAll('#source-guidance, #drop-help, .export-intro, .platforms, .platform-tags')]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .filter((el) => /\.L5X/i.test(el.textContent))
        .map((el) => el.id || el.className);
    });
    if (formatLists.length !== 1 || formatLists[0] !== 'source-guidance') {
      throw new Error('accepted formats listed ' + JSON.stringify(formatLists));
    }
    note('accepted formats are listed once', true);

    const beforeLimit = (await requests(base)).filter((entry) => entry.path === '/jobs').length;
    const limitInput = await page.$('#file-input');
    await limitInput.uploadFile(...manyFiles);
    await page.evaluate(() => {
      document.getElementById('file-input').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => !document.getElementById('file-input').dataset.pending);
    const limitText = await page.$eval('#upload-error', (el) => el.innerText);
    const listedCount = await page.$$eval('#file-list li', (nodes) => nodes.length);
    const generateBlocked = await page.$eval('#generate-btn', (el) => el.disabled);
    if (limitText.trim() !== '26 files are picked; the limit is 25.' || /upload failed/i.test(limitText)) {
      throw new Error('25-file message: ' + limitText);
    }
    if (listedCount !== 26 || !generateBlocked) throw new Error('listed ' + listedCount + ' blocked ' + generateBlocked);
    const afterLimit = (await requests(base)).filter((entry) => entry.path === '/jobs').length;
    if (afterLimit !== beforeLimit) throw new Error('selecting 26 files posted a job');
    await page.click('.file-remove');
    const afterOneRemoved = await page.evaluate(() => ({
      listed: document.querySelectorAll('#file-list li').length,
      error: document.getElementById('upload-error').hidden ? '' : document.getElementById('upload-error').innerText,
      disabled: document.getElementById('generate-btn').disabled,
    }));
    if (afterOneRemoved.listed !== 25 || afterOneRemoved.error || afterOneRemoved.disabled) {
      throw new Error('removing one file did not clear the limit ' + JSON.stringify(afterOneRemoved));
    }
    note('more than 25 files stays listed, blocks Generate, and is not uploaded', true);

    await openUpload(page, base);
    await addFile(page, fixtures.over);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const overText = await page.$eval('#upload-error', (el) => el.innerText);
    if (!/up to 25 files/i.test(overText) || /upload failed/i.test(overText)) {
      throw new Error('server limit message: ' + overText);
    }
    note('a generator Upload failed. response is shown as the 25-file limit', true);

    await openUpload(page, base, '?session_id=cs_test_compat');
    if (/session_id/.test(await page.evaluate(() => location.search))) throw new Error('compat left session_id in the url');
    await addFile(page, fixtures.line);
    await page.click('#generate-btn');
    await waitPhase(page, 'success');
    const compatLog = await requests(base);
    const compatPost = [...compatLog].reverse().find((entry) => entry.path === '/jobs' && entry.status === 202 && entry.files.includes('line.L5X'));
    const compatExchange = [...compatLog].reverse().find((entry) => entry.path === '/access-token' && entry.status === 503);
    if (!compatPost || !compatPost.fields.includes('session_id') || compatPost.authorization || compatPost.sessionHeader !== 'cs_test_compat' || !compatExchange) {
      throw new Error('compat credential ' + JSON.stringify({ compatPost, compatExchange: !!compatExchange }));
    }
    await page.evaluateOnNewDocument(() => { window.__downloadClicks = 0; });
    await page.goto(base + '/upload.html', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.dataset.phase === 'success', { timeout: 8000 });
    const compatRestored = await page.evaluate(() => ({
      clicks: window.__downloadClicks || 0,
      token: sessionStorage.getItem('manualos_access_token') || '',
      local: localStorage.getItem('manualos_session_id') || '',
    }));
    if (compatRestored.clicks !== 0 || compatRestored.token || compatRestored.local !== 'cs_test_compat') {
      throw new Error('compat restore ' + JSON.stringify(compatRestored));
    }
    note('session_id still authorizes upload and re-download when access tokens are unavailable', true);

    await page.goto(base + '/upload.html?session_id=cs_test_local', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => {
      const phase = document.body.dataset.phase;
      return phase === 'ready' || phase === 'success';
    });
    if (/session_id/.test(await page.evaluate(() => location.search))) {
      throw new Error('session_id stayed in the address bar');
    }
    await page.goto(base + '/upload.html', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => {
      const phase = document.body.dataset.phase;
      return phase === 'ready' || phase === 'success';
    });
    const storedBox = await page.evaluate(() => {
      const welcome = document.getElementById('payment-welcome');
      const style = getComputedStyle(welcome);
      const rect = welcome.getBoundingClientRect();
      return {
        hidden: welcome.hidden,
        display: style.display,
        h: rect.height,
        banner: document.getElementById('access-message').textContent,
      };
    });
    if (!storedBox.hidden || storedBox.display !== 'none' || storedBox.h > 1 || !/Starter plan/.test(storedBox.banner)) {
      throw new Error('stored session welcome ' + JSON.stringify(storedBox));
    }
    note('a stored session does not leave an empty payment box', true);

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.goto(base + '/upload.html?session_id=cs_test_local', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => {
      const phase = document.body.dataset.phase;
      return phase === 'ready' || phase === 'success';
    });
    await page.click('#sign-out');
    await page.waitForFunction(() => document.body.dataset.phase === 'locked');
    const revokeDeadline = Date.now() + 5000;
    let revoked = null;
    while (Date.now() < revokeDeadline) {
      revoked = [...await requests(base)].reverse().find((entry) => entry.path === '/access-token/revoke' && entry.status === 200);
      if (revoked) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const signedOut = await page.evaluate(() => ({
      search: location.search,
      local: localStorage.getItem('manualos_session_id'),
      token: sessionStorage.getItem('manualos_access_token'),
      checkout: sessionStorage.getItem('manualos_checkout_session'),
      text: document.getElementById('payment-welcome-text').textContent,
    }));
    if (/session_id/.test(signedOut.search) || signedOut.local || signedOut.token || signedOut.checkout || !/No purchase found/.test(signedOut.text) || !revoked || !/^Bearer /.test(revoked.authorization || '')) {
      throw new Error('sign out ' + JSON.stringify({ signedOut, revoked: !!revoked }));
    }
    await page.goBack();
    await page.goForward();
    await page.waitForFunction(() => document.body.dataset.phase === 'locked', { timeout: 8000 });
    const returned = await page.evaluate(() => ({
      search: location.search,
      local: localStorage.getItem('manualos_session_id') || '',
      token: sessionStorage.getItem('manualos_access_token') || '',
      checkout: sessionStorage.getItem('manualos_checkout_session') || '',
      phase: document.body.dataset.phase,
      text: document.getElementById('payment-welcome-text').textContent,
    }));
    if (returned.local || returned.token || returned.checkout || /session_id/.test(returned.search) || returned.phase !== 'locked' || !/No purchase found/.test(returned.text)) {
      throw new Error('back restored access ' + JSON.stringify(returned));
    }
    note('sign out clears the session and Back does not restore it', true);

    const unlabeled = await page.evaluate(() => {
      return [...document.querySelectorAll('input, button, select, textarea')].filter((el) => {
        if (el.type === 'hidden' || el.disabled) return false;
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
        if (el.closest('label')) return false;
        if (el.tagName === 'BUTTON' && el.textContent.trim()) return false;
        return true;
      }).map((el) => el.id || el.name || el.outerHTML.slice(0, 80));
    });
    if (unlabeled.length) throw new Error('unlabeled controls: ' + unlabeled.join(', '));
    note('visible controls have labels', true);

    await page.goto(base + '/upload.html?session_id=cs_test_local', { waitUntil: 'networkidle0' });
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => document.activeElement && document.activeElement.className);
    if (!/skip-link/.test(skip)) throw new Error('first tab was ' + skip);
    note('skip link is the first tab stop', true);

    await openUpload(page, base);
    await addFile(page, fixtures.big);
    const staleStart = await page.$eval('#upload-error', (el) => el.hidden ? '' : el.innerText);
    if (staleStart.trim() !== 'big.L5X is 25.1 MB; each file must be 25 MB or smaller.') throw new Error('stale start: ' + staleStart);
    await addFile(page, fixtures.line);
    if (!(await page.$eval('#upload-error', (el) => el.hidden))) throw new Error('error stayed after a successful add');
    await addFile(page, fixtures.big);
    await page.click('.file-remove');
    if (!(await page.$eval('#upload-error', (el) => el.hidden))) throw new Error('error stayed after remove');
    await addFile(page, fixtures.big);
    await page.click('input[value="cad"]');
    if (!(await page.$eval('#upload-error', (el) => el.hidden))) throw new Error('error stayed after source change');
    note('error banner clears after add, remove, and source change', true);

    const beforeCad = (await requests(base)).length;
    await openUpload(page, base, '?session_id=cs_test_local&jobs=0');
    await page.click('input[value="cad"]');
    await addFile(page, fixtures.step);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const cadOnly = await page.$eval('#upload-error', (el) => el.innerText);
    const cadExpected = 'CAD models need the new generator, which isn’t live yet. Nothing was uploaded and no credit was used.';
    if (!cadOnly.includes(cadExpected)) throw new Error('cad only: ' + cadOnly);
    const cadSent = (await requests(base)).slice(beforeCad).filter((entry) => entry.method === 'POST' && (entry.path === '/generate-manual' || entry.path === '/jobs'));
    if (cadSent.length) throw new Error('CAD-only legacy sent ' + JSON.stringify(cadSent));
    if (!(await page.$eval('#payment-welcome', (el) => el.hidden))) throw new Error('welcome stayed after CAD-only stop');
    await shoot(page, 'cad_only', '#upload-error');
    note('CAD-only legacy fallback stops before upload', true);

    const beforeAutoCad = (await requests(base)).length;
    await openUpload(page, base, '?session_id=cs_test_local');
    await page.click('input[value="cad"]');
    await addFile(page, fixtures.legacyStep);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const autoCad = await page.$eval('#upload-error', (el) => el.innerText);
    if (!autoCad.includes('Nothing was processed and no credit was used.')) throw new Error('auto cad: ' + autoCad);
    if (/Nothing was uploaded/.test(autoCad)) throw new Error('auto cad still says uploaded: ' + autoCad);
    const autoCadCalls = (await requests(base)).slice(beforeAutoCad);
    const autoJobs = autoCadCalls.filter((entry) => entry.method === 'POST' && entry.path === '/jobs');
    const autoLegacy = autoCadCalls.filter((entry) => entry.path === '/generate-manual');
    if (autoJobs.length !== 1 || autoJobs[0].status !== 404) throw new Error('auto cad jobs ' + JSON.stringify(autoJobs));
    if (autoLegacy.length) throw new Error('auto cad still called generate-manual');
    if ((await page.$eval('#generate-btn', (el) => el.textContent)) !== 'Generate my manual') {
      throw new Error('auto cad button stuck');
    }
    note('auto-mode CAD-only says nothing was processed and does not call generate-manual', true);

    await openUpload(page, base, '?session_id=cs_test_local&jobs=0');
    await page.click('input[value="both"]');
    await addFile(page, fixtures.step);
    await addFile(page, fixtures.line);
    await page.evaluate(() => {
      const orig = window.fetch.bind(window);
      window.__origFetch = orig;
      window.fetch = function (url) {
        const pending = orig.apply(window, arguments);
        if (String(url).indexOf('/generate-manual') !== -1) {
          return pending.then((res) => new Promise((resolve) => setTimeout(() => resolve(res), 900)));
        }
        return pending;
      };
    });
    await page.click('#generate-btn');
    await page.waitForFunction(() => {
      const noteEl = document.getElementById('mode-note');
      const button = document.getElementById('generate-btn');
      return document.body.dataset.phase === 'progress'
        && !noteEl.hidden
        && /line\.L5X/.test(noteEl.textContent)
        && /were not used/.test(noteEl.textContent)
        && button.textContent === 'Generating…';
    }, { timeout: 8000 });
    const noteDuring = await page.evaluate(() => {
      const el = document.getElementById('mode-note');
      const rect = el.getBoundingClientRect();
      return {
        inSuccess: !!el.closest('#success-section'),
        inUpload: !!el.closest('#upload-section'),
        height: rect.height,
        text: el.textContent,
      };
    });
    if (noteDuring.inSuccess || noteDuring.inUpload || noteDuring.height < 20) {
      throw new Error('legacy note hidden during progress ' + JSON.stringify(noteDuring));
    }
    if (/model\.step was sent/.test(noteDuring.text)) throw new Error('note named the STEP file: ' + noteDuring.text);
    await shoot(page, 'legacy_note', '#mode-note');
    await waitPhase(page, 'success');
    const stepFirst = (await requests(base)).filter((entry) => entry.path === '/generate-manual');
    const stepCall = stepFirst[stepFirst.length - 1];
    if (!stepCall || stepCall.files.join(',') !== 'line.L5X') throw new Error('STEP-first files ' + (stepCall && stepCall.files.join(',')));
    await page.evaluate(() => { if (window.__origFetch) window.fetch = window.__origFetch; });
    note('Both-mode legacy fallback sends the PLC file when STEP is listed first', true);

    await openUpload(page, base, '?session_id=cs_test_local&jobs=0');
    await addFile(page, fixtures.empty);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const noteOnError = await page.evaluate(() => {
      const el = document.getElementById('mode-note');
      const rect = el.getBoundingClientRect();
      return {
        hidden: el.hidden,
        inSuccess: !!el.closest('#success-section'),
        height: rect.height,
        text: el.textContent,
      };
    });
    if (noteOnError.hidden || noteOnError.inSuccess || noteOnError.height < 20 || !/single-file generator/.test(noteOnError.text)) {
      throw new Error('legacy note hidden on error ' + JSON.stringify(noteOnError));
    }
    note('legacy note stays visible when generation fails', true);

    async function expectLocked(query, pattern, label) {
      if (!query) {
        await page.goto(base + '/upload.html', { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      }
      await page.goto(base + '/upload.html' + query, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction(() => document.body.dataset.phase === 'locked', { timeout: 8000 });
      const state = await page.evaluate(() => {
        const link = document.getElementById('access-pricing-link');
        const msg = document.getElementById('access-message');
        const welcome = document.getElementById('payment-welcome');
        const welcomeText = document.getElementById('payment-welcome-text');
        const lr = link.getBoundingClientRect();
        const wr = welcome.getBoundingClientRect();
        const tr = welcomeText.getBoundingClientRect();
        const ws = getComputedStyle(welcome);
        const needle = welcomeText ? welcomeText.textContent : '';
        const sameRow = lr.top < tr.bottom - 1 && lr.bottom > tr.top + 1;
        const directlyUnder = lr.top >= tr.bottom - 4 && (lr.top - tr.bottom) <= 28;
        const visibleCopies = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!needle || !node.textContent.includes(needle)) continue;
          const el = node.parentElement;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || rect.height < 1) continue;
          if (el.closest('[aria-hidden="true"]')) continue;
          visibleCopies.push(el.id || el.className);
        }
        const live = [...document.querySelectorAll('[role="status"]')].filter((el) => {
          if (el.hidden) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && needle && (el.innerText || '').includes(needle);
        }).map((el) => el.id);
        return {
          message: msg.textContent,
          topHidden: msg.getAttribute('aria-hidden') === 'true',
          pricing: !link.hidden && lr.height > 20,
          aligned: sameRow || directlyUnder,
          linkTop: Math.round(lr.top),
          textTop: Math.round(tr.top),
          welcomeShown: ws.display !== 'none' && ws.visibility !== 'hidden' && wr.height > 60,
          welcomeHidden: welcome.hidden,
          welcomeText: needle,
          hasSession: document.documentElement.classList.contains('has-session'),
          visibleCopies,
          live,
        };
      });
      if (!pattern.test(state.welcomeText)) throw new Error(label + ' message ' + state.welcomeText);
      if (state.message.trim() || !state.topHidden) throw new Error(label + ' duplicated top line ' + JSON.stringify(state));
      if (!state.pricing || !state.aligned) throw new Error(label + ' pricing ' + JSON.stringify(state));
      if (state.welcomeHidden || !state.welcomeShown || !state.hasSession || state.visibleCopies.length !== 1 || state.live.length !== 1 || state.live[0] !== 'payment-welcome') {
        throw new Error(label + ' welcome ' + JSON.stringify(state));
      }
      await runAxe(page, label);
      note(label + ' locks upload without an empty welcome gap', true);
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await expectLocked('?session_id=cs_test_invalid', /wasn.t found/, 'invalid session');
    await expectLocked('?session_id=cs_test_canceled', /isn.t active/, 'canceled plan');
    await expectLocked('?session_id=cs_test_refunded', /refunded/, 'refunded purchase');
    await shoot(page, 'invalid_session', '#access-banner');
    await expectLocked('?session_id=cs_test_drop', /couldn.t check your purchase/, 'network error');
    await shoot(page, 'network_error', '#access-banner');
    await expectLocked('', /No purchase found/, 'no session');

    const beforeLimitToken = (await requests(base)).filter((entry) => entry.path === '/access-token' && entry.status === 429).length;
    await page.goto(base + '/upload.html?session_id=cs_test_limit', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.dataset.phase === 'locked');
    const limitCopy = await page.$eval('#payment-welcome-text', (el) => el.textContent);
    const limitPosts = (await requests(base)).filter((entry) => entry.path === '/access-token' && entry.status === 429).length;
    if (limitCopy !== 'Too many requests, please wait a minute and try again' || limitPosts !== beforeLimitToken + 1) {
      throw new Error('access token 429 ' + JSON.stringify({ limitCopy, limitPosts, beforeLimitToken }));
    }
    note('a 429 from access-token asks the buyer to wait and is not retried', true);

    await openUpload(page, base);
    await addFile(page, fixtures.limit);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const jobLimit = await page.$eval('#upload-error', (el) => el.innerText);
    const jobPosts = (await requests(base)).filter((entry) => entry.method === 'POST' && entry.path === '/jobs' && entry.files.includes('limit.L5X'));
    if (!/Too many requests, please wait a minute and try again/.test(jobLimit) || jobPosts.length !== 1 || jobPosts[0].status !== 429) {
      throw new Error('jobs 429 ' + JSON.stringify({ jobLimit, count: jobPosts.length, status: jobPosts[0] && jobPosts[0].status }));
    }
    note('a 429 from upload asks the buyer to wait and is not retried', true);

    async function dropTitleForPointer(coarse) {
      const installed = await page.evaluateOnNewDocument((useCoarse) => {
        const orig = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const text = String(query);
          if (text.includes('pointer') || text.includes('hover')) {
            const wantsCoarse = text.includes('coarse') || text.includes('hover: none');
            return {
              matches: wantsCoarse ? useCoarse : !useCoarse,
              media: text,
              addEventListener() {},
              removeEventListener() {},
              addListener() {},
              removeListener() {},
            };
          }
          return orig(query);
        };
      }, coarse);
      await page.goto(base + '/upload.html?session_id=cs_test_local', { waitUntil: 'networkidle0' });
      const title = await page.$eval('#drop-title', (el) => el.textContent);
      await page.removeScriptToEvaluateOnNewDocument(installed.identifier);
      return title;
    }
    const touchTitle = await dropTitleForPointer(true);
    const mouseTitle = await dropTitleForPointer(false);
    if (touchTitle !== 'Choose files' || mouseTitle !== 'Drag and drop files here') {
      throw new Error('drop title ' + JSON.stringify({ touchTitle, mouseTitle }));
    }
    note('touch devices say Choose files instead of drag and drop', true);

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await openUpload(page, base);
    await runAxe(page, 'ready desktop');
    await assertButtonContrast(page, 'upload ready desktop');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await runAxe(page, 'ready mobile');
    await assertButtonContrast(page, 'upload ready mobile');

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await openUpload(page, base);
    const signOutVisible = await page.$eval('#sign-out', (el) => !el.hidden && getComputedStyle(el).display !== 'none');
    if (!signOutVisible) throw new Error('Sign out is missing on the upload page');
    await addFile(page, fixtures.line);
    await addFile(page, fixtures.copy);
    const ignoredCopy = await page.evaluate(() => ({
      text: document.getElementById('upload-error').innerText,
      names: [...document.querySelectorAll('#file-list .file-name')].map((el) => el.textContent),
    }));
    if (ignoredCopy.text.trim() !== 'copy.L5X is ignored. It matches line.L5X.' || ignoredCopy.names.join(',') !== 'line.L5X') {
      throw new Error('identical files ' + JSON.stringify(ignoredCopy));
    }
    note('identical files are hashed in the browser and the extra one is ignored', true);

    await openUpload(page, base);
    const beforeEmpty = (await requests(base)).filter((entry) => entry.method === 'POST' && entry.path === '/jobs').length;
    await addFile(page, fixtures.zero);
    const emptyFile = await page.evaluate(() => ({
      text: document.getElementById('upload-error').innerText.trim(),
      hint: document.querySelector('#file-list .file-hint')?.textContent || '',
      disabled: document.getElementById('generate-btn').disabled,
    }));
    const afterEmpty = (await requests(base)).filter((entry) => entry.method === 'POST' && entry.path === '/jobs').length;
    if (emptyFile.text !== 'zero.L5X is empty.' || emptyFile.hint !== 'This file is empty.' || !emptyFile.disabled || afterEmpty !== beforeEmpty) {
      throw new Error('empty file ' + JSON.stringify(emptyFile));
    }
    note('an empty file is flagged before upload', true);

    await openUpload(page, base);
    await addFile(page, fixtures.fat);
    const fatText = await page.$eval('#upload-error', (el) => el.innerText.trim());
    const fatListed = await page.$$eval('#file-list li', (nodes) => nodes.length);
    if (fatText !== 'fat.zip is over 100 MB unzipped. A zip must be 100 MB or smaller once unzipped.' || fatListed !== 0) {
      throw new Error('unzipped limit ' + fatText + ' listed ' + fatListed);
    }
    note('a zip over 100 MB unzipped is blocked before upload', true);

    await openUpload(page, base);
    await addFile(page, fixtures.huge);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const hugeText = await page.$eval('#upload-error', (el) => el.innerText);
    const hugeLines = hugeText.split('\n').map((line) => line.trim()).filter(Boolean);
    if (hugeLines.length !== 1 || hugeLines[0] !== 'huge.L5X is 25.2 MB; each file must be 25 MB or smaller.' || /not-chosen/.test(hugeText)) {
      throw new Error('file_too_large ' + hugeText);
    }
    note('file_too_large is shown once and only names the chosen file', true);

    await openUpload(page, base);
    await addFile(page, fixtures.blank);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const blankText = await page.$eval('#upload-error', (el) => el.innerText);
    const blankLines = blankText.split('\n').map((line) => line.trim()).filter(Boolean);
    if (blankLines.length !== 1 || blankLines[0] !== 'blank.L5X is empty.' || /empty-inside/.test(blankText)) {
      throw new Error('empty_file ' + blankText);
    }
    note('empty_file is shown once and only names the chosen file', true);

    await openUpload(page, base);
    await addFile(page, fixtures.many);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    const manyText = await page.$eval('#upload-error', (el) => el.innerText.trim());
    if (manyText !== '30 files are picked; the limit is 25.' || /extra-one/.test(manyText)) {
      throw new Error('too_many_files ' + manyText);
    }
    note('too_many_files says how many were picked and does not name files the user did not choose', true);

    await openUpload(page, base);
    await addFile(page, fixtures.twin);
    await page.click('#generate-btn');
    await waitPhase(page, 'success');
    const twinNote = await page.$eval('#mode-note', (el) => el.hidden ? '' : el.textContent);
    if (twinNote !== 'twin.L5X is ignored.' || /nested|other\.L5X/.test(twinNote)) {
      throw new Error('ignored list ' + twinNote);
    }
    note('the server ignored list names only a file the user chose', true);

    await openUpload(page, base);
    await addFile(page, fixtures.again);
    await page.click('#generate-btn');
    await page.waitForFunction(() => !document.getElementById('duplicate-panel').hidden);
    const duplicate = await page.evaluate(() => ({
      message: document.getElementById('duplicate-message').textContent,
      job: document.getElementById('existing-job-link').textContent,
      href: document.getElementById('existing-job-link').getAttribute('href'),
      again: document.getElementById('generate-again').textContent,
      signOut: !document.getElementById('sign-out').hidden,
    }));
    if (duplicate.message !== 'You already generated a manual from these files' || duplicate.job !== 'job_existing' || duplicate.href !== '#job-job_existing' || duplicate.again !== 'Generate again (uses a credit)' || !duplicate.signOut) {
      throw new Error('duplicate upload ' + JSON.stringify(duplicate));
    }
    await page.click('#existing-job-link');
    await waitPhase(page, 'success');
    await openUpload(page, base);
    await addFile(page, fixtures.again);
    await page.click('#generate-btn');
    await page.waitForFunction(() => !document.getElementById('duplicate-panel').hidden);
    const beforeAgain = (await requests(base)).length;
    await page.click('#generate-again');
    await waitPhase(page, 'success');
    const againPost = (await requests(base)).slice(beforeAgain).find((entry) => entry.method === 'POST' && entry.path === '/jobs' && entry.files.includes('again.L5X'));
    if (!againPost || againPost.status !== 202 || !againPost.fields.includes('confirmDuplicate') || againPost.fields.includes('session_id') || !/^Bearer \S+/.test(againPost.authorization || '')) {
      throw new Error('confirm duplicate ' + JSON.stringify(againPost));
    }
    note('a duplicate upload links to the existing job and can be generated again with the portal token', true);

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    const homeMobile = await page.evaluate(() => {
      const bar = document.querySelector('.bar').getBoundingClientRect();
      const cta = document.querySelector('.hero-cta').getBoundingClientRect();
      const fan = document.querySelector('.fan').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.plan-card')].map((el) => el.getBoundingClientRect());
      const previews = [...document.querySelectorAll('.gallery figure.page')].filter((el) => getComputedStyle(el).display !== 'none');
      const pdf = document.querySelector('.sample-actions a');
      const pdfBox = pdf.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        header: Math.round(bar.height),
        ctaBeforeImage: cta.bottom <= fan.top + 1,
        stacked: cards.length === 2 && cards[1].top >= cards[0].bottom - 2,
        previews: previews.length,
        pdf: pdfBox.height > 20 && getComputedStyle(pdf).display !== 'none',
      };
    });
    if (homeMobile.overflow > 1) throw new Error('home overflow 390 ' + homeMobile.overflow);
    if (homeMobile.header > 80) throw new Error('home header is not one row ' + JSON.stringify(homeMobile));
    if (!homeMobile.ctaBeforeImage || !homeMobile.stacked || homeMobile.previews !== 2 || !homeMobile.pdf) {
      throw new Error('home mobile layout ' + JSON.stringify(homeMobile));
    }
    await assertButtonContrast(page, 'home 390');
    await runAxe(page, 'home 390');
    note('home at 390 keeps one header row, copy before the image, stacked pricing, and two previews', true);

    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    const largeText = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bar = document.querySelector('.bar').getBoundingClientRect();
      const cta = document.querySelector('a.btn.btn-nav').getBoundingClientRect();
      const exts = document.querySelector('.flow ul.exts').getBoundingClientRect();
      return {
        scroll: document.documentElement.scrollWidth - vw,
        header: Math.round(bar.height),
        ctaLeft: cta.left,
        ctaRight: cta.right,
        ctaH: cta.height,
        extsRight: exts.right,
        vw,
      };
    });
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    if (largeText.scroll > 1 || largeText.header >= 110 || largeText.ctaLeft < 0 || largeText.ctaRight > largeText.vw + 1 || largeText.ctaH < 44 || largeText.extsRight > largeText.vw + 1) {
      throw new Error('200% text at 390 ' + JSON.stringify(largeText));
    }
    note('home at 390 with 200% text keeps Get started and the file types on screen', true, 'header ' + largeText.header + 'px');

    const menuClosed = await page.evaluate(() => {
      const toggle = document.querySelector('.nav-toggle');
      const how = document.querySelector('#primary-menu a[href="#how"]');
      const toggleBox = toggle.getBoundingClientRect();
      return {
        expanded: toggle.getAttribute('aria-expanded'),
        howVisible: how.getClientRects().length > 0,
        w: toggleBox.width,
        h: toggleBox.height,
      };
    });
    if (menuClosed.expanded !== 'false' || menuClosed.howVisible || menuClosed.w < 44 || menuClosed.h < 44) {
      throw new Error('closed menu ' + JSON.stringify(menuClosed));
    }
    await page.click('.nav-toggle');
    const menuOpen = await page.evaluate(() => {
      const link = document.querySelector('#primary-menu a[href="#how"]');
      const box = link.getBoundingClientRect();
      return {
        expanded: document.querySelector('.nav-toggle').getAttribute('aria-expanded'),
        label: document.getElementById('nav-toggle-label').textContent,
        focused: document.activeElement && document.activeElement.textContent,
        h: box.height,
        w: box.width,
      };
    });
    if (menuOpen.expanded !== 'true' || menuOpen.label !== 'Close menu' || !/How it works/.test(menuOpen.focused || '') || menuOpen.h < 44 || menuOpen.w < 44) {
      throw new Error('open menu ' + JSON.stringify(menuOpen));
    }
    await page.keyboard.press('Escape');
    const menuEsc = await page.evaluate(() => ({
      expanded: document.querySelector('.nav-toggle').getAttribute('aria-expanded'),
      active: document.activeElement && document.activeElement.className,
    }));
    if (menuEsc.expanded !== 'false' || !/nav-toggle/.test(menuEsc.active || '')) {
      throw new Error('escape menu ' + JSON.stringify(menuEsc));
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.nav-toggle').getAttribute('aria-expanded') === 'true');
    await page.keyboard.press('Escape');
    note('phone menu button reveals the section links and Escape returns focus', true);

    const homeTaps = await page.evaluate(() => {
      const nodes = [
        document.querySelector('.need-more a'),
        document.querySelector('.pay-note a'),
        document.querySelector('.footer-nav a[href="#faq"]'),
        document.querySelector('.footer-nav a[href^="mailto:"]'),
        document.querySelector('.faq-item a'),
      ];
      return nodes.map((el) => {
        const rect = el.getBoundingClientRect();
        return { text: (el.textContent || '').trim().slice(0, 48), w: Math.round(rect.width), h: Math.round(rect.height) };
      });
    });
    const smallHomeTaps = homeTaps.filter((item) => item.w < 44 || item.h < 44);
    if (smallHomeTaps.length) throw new Error('home tap targets ' + JSON.stringify(smallHomeTaps));
    note('home links are at least 44 by 44px on a phone', true);

    await page.goto(base + '/?utm_source=ad&utm_medium=cpc&utm_campaign=spring#sample', { waitUntil: 'networkidle0' });
    const campaignAnchors = await page.evaluate(() => ({
      hash: location.hash,
      search: location.search,
      ids: ['how', 'sample', 'pricing', 'faq'].filter((id) => document.getElementById(id)),
    }));
    if (campaignAnchors.hash !== '#sample' || !campaignAnchors.search.includes('utm_campaign=spring') || campaignAnchors.ids.join(',') !== 'how,sample,pricing,faq') {
      throw new Error('campaign anchor ' + JSON.stringify(campaignAnchors));
    }
    note('a /?utm_...#sample link still resolves the homepage anchors', true);

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    const homeDesktop = await page.evaluate(() => {
      const figs = [...document.querySelectorAll('.gallery figure.page')];
      const last = figs[figs.length - 1].getBoundingClientRect();
      const row = figs.filter((el) => Math.abs(el.getBoundingClientRect().top - last.top) < 4);
      const title = document.getElementById('hero-title').getBoundingClientRect();
      const lede = document.querySelector('.lede').getBoundingClientRect();
      const cta = document.querySelector('.hero-cta').getBoundingClientRect();
      const price = document.querySelector('.hero-cta .btn-primary');
      const priceBox = price ? price.getBoundingClientRect() : { height: 0 };
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        lastRow: row.length,
        gap: Math.round(lede.top - title.bottom),
        priceInButton: !!price && /\$39/.test(price.textContent) && priceBox.height > 20 && priceBox.top >= cta.top - 2,
      };
    });
    if (homeDesktop.overflow > 1) throw new Error('home overflow 1280 ' + homeDesktop.overflow);
    if (homeDesktop.lastRow < 2 || homeDesktop.gap > 40 || !homeDesktop.priceInButton) {
      throw new Error('home desktop layout ' + JSON.stringify(homeDesktop));
    }
    await assertButtonContrast(page, 'home 1280');
    await runAxe(page, 'home 1280');
    note('home at 1280 top-aligns the hero, keeps the price on the primary button, and does not leave the last preview alone', true);

    if (external.length) throw new Error('external requests: ' + external.join(', '));
    note('no production or Stripe requests', true);

    if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join(' | '));
    note('no page errors', true);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }

  const failed = results.filter((item) => !item.ok);
  await writeFile(path.join(shotDir, 'verify-results.json'), JSON.stringify({ results, failed: failed.length }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
