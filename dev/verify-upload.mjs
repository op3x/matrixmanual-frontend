// Headless check for upload.html against dev/mock-api.mjs.
// Requires puppeteer-core and Chrome. Does not call production or Stripe.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoBrandNames } from './check-brands.mjs';
import { assertHeroFilm } from './check-hero-film.mjs';

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

async function scrollIntoViewNow(page, selector) {
  await page.evaluate((sel) => {
    window.__scrollStable = 0;
    window.__scrollYSample = null;
    document.querySelector(sel).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }, selector);
  await page.waitForFunction(() => {
    const y = window.scrollY;
    if (window.__scrollYSample !== null && Math.abs(window.__scrollYSample - y) < 0.5) window.__scrollStable += 1;
    else window.__scrollStable = 0;
    window.__scrollYSample = y;
    return window.__scrollStable >= 2;
  }, { polling: 50, timeout: 5000 });
}

async function shoot(page, name, scrollSelector) {
  for (const viewport of [
    { width: 1280, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    const handle = await page.$(scrollSelector);
    if (!handle) throw new Error(`${name} missing ${scrollSelector}`);
    await scrollIntoViewNow(page, scrollSelector);
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
  await page.waitForFunction(() => document.body.dataset.phase === 'ready', { timeout: 8000 });
}

async function addFile(page, filePath) {
  const input = await page.$('#file-input');
  await input.uploadFile(filePath);
  await page.evaluate(() => {
    const input = document.getElementById('file-input');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
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
  };
  await writeFile(fixtures.line, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.step, 'ISO-10303-21;\n');
  await writeFile(fixtures.hold, '<RSLogix5000Content></RSLogix5000Content>');
  await writeFile(fixtures.gx3, 'gx');
  await writeFile(fixtures.cxp, 'cx');
  await writeFile(fixtures.zap, 'zap');
  await writeFile(fixtures.big, Buffer.alloc(50 * 1024 * 1024 + 1, 1));
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
  await assertHeroFilm(root);
  note('built site has no third-party video site, the v3 original files match and keep c2pa, and the footer credit is exact', true);

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
        await page.evaluate(() => localStorage.clear());
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
    if (!/50 MB/.test(alertText) || !alertText.trim().endsWith('This did not use a credit.')) throw new Error('size message: ' + alertText);
    const welcomeHiddenOnSize = await page.$eval('#payment-welcome', (el) => el.hidden);
    if (!welcomeHiddenOnSize) throw new Error('welcome stayed after the size error');
    await shoot(page, 'oversize', '#upload-error');
    note('client rejects a file over 50 MB', true);

    await page.click('input[value="both"]');
    await page.$eval('#manufacturer_name', (el) => { el.value = 'Harbor Line Machinery'; });
    await page.$eval('#product_name', (el) => { el.value = 'Case packer'; });
    await page.$eval('#model', (el) => { el.value = 'CP-200'; });
    await page.$eval('#doc_number', (el) => { el.value = 'OM-CP200'; });
    await page.$eval('#revision', (el) => { el.value = 'B'; });
    await addFile(page, fixtures.hold);
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
    for (const field of ['session_id', 'manufacturer_name', 'product_name', 'model', 'doc_number', 'revision']) {
      if (!last.fields.includes(field)) throw new Error('missing field ' + field);
    }
    if (last.files.join(',') !== 'hold.L5X,model.step') throw new Error('posted files ' + last.files.join(','));
    if (!(await page.$eval('#payment-welcome', (el) => el.hidden))) throw new Error('welcome stayed after jobs success');
    const successHeading = await page.$eval('#success-title', (el) => el.tagName);
    if (successHeading !== 'H1') throw new Error('success title is ' + successHeading);
    await runAxe(page, 'success');
    await shoot(page, 'success', '#success-section');
    note('success shows coverage, warning, and a PDF download', true);

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
    if (!staleStart.trim().endsWith('This did not use a credit.')) throw new Error('stale start: ' + staleStart);
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
    const cadSent = (await requests(base)).slice(beforeCad).filter((entry) => entry.path === '/generate-manual' || entry.path === '/jobs');
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
    const autoJobs = autoCadCalls.filter((entry) => entry.path === '/jobs');
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
        await page.evaluate(() => localStorage.clear());
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
    await expectLocked('?session_id=cs_test_invalid', /isn.t active/, 'invalid session');
    await shoot(page, 'invalid_session', '#access-banner');
    await expectLocked('?session_id=cs_test_drop', /couldn.t check your purchase/, 'network error');
    await shoot(page, 'network_error', '#access-banner');
    await expectLocked('', /No purchase found/, 'no session');

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await openUpload(page, base);
    await runAxe(page, 'ready desktop');
    await assertButtonContrast(page, 'upload ready desktop');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await runAxe(page, 'ready mobile');
    await assertButtonContrast(page, 'upload ready mobile');

    async function heroState(page) {
      return page.evaluate(() => {
        function channel(c) {
          const m = String(c).match(/rgba?\(([^)]+)\)/);
          if (!m) return null;
          const p = m[1].split(',').map((x) => parseFloat(x.trim()));
          return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        }
        function linear(v) {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        }
        function contrast(fg, bg) {
          const L = (c) => 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
          const a = L(fg);
          const b = L(bg);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        }
        const frame = document.querySelector('.hero-film-frame');
        const box = frame ? frame.getBoundingClientRect() : null;
        const video = document.querySelector('.hero-film-video');
        const button = document.querySelector('.hero-film-toggle');
        const credit = document.querySelector('.hero-video-credit');
        const tagline = document.querySelector('.footer-inner > p:not(.hero-video-credit):not(.footer-brand)');
        const creditStyle = credit ? getComputedStyle(credit) : null;
        const tagStyle = tagline ? getComputedStyle(tagline) : null;
        const footerStyle = getComputedStyle(document.querySelector('.site-footer'));
        const fg = creditStyle ? channel(creditStyle.color) : null;
        const bg = channel(footerStyle.backgroundColor);
        const creditBox = credit ? credit.getBoundingClientRect() : null;
        return {
          thirdParty: document.documentElement.outerHTML.toLowerCase().includes(['you', 'tube'].join('')),
          oldPoster: document.documentElement.outerHTML.includes('mechanical-intelligence'),
          filmLink: [...document.querySelectorAll('a')].some((a) => /play the short film/i.test(a.textContent || '')),
          iframes: document.querySelectorAll('iframe').length,
          beside: !!document.querySelector('.hero-film')?.textContent.includes('Grok'),
          width: box ? box.width : 0,
          height: box ? box.height : 0,
          ratio: box && box.height ? box.width / box.height : 0,
          poster: !!document.querySelector('.hero-film-poster')?.naturalWidth,
          src: video && video.currentSrc ? video.currentSrc : '',
          controls: !!(video && video.hasAttribute('controls')),
          videoHidden: !video || video.hidden,
          buttonHidden: !button || button.hidden,
          buttonText: button ? button.textContent : '',
          paused: video ? video.paused : true,
          mp4: performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('.mp4')),
          credit: credit ? credit.textContent : '',
          creditLink: credit ? !!credit.querySelector('a') : false,
          creditInDetails: credit ? !!credit.closest('details') : false,
          creditVisible: !!(credit && creditBox && creditBox.height > 12 && creditStyle.display !== 'none' && creditStyle.visibility !== 'hidden' && Number(creditStyle.opacity) === 1),
          creditSize: creditStyle ? parseFloat(creditStyle.fontSize) : 0,
          tagSize: tagStyle ? parseFloat(tagStyle.fontSize) : 0,
          sameColor: !!(fg && tagStyle && creditStyle.color === tagStyle.color),
          contrast: fg && bg ? contrast(fg, bg) : 0,
          cls: window.__cls || 0,
        };
      });
    }

    function assertCredit(state, label) {
      if (state.credit !== 'Hero video created with Grok.' || state.creditLink || state.creditInDetails || !state.creditVisible) {
        throw new Error(label + ' footer credit ' + JSON.stringify(state));
      }
      if (state.beside) throw new Error(label + ' credit is next to the video');
      if (state.creditSize + 0.5 < state.tagSize || state.contrast < 4.5 || !state.sameColor) {
        throw new Error(label + ' credit contrast ' + JSON.stringify({ size: state.creditSize, tag: state.tagSize, contrast: state.contrast, same: state.sameColor }));
      }
    }

    async function assertHeroFrame(page, label, expectVideo) {
      const state = await heroState(page);
      if (state.thirdParty || state.oldPoster || state.iframes || state.filmLink) {
        throw new Error(label + ' third-party film leaked ' + JSON.stringify(state));
      }
      if (!state.poster || state.width < 200 || Math.abs(state.ratio - (16 / 9)) > 0.08) {
        throw new Error(label + ' hero frame ' + JSON.stringify(state));
      }
      assertCredit(state, label);
      if (expectVideo) {
        if (state.videoHidden || state.buttonHidden || state.controls || !/manualos-hero-draft-v3-original\.mp4/.test(state.src) || state.mp4.length < 1) {
          throw new Error(label + ' video did not attach ' + JSON.stringify(state));
        }
        if (state.buttonText !== 'Pause' && state.buttonText !== 'Play') throw new Error(label + ' button ' + state.buttonText);
      } else if (!state.videoHidden || !state.buttonHidden || state.src || state.mp4.length) {
        throw new Error(label + ' phone or still hero loaded video ' + JSON.stringify(state));
      }
      const before = await page.evaluate(() => {
        const r = document.querySelector('.hero-film-frame').getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = await page.evaluate(() => {
        const r = document.querySelector('.hero-film-frame').getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      if (Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1) {
        throw new Error(label + ' hero frame shifted ' + JSON.stringify({ before, after }));
      }
      const cls = await page.evaluate(() => window.__cls || 0);
      if (cls >= 0.1) throw new Error(label + ' CLS ' + cls.toFixed(3));
    }

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
    await scrollIntoViewNow(page, '#hero-film');
    await assertHeroFrame(page, 'home 390', false);
    await page.screenshot({ path: path.join(shotDir, 'home_hero_390.png') });
    await scrollIntoViewNow(page, '.hero-video-credit');
    await page.screenshot({ path: path.join(shotDir, 'home_footer_credit_390.png') });
    note('home at 390 keeps one header row, copy before the image, stacked pricing, and two previews', true);

    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    const homeDesktop = await page.evaluate(() => {
      const figs = [...document.querySelectorAll('.gallery figure.page')];
      const last = figs[figs.length - 1].getBoundingClientRect();
      const row = figs.filter((el) => Math.abs(el.getBoundingClientRect().top - last.top) < 4);
      const title = document.getElementById('hero-title').getBoundingClientRect();
      const lede = document.querySelector('.lede').getBoundingClientRect();
      const trust = document.querySelector('.trust-strip').getBoundingClientRect();
      const cta = document.querySelector('.hero-cta').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        lastRow: row.length,
        ledeBelowTitle: lede.top >= title.bottom - 2,
        trustUnderButtons: trust.top >= cta.bottom - 2,
      };
    });
    if (homeDesktop.overflow > 1) throw new Error('home overflow 1280 ' + homeDesktop.overflow);
    if (homeDesktop.lastRow < 2 || !homeDesktop.ledeBelowTitle || !homeDesktop.trustUnderButtons) {
      throw new Error('home desktop layout ' + JSON.stringify(homeDesktop));
    }
    await assertButtonContrast(page, 'home 1280');
    await runAxe(page, 'home 1280');
    await scrollIntoViewNow(page, '#hero-film');
    await page.waitForFunction(() => {
      const video = document.querySelector('.hero-film-video');
      return video && video.currentSrc.includes('manualos-hero-draft-v3-original.mp4') && !video.paused && !video.hasAttribute('controls');
    }, { timeout: 8000 });
    await assertHeroFrame(page, 'home 1280', true);
    await page.screenshot({ path: path.join(shotDir, 'home_hero_1280.png') });
    await page.evaluate(() => {
      const film = document.getElementById('hero-film');
      window.scrollTo({ top: film.getBoundingClientRect().bottom + window.scrollY + 40, left: 0, behavior: 'instant' });
    });
    await page.waitForFunction(() => {
      const film = document.getElementById('hero-film').getBoundingClientRect();
      return film.bottom <= 0 && document.querySelector('.hero-film-video').paused;
    }, { timeout: 4000 });
    await scrollIntoViewNow(page, '#hero-film');
    await page.waitForFunction(() => !document.querySelector('.hero-film-video').paused, { timeout: 4000 });
    const toggle = await page.$('.hero-film-toggle');
    await toggle.focus();
    const focused = await page.evaluate(() => document.activeElement === document.querySelector('.hero-film-toggle'));
    if (!focused) throw new Error('pause button is not keyboard focusable');
    await page.click('.hero-film-toggle');
    const paused = await page.$eval('.hero-film-video', (video) => video.paused);
    const label = await page.$eval('.hero-film-toggle', (el) => el.textContent);
    if (!paused || label !== 'Play') throw new Error('pause control did not pause ' + label);
    await page.screenshot({ path: path.join(shotDir, 'home_hero_paused_1280.png') });
    await scrollIntoViewNow(page, '.hero-video-credit');
    await page.screenshot({ path: path.join(shotDir, 'home_footer_credit_1280.png') });
    note('home at 1280 top-aligns the hero, puts prices under the buttons, and does not leave the last preview alone', true);

    async function assertStill(label, setup) {
      const still = await browser.newPage();
      const leaks = [];
      still.on('request', (req) => {
        try {
          const host = new URL(req.url()).hostname;
          if (host && host !== '127.0.0.1' && host !== 'localhost') leaks.push(req.url());
        } catch (err) { /* ignore unparseable urls */ }
      });
      if (setup) await setup(still);
      await still.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
      await still.goto(base + '/', { waitUntil: 'networkidle0' });
      await assertHeroFrame(still, label, false);
      if (leaks.length) throw new Error(label + ' external ' + leaks.join(', '));
      await still.close();
      note(label + ' shows the poster only', true);
    }
    await assertStill('reduced motion', (still) => still.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]));
    await assertStill('save-data', (still) => still.evaluateOnNewDocument(() => {
      const connection = { saveData: true, addEventListener() {}, removeEventListener() {} };
      Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get() { return connection; } });
    }));

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
