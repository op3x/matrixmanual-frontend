// Local stand-in for the ManualOS jobs API. Bind is 127.0.0.1 only.
// It also serves this static site so upload.html can call the same origin.
// Do not point this at Stripe, Railway, or a real checkout session.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 8 * 1024 * 1024;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const jobs = new Map();
const pdfs = new Map();
const holds = new Map();
const requests = [];

function storeJob(spec) {
  const job = {
    id: spec.id,
    sessionId: spec.sessionId,
    filename: spec.filename,
    status: spec.status,
    progress: {
      stage: spec.status === 'succeeded' ? 'done' : spec.status,
      percent: spec.status === 'succeeded' ? 100 : 40,
      message: spec.status === 'succeeded' ? 'Manual is ready' : 'Working on your manual',
    },
    error: null,
    warnings: [],
    coverage: null,
    createdAt: spec.createdAt,
    expiresAt: new Date(Date.parse(spec.createdAt) + 24 * 60 * 60 * 1000).toISOString(),
  };
  jobs.set(job.id, job);
  if (spec.status === 'succeeded') pdfs.set(job.id, PDF);
}

const seedHour = 60 * 60 * 1000;
const seededAt = Date.now();
storeJob({ id: 'job_recent_starter', sessionId: 'cs_test_local', status: 'succeeded', filename: 'packer-line.L5X', createdAt: new Date(seededAt - seedHour).toISOString() });
storeJob({ id: 'job_recent_starter_wait', sessionId: 'cs_test_local', status: 'running', filename: 'labeler.st', createdAt: new Date(seededAt - 2 * seedHour).toISOString() });
storeJob({ id: 'job_recent_starter_old', sessionId: 'cs_test_local', status: 'succeeded', filename: 'archive-old.L5X', createdAt: new Date(seededAt - 48 * seedHour).toISOString() });
storeJob({ id: 'job_recent_pro', sessionId: 'cs_test_pro', status: 'succeeded', filename: 'filler.L5X', createdAt: new Date(seededAt - seedHour).toISOString() });
storeJob({ id: 'job_recent_pro_wait', sessionId: 'cs_test_pro', status: 'running', filename: 'labeler.st', createdAt: new Date(seededAt - 2 * seedHour).toISOString() });
storeJob({ id: 'job_recent_empty', sessionId: 'cs_test_empty', status: 'succeeded', filename: 'packer-line.L5X', createdAt: new Date(seededAt - seedHour).toISOString() });
storeJob({ id: 'job_recent_past_due', sessionId: 'cs_test_past_due', status: 'succeeded', filename: 'conveyor.L5X', createdAt: new Date(seededAt - seedHour).toISOString() });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendPdf(res, body) {
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': body.length,
    'Content-Disposition': 'attachment; filename="manual.pdf"',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function headerSession(req) {
  return String(req.headers['x-session-id'] || '').trim();
}

function decodeJobId(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function mineView(job) {
  return {
    id: job.id,
    status: job.status,
    created_at: job.createdAt,
    filename: job.filename || 'manual',
    pdf_available: job.status === 'succeeded' && pdfs.has(job.id),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    warnings: job.warnings,
    coverage: job.coverage,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const err = new Error('too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return [];
  const boundary = (match[1] || match[2] || '').trim();
  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let start = buffer.indexOf(delim);
  while (start !== -1) {
    let next = buffer.indexOf(delim, start + delim.length);
    if (next === -1) break;
    let chunk = buffer.subarray(start + delim.length, next);
    if (chunk[0] === 13 && chunk[1] === 10) chunk = chunk.subarray(2);
    else if (chunk[0] === 10) chunk = chunk.subarray(1);
    if (chunk.length >= 2 && chunk[chunk.length - 2] === 13 && chunk[chunk.length - 1] === 10) {
      chunk = chunk.subarray(0, chunk.length - 2);
    } else if (chunk.length && chunk[chunk.length - 1] === 10) {
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    const sep = chunk.indexOf(Buffer.from('\r\n\r\n'));
    const sepAlt = sep === -1 ? chunk.indexOf(Buffer.from('\n\n')) : -1;
    const headerEnd = sep !== -1 ? sep : sepAlt;
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString('utf8');
      const body = chunk.subarray(headerEnd + (sep !== -1 ? 4 : 2));
      const name = /name="([^"]*)"/i.exec(headers);
      const filename = /filename="([^"]*)"/i.exec(headers);
      parts.push({
        name: name ? name[1] : '',
        filename: filename ? filename[1] : '',
        body,
      });
    }
    start = next;
  }
  return parts;
}

