// Headless check for upload.html against dev/mock-api.mjs.
// Requires puppeteer-core and Chrome. Does not call production or Stripe.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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
      const text = msg.text();
      if (msg.type() !== 'error') return;
      if (/favicon|Failed to load resource/i.test(text)) return;
      pageErrors.push(text);
    });

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
    if (!/50 MB/.test(alertText)) throw new Error('size message: ' + alertText);
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
    await shoot(page, 'progress', '#progress-wrap');
    note('progress shows the analyzing stage', true, stageText);

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
    await shoot(page, 'success', '#success-section');
    note('success shows coverage, warning, and a PDF download', true);

    await openUpload(page, base);
    await addFile(page, fixtures.empty);
    await page.click('#generate-btn');
    await waitPhase(page, 'error');
    alertText = await page.$eval('#upload-error', (el) => el.innerText);
    if (!/did not use a credit/i.test(alertText) || !/equipment data/i.test(alertText)) throw new Error('422: ' + alertText);
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
    await page.waitForFunction(() => /0 manuals remaining/.test(document.getElementById('access-message').textContent));
    note('starter with no manuals left stays visible in the access banner', true);

    await openUpload(page, base, '?session_id=cs_test_pro');
    const pro = await page.$eval('#access-message', (el) => el.textContent);
    if (!/Pro plan/.test(pro) || !/Unlimited/.test(pro)) throw new Error(pro);
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