function scenarioOf(filenames) {
  const name = (filenames[0] || '').toLowerCase();
  if (name === 'hold.l5x') return 'hold';
  if (name === 'slow.l5x') return 'slow';
  if (name === 'fail.l5x') return 'fail';
  if (name === 'nocredit.l5x') return '402';
  if (name === 'unknown.l5x') return '415';
  if (name === 'empty.l5x') return '422';
  if (name === 'down.l5x') return '503';
  if (name === 'legacy.l5x' || name === 'legacy.step') return '404';
  if (name === 'drop.l5x') return 'drop';
  return 'ok';
}

function sessionAllowed(sessionId) {
  return sessionId === 'cs_test_local' || sessionId === 'cs_test_pro' || sessionId === 'cs_test_past_due';
}

function errorForScenario(scenario) {
  if (scenario === '402') return [402, { error: 'Starter credits are used up.' }];
  if (scenario === '415') return [415, { error: 'This file is not a supported project format.' }];
  if (scenario === '422') return [422, { error: 'This file does not contain equipment data that can be read.' }];
  if (scenario === '503') return [503, { error: 'Manual generation is temporarily unavailable.' }];
  if (scenario === '404') return [404, { error: 'Not found' }];
  return null;
}

async function runJob(job, scenario) {
  const steps = [
    ['parsing', 15, 'Reading project files'],
    ['analyzing', 40, 'Describing how the equipment works'],
    ['assembling', 72, 'Writing the manual'],
    ['rendering', 88, 'Rendering the PDF'],
  ];
  const gap = scenario === 'slow' ? 700 : scenario === 'hold' ? 200 : 80;
  for (const [stage, percent, message] of steps) {
    await sleep(gap);
    job.status = 'running';
    job.progress = { stage, percent, message };
    if (scenario === 'fail' && stage === 'analyzing') {
      await sleep(gap);
      job.status = 'failed';
      job.error = 'Manual generation failed. Please try again.';
      job.progress = { stage: 'failed', percent, message: job.error };
      return;
    }
    if (scenario === 'hold' && stage === 'analyzing') {
      await new Promise((resolve) => holds.set(job.id, resolve));
    }
  }
  await sleep(gap);
  job.warnings = ['One control section could not be rewritten automatically and was described from the project data instead.'];
  job.coverage = { units: 12, accounted: 12, percent: 100 };
  job.status = 'succeeded';
  job.progress = { stage: 'done', percent: 100, message: 'Manual is ready' };
  pdfs.set(job.id, PDF);
}

function contentType(file) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
    '.webmanifest': 'application/manifest+json',
  };
  return types[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function safeFile(urlPath) {
  let decoded = '/';
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  const rel = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(root, '.' + rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (full.split(path.sep).includes('.git')) return null;
  return full;
}

async function serveStatic(req, res, urlPath) {
  if (urlPath === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const file = safeFile(urlPath === '/' ? '/index.html' : urlPath);
  if (!file) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  try {
    const stat = await fs.stat(file);
    const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
    const body = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': contentType(target),
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function handleJobsPost(req, res) {
  const body = await readBody(req);
  const parts = parseMultipart(body, req.headers['content-type']);
  const files = parts.filter((part) => part.filename);
  const fields = parts.filter((part) => part.name && !part.filename).map((part) => part.name);
  const filenames = files.map((part) => part.filename);
  const session = (
    parts.find((part) => part.name === 'session_id')?.body.toString('utf8')
    || req.headers['x-session-id']
    || ''
  ).trim();
  const scenario = !sessionAllowed(session) ? '402' : scenarioOf(filenames);
  if (scenario === 'drop') {
    requests.push({ method: 'POST', path: '/jobs', status: 0, files: filenames, fields });
    req.socket.destroy();
    return;
  }
  const immediate = errorForScenario(scenario);
  if (immediate) {
    requests.push({ method: 'POST', path: '/jobs', status: immediate[0], files: filenames, fields });
    sendJson(res, immediate[0], immediate[1]);
    return;
  }
  const now = Date.now();
  const id = 'job_' + Math.random().toString(16).slice(2, 14);
  const job = {
    id,
    sessionId: session,
    filename: filenames[0] || 'manual',
    status: 'queued',
    progress: { stage: 'queued', percent: 0, message: 'Waiting to start' },
    error: null,
    warnings: [],
    coverage: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  };
  jobs.set(id, job);
  requests.push({ method: 'POST', path: '/jobs', status: 202, files: filenames, fields });
  sendJson(res, 202, publicJob(job));
  runJob(job, scenario).catch(() => {
    job.status = 'failed';
    job.error = 'Manual generation failed. Please try again.';
    job.progress = { stage: 'failed', percent: job.progress.percent || 0, message: job.error };
  });
}

async function handleLegacy(req, res) {
  const body = await readBody(req);
  const parts = parseMultipart(body, req.headers['content-type']);
  const files = parts.filter((part) => part.filename).map((part) => part.filename);
  const fields = parts.filter((part) => part.name && !part.filename).map((part) => part.name);
  const session = (
    parts.find((part) => part.name === 'session_id')?.body.toString('utf8')
    || req.headers['x-session-id']
    || ''
  ).trim();
  const scenario = !sessionAllowed(session) ? '402' : scenarioOf(files);
  if (scenario === 'drop') {
    requests.push({ method: 'POST', path: '/generate-manual', status: 0, files, fields });
    req.socket.destroy();
    return;
  }
  const immediate = errorForScenario(scenario === '404' ? 'ok' : scenario);
  if (immediate && scenario !== '404') {
    requests.push({ method: 'POST', path: '/generate-manual', status: immediate[0], files, fields });
    sendJson(res, immediate[0], immediate[1]);
    return;
  }
  requests.push({ method: 'POST', path: '/generate-manual', status: 200, files, fields });
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': PDF.length,
    'Content-Disposition': 'attachment; filename="manual.pdf"',
    Deprecation: 'true',
    Link: '</jobs>; rel="successor-version"',
    'Cache-Control': 'no-store',
  });
  res.end(PDF);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/verify-session') {
      const sessionId = (url.searchParams.get('session_id') || '').trim();
      if (sessionId === 'cs_test_drop') {
        requests.push({ method: 'GET', path: '/verify-session', status: 0, files: [], fields: [] });
        req.socket.destroy();
        return;
      }
      requests.push({ method: 'GET', path: '/verify-session', status: 200, files: [], fields: [] });
      if (sessionId === 'cs_test_local') return sendJson(res, 200, { valid: true, plan: 'starter', remaining: 3 });
      if (sessionId === 'cs_test_pro') return sendJson(res, 200, { valid: true, plan: 'pro', remaining: null });
      if (sessionId === 'cs_test_past_due') return sendJson(res, 200, { valid: true, plan: 'pro', remaining: null, payment_issue: true });
      if (sessionId === 'cs_test_payment_failed') {
        return sendJson(res, 200, { valid: false, access: false, plan: 'pro', remaining: null, reason: 'payment_failed', portal: true });
      }
      if (sessionId === 'cs_test_canceled') {
        return sendJson(res, 200, { valid: false, access: false, plan: 'pro', remaining: null, reason: 'canceled', portal: true });
      }
      if (sessionId === 'cs_test_empty') return sendJson(res, 200, { valid: true, plan: 'starter', remaining: 0 });
      return sendJson(res, 200, { valid: false, plan: null, remaining: null });
    }
    if (req.method === 'POST' && url.pathname === '/access-link') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const lowered = email.toLowerCase();
      const status = lowered === 'limited@example.com' ? 429 : lowered === 'fail@example.com' ? 500 : lowered === 'unconfigured@example.com' ? 503 : 202;
      const emailConfigured = lowered !== 'nomail@example.com';
      requests.push({ method: 'POST', path: '/access-link', status, files: [], fields: email ? ['email'] : [], email });
      if (status === 429) return sendJson(res, 429, { error: 'Too many requests' });
      if (status === 503) return sendJson(res, 503, { error: 'email_not_configured' });
      if (status === 500) return sendJson(res, 500, { error: 'Mail service unavailable' });
      if (!emailConfigured) return sendJson(res, 202, { ok: true, email_configured: false });
      return sendJson(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/billing-portal') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
      const starter = sessionId === 'cs_test_local' || sessionId === 'cs_test_empty';
      const pro = sessionId === 'cs_test_pro' || sessionId === 'cs_test_past_due' || sessionId === 'cs_test_payment_failed' || sessionId === 'cs_test_canceled';
      const status = starter ? 400 : pro ? 200 : 402;
      requests.push({ method: 'POST', path: '/billing-portal', status, files: [], fields: ['session_id'], session: sessionId });
      if (status === 400) return sendJson(res, 400, { error: 'Starter has no subscription.' });
      if (status === 402) return sendJson(res, 402, { error: 'Invalid session.' });
      return sendJson(res, 200, { url: 'http://' + req.headers.host + '/__mock/portal' });
    }
    if (req.method === 'GET' && url.pathname === '/__mock/portal') {
      const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Manage subscription</title></head><body><p>Subscription management</p></body></html>';
      const payload = Buffer.from(html);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
      res.end(payload);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/support/sms-consent') {
      const raw = await readBody(req);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = null; }
      const phone = body && typeof body.phone === 'string' ? body.phone.trim() : '';
      const version = body && body.consentTextVersion;
      const source = body && body.source;
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      const valid = phone && version === 'support-sms-v2' && source === 'website-support-form' && keys.length === 3;
      requests.push({
        method: 'POST',
        path: '/api/support/sms-consent',
        status: valid ? 200 : 400,
        files: [],
        fields: keys,
        phone,
        consentTextVersion: version,
        source,
      });
      if (!valid) return sendJson(res, 400, { error: 'Missing phone, consent version, or source.' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') return await handleJobsPost(req, res);
    if (req.method === 'POST' && url.pathname === '/generate-manual') return await handleLegacy(req, res);
    if (req.method === 'GET' && url.pathname === '/__mock/requests') return sendJson(res, 200, requests);
    if (req.method === 'POST' && url.pathname === '/__mock/release') {
      for (const resolve of holds.values()) resolve();
      holds.clear();
      return sendJson(res, 200, { released: true });
    }
    if (req.method === 'GET' && url.pathname === '/jobs' && url.searchParams.has('mine')) {
      const sessionId = headerSession(req);
      if (!sessionId) {
        requests.push({ method: 'GET', path: '/jobs?mine', status: 401, files: [], fields: [], session: '' });
        return sendJson(res, 401, { error: 'Missing session.' });
      }
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const list = [...jobs.values()].filter((job) => {
        return job.sessionId === sessionId && Date.parse(job.createdAt) >= cutoff;
      }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(mineView);
      requests.push({ method: 'GET', path: '/jobs?mine', status: 200, files: [], fields: [], session: sessionId });
      return sendJson(res, 200, { jobs: list });
    }
    const jobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && jobMatch) {
      const sessionId = headerSession(req);
      if (!sessionId) {
        requests.push({ method: 'GET', path: url.pathname, status: 401, files: [], fields: [], session: '' });
        return sendJson(res, 401, { error: 'Missing session.' });
      }
      const job = jobs.get(decodeJobId(jobMatch[1]));
      if (!job || job.sessionId !== sessionId) {
        requests.push({ method: 'GET', path: url.pathname, status: 404, files: [], fields: [], session: sessionId });
        return sendJson(res, 404, { error: 'Job not found or expired.' });
      }
      requests.push({ method: 'GET', path: url.pathname, status: 200, files: [], fields: [], session: sessionId });
      return sendJson(res, 200, publicJob(job));
    }
    const pdfMatch = /^\/jobs\/([^/]+)\/pdf$/.exec(url.pathname);
    if (req.method === 'GET' && pdfMatch) {
      const sessionId = headerSession(req);
      if (!sessionId) {
        requests.push({ method: 'GET', path: url.pathname, status: 401, files: [], fields: [], session: '' });
        return sendJson(res, 401, { error: 'Missing session.' });
      }
      const job = jobs.get(decodeJobId(pdfMatch[1]));
      if (!job || job.sessionId !== sessionId) {
        requests.push({ method: 'GET', path: url.pathname, status: 404, files: [], fields: [], session: sessionId });
        return sendJson(res, 404, { error: 'Job not found or expired.' });
      }
      if (job.status !== 'succeeded') return sendJson(res, 409, { error: 'Manual is not ready.' });
      const pdf = pdfs.get(job.id);
      if (!pdf) return sendJson(res, 404, { error: 'Job not found or expired.' });
      requests.push({ method: 'GET', path: url.pathname, status: 200, files: [], fields: [], session: sessionId });
      return sendPdf(res, pdf);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: 'Mock error' });
  }
});

const port = Number(process.env.PORT) || 0;
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`MOCK http://127.0.0.1:${address.port}`);
});
