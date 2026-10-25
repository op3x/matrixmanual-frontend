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
const tokens = new Map();
const requests = [];
const configWaiters = [];
const checkoutConfig = { managedPayments: true, fail: false, hold: false, portalFail: false, accessFail: false, portalStatus: 0, accessStatus: 0, pauseCheckout: false };

const REFUND_MESSAGE = 'This purchase was refunded, so it can no longer generate manuals. Contact support@manualos.com.';
const SESSIONS = {
  cs_test_local: { valid: true, plan: 'starter', remaining: 3, billingIssue: false },
  cs_test_pro: { valid: true, plan: 'pro', remaining: null, billingIssue: false },
  cs_test_empty: { valid: true, plan: 'starter', remaining: 0, billingIssue: false },
  cs_test_past_due: { valid: true, plan: 'pro', remaining: null, billingIssue: true },
  cs_test_compat: { valid: true, plan: 'starter', remaining: 3, billingIssue: false, compat: true },
  cs_test_canceled: { blocked: 403, plan: 'pro', error: 'This purchase is not active.', code: 'purchase_inactive' },
  cs_test_refunded: { blocked: 403, plan: 'starter', error: REFUND_MESSAGE, code: 'purchase_inactive', pdfStatus: 402 },
};
const FIELD_LIMITS = {
  manufacturer_name: 200,
  product_name: 200,
  model: 200,
  brand: 200,
  manufacturer_address: 200,
  doc_number: 80,
  language: 80,
  revision: 40,
  date: 40,
};

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

function sendPdf(res, body, filename) {
  const name = String(filename || 'manualos-manual.pdf').replace(/"/g, '');
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function publicJob(job) {
  const body = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    warnings: job.warnings,
    coverage: job.coverage,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
  if (job.ignored) body.ignored = job.ignored;
  return body;
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
  if (name === 'limit.l5x') return '429';
  return 'ok';
}

function record(req, entry) {
  requests.push({
    method: entry.method,
    path: entry.path,
    status: entry.status,
    files: entry.files || [],
    fields: entry.fields || [],
    authorization: String(req.headers.authorization || ''),
    sessionHeader: String(req.headers['x-session-id'] || ''),
  });
}

function bearerValue(req) {
  const match = /^Bearer\s+(\S+)/i.exec(String(req.headers.authorization || '').trim());
  return match ? match[1] : '';
}

function lookupToken(token) {
  const row = tokens.get(token);
  if (!row || row.revoked) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) return null;
  return row;
}

function resolveCaller(req, parts) {
  const bearer = bearerValue(req);
  if (bearer) {
    const row = lookupToken(bearer);
    if (!row) return { error: 'token' };
    return { sessionId: row.sessionId };
  }
  const header = String(req.headers['x-session-id'] || '').trim();
  const formPart = parts && parts.find((part) => part.name === 'session_id' && !part.filename);
  const form = formPart ? formPart.body.toString('utf8').trim() : '';
  const sessionId = header || form;
  if (!sessionId) return { error: 'missing' };
  return { sessionId };
}

function fieldValue(parts, name) {
  const part = parts.find((item) => item.name === name && !item.filename);
  return part ? part.body.toString('utf8').trim() : '';
}

function fieldLengthError(parts) {
  for (const [name, max] of Object.entries(FIELD_LIMITS)) {
    const value = fieldValue(parts, name);
    if (value.length > max) {
      return { error: `${name} must be at most ${max} characters.`, code: 'field_too_long' };
    }
  }
  return null;
}

function downloadFilename(product, manufacturer) {
  const source = String(product || manufacturer || '').normalize('NFKD');
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${slug || 'manualos'}-manual.pdf`;
}

function generationBlock(sessionId) {
  const row = SESSIONS[sessionId];
  if (!row) return [404, { error: 'No purchase was found for this session.', code: 'purchase_not_found' }];
  if (row.pdfStatus === 402) return [402, { error: row.error }];
  if (row.blocked) return [row.blocked, { error: row.error, code: row.code }];
  if (row.remaining === 0) return [402, { error: 'Starter credits are used up.' }];
  return null;
}

function accessView(sessionId) {
  const row = SESSIONS[sessionId];
  if (!row || row.blocked) {
    return {
      valid: false,
      plan: row && row.plan ? row.plan : null,
      remaining: null,
      billingIssue: false,
    };
  }
  return {
    valid: true,
    plan: row.plan,
    remaining: row.remaining,
    billingIssue: !!row.billingIssue,
  };
}

function mintToken(sessionId) {
  const view = accessView(sessionId);
  const accessToken = `tok_${sessionId}_${Math.random().toString(16).slice(2)}`;
  const expiresAt = new Date(Date.now() + 7200 * 1000).toISOString();
  tokens.set(accessToken, { sessionId, expiresAt, revoked: false });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 7200,
    expires_at: expiresAt,
    ...view,
  };
}

function listJobs(sessionId) {
  return [...jobs.values()]
    .filter((job) => job.sessionId === sessionId && job.status === 'succeeded' && pdfs.has(job.id))
    .filter((job) => {
      const expiresAt = Date.parse(job.expiresAt);
      return !Number.isFinite(expiresAt) || expiresAt > Date.now();
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      filename: job.filename,
      download_path: `/jobs/${job.id}/pdf`,
    }));
}

function authorizeJobRead(req) {
  const caller = resolveCaller(req, null);
  if (caller.error === 'token') {
    return { failure: [401, { error: 'Access token is invalid or expired.', code: 'access_token_invalid' }] };
  }
  if (caller.error === 'missing') {
    return { failure: [404, { error: 'Job not found or expired.' }] };
  }
  return { sessionId: caller.sessionId };
}

function errorForScenario(scenario) {
  if (scenario === '402') return [402, { error: 'Starter credits are used up.' }];
  if (scenario === '415') return [415, { error: 'This file is not a supported project format.' }];
  if (scenario === '422') return [422, { error: 'This file does not contain equipment data that can be read.' }];
  if (scenario === '503') return [503, { error: 'Manual generation is temporarily unavailable.' }];
  if (scenario === '404') return [404, { error: 'Not found' }];
  if (scenario === '429') return [429, { error: 'Too many requests.' }];
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

function screenUpload(req, parts, filenames) {
  const caller = resolveCaller(req, parts);
  if (caller.error === 'token') {
    return { response: [401, { error: 'Access token is invalid or expired.', code: 'access_token_invalid' }] };
  }
  if (caller.error === 'missing') {
    return { response: [402, { error: 'Payment required. Provide session_id in the form body or the X-Session-Id header.' }] };
  }
  if (filenames.some((name) => name.toLowerCase() === 'counted.l5x') || filenames.length > 25) {
    return { response: [400, { error: 'Too many files. Send at most 25.', code: 'too_many_files' }] };
  }
  if (filenames.some((name) => name.toLowerCase() === 'overlimit.l5x')) {
    return { response: [400, { error: 'Upload failed.' }] };
  }
  const lengthError = fieldLengthError(parts);
  if (lengthError) return { response: [400, lengthError] };
  const blocked = generationBlock(caller.sessionId);
  if (blocked) return { response: blocked };
  return { sessionId: caller.sessionId };
}

async function handleJobsPost(req, res) {
  const body = await readBody(req);
  const parts = parseMultipart(body, req.headers['content-type']);
  const files = parts.filter((part) => part.filename);
  const fields = parts.filter((part) => part.name && !part.filename).map((part) => part.name);
  const filenames = files.map((part) => part.filename);
  const screened = screenUpload(req, parts, filenames);
  if (screened.response) {
    record(req, { method: 'POST', path: '/jobs', status: screened.response[0], files: filenames, fields });
    sendJson(res, screened.response[0], screened.response[1]);
    return;
  }
  const lower = filenames.map((name) => name.toLowerCase());
  if (lower.includes('again.l5x') && fieldValue(parts, 'confirmDuplicate') !== 'true') {
    const existingId = 'job_existing';
    if (!jobs.has(existingId)) {
      const now = Date.now();
      jobs.set(existingId, {
        id: existingId,
        sessionId: screened.sessionId,
        filename: 'existing-manual.pdf',
        status: 'succeeded',
        progress: { stage: 'done', percent: 100, message: 'Manual is ready' },
        error: null,
        warnings: [],
        coverage: null,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      });
      pdfs.set(existingId, PDF);
    }
    record(req, { method: 'POST', path: '/jobs', status: 409, files: filenames, fields });
    sendJson(res, 409, { error: 'Duplicate upload.', code: 'duplicate_upload', jobId: existingId });
    return;
  }
  if (lower.includes('huge.l5x')) {
    const limit = 25 * 1024 * 1024;
    record(req, { method: 'POST', path: '/jobs', status: 413, files: filenames, fields });
    sendJson(res, 413, {
      error: 'File is too large.',
      code: 'file_too_large',
      files: [
        { name: 'huge.L5X', size: limit + 200000, limit },
        { name: 'huge.L5X', size: limit + 200000, limit },
        { name: 'nested/not-chosen.L5X', size: 30 * 1024 * 1024, limit },
      ],
    });
    return;
  }
  if (lower.includes('blank.l5x')) {
    record(req, { method: 'POST', path: '/jobs', status: 422, files: filenames, fields });
    sendJson(res, 422, {
      error: 'Empty file.',
      code: 'empty_file',
      files: [{ name: 'blank.L5X' }, { name: 'blank.L5X' }, { name: 'nested/empty-inside.L5X' }],
    });
    return;
  }
  if (lower.includes('many.l5x')) {
    record(req, { method: 'POST', path: '/jobs', status: 400, files: filenames, fields });
    sendJson(res, 400, {
      error: 'Too many files.',
      code: 'too_many_files',
      picked: 30,
      limit: 25,
      files: [{ name: 'nested/extra-one.L5X' }],
    });
    return;
  }
  if (lower.includes('paused.l5x')) {
    record(req, { method: 'POST', path: '/jobs', status: 503, files: filenames, fields });
    sendJson(res, 503, {
      code: 'generation_paused',
      message: 'Generation is paused. Please try again later.',
    });
    return;
  }
  if (lower.includes('quietpause.l5x')) {
    record(req, { method: 'POST', path: '/jobs', status: 503, files: filenames, fields });
    sendJson(res, 503, { code: 'generation_paused' });
    return;
  }
  if (lower.includes('badmsg.l5x')) {
    record(req, { method: 'POST', path: '/jobs', status: 503, files: filenames, fields });
    sendJson(res, 503, { code: 'generation_paused', message: '<b>paused</b>' });
    return;
  }
  if (lower.includes('largejob.l5x')) {
    record(req, { method: 'POST', path: '/jobs', status: 413, files: filenames, fields });
    sendJson(res, 413, {
      code: 'job_too_large',
      message: 'This job is too large to generate.',
    });
    return;
  }
  if (lower.includes('noted.l5x')) {
    record(req, { method: 'POST', path: '/jobs', status: 413, files: filenames, fields });
    sendJson(res, 413, {
      error: 'File is too large.',
      code: 'file_too_large',
      message: 'noted.L5X is larger than the upload limit.',
      files: [
        { name: 'noted.L5X', size: 30 * 1024 * 1024, limit: 25 * 1024 * 1024 },
        { name: 'nested/not-chosen.L5X', size: 30 * 1024 * 1024, limit: 25 * 1024 * 1024 },
      ],
    });
    return;
  }
  const scenario = scenarioOf(filenames);
  if (scenario === 'drop') {
    record(req, { method: 'POST', path: '/jobs', status: 0, files: filenames, fields });
    req.socket.destroy();
    return;
  }
  const immediate = errorForScenario(scenario);
  if (immediate) {
    record(req, { method: 'POST', path: '/jobs', status: immediate[0], files: filenames, fields });
    sendJson(res, immediate[0], immediate[1]);
    return;
  }
  const now = Date.now();
  const id = 'job_' + Math.random().toString(16).slice(2, 14);
  const job = {
    id,
    sessionId: screened.sessionId,
    filename: downloadFilename(fieldValue(parts, 'product_name'), fieldValue(parts, 'manufacturer_name')),
    status: 'queued',
    progress: { stage: 'queued', percent: 0, message: 'Waiting to start' },
    error: null,
    warnings: [],
    coverage: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  };
  if (lower.includes('twin.l5x')) {
    job.ignored = [
      { name: 'twin.L5X', duplicateOf: 'other.L5X' },
      { name: 'nested/copy.L5X' },
    ];
  }
  jobs.set(id, job);
  record(req, { method: 'POST', path: '/jobs', status: 202, files: filenames, fields });
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
  const screened = screenUpload(req, parts, files);
  if (screened.response) {
    record(req, { method: 'POST', path: '/generate-manual', status: screened.response[0], files, fields });
    sendJson(res, screened.response[0], screened.response[1]);
    return;
  }
  const scenario = scenarioOf(files);
  if (scenario === 'drop') {
    record(req, { method: 'POST', path: '/generate-manual', status: 0, files, fields });
    req.socket.destroy();
    return;
  }
  const immediate = errorForScenario(scenario === '404' ? 'ok' : scenario);
  if (immediate && scenario !== '404') {
    record(req, { method: 'POST', path: '/generate-manual', status: immediate[0], files, fields });
    sendJson(res, immediate[0], immediate[1]);
    return;
  }
  record(req, { method: 'POST', path: '/generate-manual', status: 200, files, fields });
  const filename = downloadFilename(fieldValue(parts, 'product_name'), fieldValue(parts, 'manufacturer_name'));
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': PDF.length,
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    Deprecation: 'true',
    Link: '</jobs>; rel="successor-version"',
    'Cache-Control': 'no-store',
  });
  res.end(PDF);
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  try { return JSON.parse(body.toString('utf8')); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (req.method === 'POST' && url.pathname === '/access-token') {
      const payload = await readJsonBody(req);
      if (payload === null) {
        record(req, { method: 'POST', path: '/access-token', status: 400 });
        return sendJson(res, 400, { error: 'Invalid request body.' });
      }
      const sessionId = String(payload.session_id || '').trim();
      if (sessionId === 'cs_test_limit') {
        record(req, { method: 'POST', path: '/access-token', status: 429 });
        return sendJson(res, 429, { error: 'Too many requests.' });
      }
      if (sessionId === 'cs_test_drop') {
        record(req, { method: 'POST', path: '/access-token', status: 0 });
        req.socket.destroy();
        return;
      }
      if (!sessionId) {
        record(req, { method: 'POST', path: '/access-token', status: 400 });
        return sendJson(res, 400, { error: 'session_id is required.' });
      }
      const row = SESSIONS[sessionId];
      if (row && row.compat) {
        record(req, { method: 'POST', path: '/access-token', status: 503 });
        return sendJson(res, 503, { error: 'Access tokens are temporarily unavailable.' });
      }
      if (!row) {
        record(req, { method: 'POST', path: '/access-token', status: 404 });
        return sendJson(res, 404, { error: 'No purchase was found for this session.', code: 'purchase_not_found' });
      }
      if (row.blocked) {
        record(req, { method: 'POST', path: '/access-token', status: row.blocked });
        return sendJson(res, row.blocked, { error: row.error, code: row.code });
      }
      record(req, { method: 'POST', path: '/access-token', status: 200 });
      return sendJson(res, 200, mintToken(sessionId));
    }
    if (req.method === 'POST' && url.pathname === '/access-token/revoke') {
      const row = tokens.get(bearerValue(req));
      if (!row || row.revoked || Date.parse(row.expiresAt) <= Date.now()) {
        record(req, { method: 'POST', path: '/access-token/revoke', status: 401 });
        return sendJson(res, 401, { error: 'Access token is invalid or expired.', code: 'access_token_invalid' });
      }
      row.revoked = true;
      record(req, { method: 'POST', path: '/access-token/revoke', status: 200 });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/verify-session') {
      const querySession = (url.searchParams.get('session_id') || '').trim();
      if (!bearerValue(req) && querySession === 'cs_test_drop') {
        record(req, { method: 'GET', path: '/verify-session', status: 0 });
        req.socket.destroy();
        return;
      }
      const bearer = bearerValue(req);
      if (bearer && !lookupToken(bearer)) {
        record(req, { method: 'GET', path: '/verify-session', status: 401 });
        return sendJson(res, 401, { error: 'Access token is invalid or expired.', code: 'access_token_invalid' });
      }
      const sessionId = bearer ? lookupToken(bearer).sessionId : querySession;
      if (!sessionId) {
        record(req, { method: 'GET', path: '/verify-session', status: 400 });
        return sendJson(res, 400, { error: 'session_id is required' });
      }
      record(req, { method: 'GET', path: '/verify-session', status: 200 });
      return sendJson(res, 200, accessView(sessionId));
    }
    if (req.method === 'GET' && url.pathname === '/jobs') {
      const caller = resolveCaller(req, null);
      if (caller.error === 'token') {
        record(req, { method: 'GET', path: '/jobs', status: 401 });
        return sendJson(res, 401, { error: 'Access token is invalid or expired.', code: 'access_token_invalid' });
      }
      if (caller.error === 'missing') {
        record(req, { method: 'GET', path: '/jobs', status: 401 });
        return sendJson(res, 401, { error: 'Authorization is required.', code: 'authorization_required' });
      }
      record(req, { method: 'GET', path: '/jobs', status: 200 });
      return sendJson(res, 200, { jobs: listJobs(caller.sessionId) });
    }
    if (req.method === 'GET' && url.pathname === '/api/checkout-config') {
      if (checkoutConfig.hold) await new Promise((resolve) => { configWaiters.push(resolve); });
      const managedPayments = checkoutConfig.managedPayments === true;
      if (checkoutConfig.fail) {
        requests.push({ method: 'GET', path: '/api/checkout-config', status: 500, files: [], fields: [], managedPayments });
        req.socket.destroy();
        return;
      }
      requests.push({ method: 'GET', path: '/api/checkout-config', status: 200, files: [], fields: [], managedPayments });
      return sendJson(res, 200, { managedPayments });
    }
    if (req.method === 'POST' && url.pathname === '/__mock/checkout-config') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      if (typeof body.managedPayments === 'boolean') checkoutConfig.managedPayments = body.managedPayments;
      if (typeof body.fail === 'boolean') checkoutConfig.fail = body.fail;
      if (typeof body.hold === 'boolean') checkoutConfig.hold = body.hold;
      if (typeof body.portalFail === 'boolean') checkoutConfig.portalFail = body.portalFail;
      if (typeof body.accessFail === 'boolean') checkoutConfig.accessFail = body.accessFail;
      if (typeof body.portalStatus === 'number') checkoutConfig.portalStatus = body.portalStatus;
      if (typeof body.accessStatus === 'number') checkoutConfig.accessStatus = body.accessStatus;
      if (typeof body.pauseCheckout === 'boolean') checkoutConfig.pauseCheckout = body.pauseCheckout;
      if (body.release === true) {
        checkoutConfig.hold = false;
        const pending = configWaiters.splice(0, configWaiters.length);
        for (const resolve of pending) resolve();
      }
      return sendJson(res, 200, checkoutConfig);
    }
    if (req.method === 'POST' && url.pathname === '/api/support/sms-consent') {
      const raw = await readBody(req);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = null; }
      const phone = body && typeof body.phone === 'string' ? body.phone.trim() : '';
      const version = body && body.consentTextVersion;
      const consentText = body && body.consentText;
      const source = body && body.source;
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      const label = 'Yes, text me at this number. I agree to receive support replies and order/manual-status texts from ManualOS (Op3x LLC). Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel. Consent is not a condition of purchase. See Terms (/terms.html#sms) and Privacy (/privacy.html#sms).';
      const valid = phone && version === 'support-sms-v3' && consentText === label && source === 'website-support-form';
      requests.push({
        method: 'POST',
        path: '/api/support/sms-consent',
        status: valid ? 200 : 400,
        files: [],
        fields: keys,
        phone,
        consentTextVersion: version,
        consentText,
        source,
      });
      if (!valid) return sendJson(res, 400, { error: 'Missing phone, consent version, or source.' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/create-checkout-session') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      const plan = body && body.plan;
      if (checkoutConfig.pauseCheckout) {
        const paused = { code: 'checkout_paused' };
        if (plan !== 'pro') paused.message = 'Checkout is paused. Please try again later.';
        requests.push({
          method: 'POST',
          path: '/create-checkout-session',
          status: 503,
          files: [],
          fields: body && typeof body === 'object' ? Object.keys(body) : [],
          plan,
        });
        return sendJson(res, 503, paused);
      }
      const known = plan === 'starter' || plan === 'pro' || plan === 'integrator';
      const ok = known && body.termsAccepted === true && !Object.prototype.hasOwnProperty.call(body, 'termsConsent') && typeof body.renewalConsent === 'boolean' && typeof body.termsVersion === 'string' && typeof body.disclosureVersion === 'string';
      requests.push({
        method: 'POST',
        path: '/create-checkout-session',
        status: ok ? 200 : 400,
        files: [],
        fields: body && typeof body === 'object' ? Object.keys(body) : [],
        plan,
        renewalConsent: body.renewalConsent,
        termsAccepted: body.termsAccepted,
        termsVersion: body.termsVersion,
        disclosureVersion: body.disclosureVersion,
        interval: body.interval,
      });
      if (!ok) return sendJson(res, 400, { error: 'Consent required.' });
      const sessionId = plan === 'pro' ? 'cs_test_pro' : 'cs_test_local';
      return sendJson(res, 200, { url: '/upload.html?session_id=' + sessionId });
    }
    if (req.method === 'POST' && url.pathname === '/billing-portal') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      const email = body && typeof body.email === 'string' ? body.email.trim() : '';
      const sessionId = body && typeof body.session_id === 'string' ? body.session_id.trim() : '';
      const token = body && typeof body.token === 'string' ? body.token.trim() : '';
      const ok = Boolean(token) !== Boolean(sessionId);
      const status = checkoutConfig.portalStatus || (checkoutConfig.portalFail ? 500 : (ok ? 200 : 400));
      requests.push({
        method: 'POST',
        path: '/billing-portal',
        status,
        files: [],
        fields: body && typeof body === 'object' ? Object.keys(body) : [],
        email,
        session_id: sessionId,
        token,
      });
      if (status === 429) return sendJson(res, 429, { error: 'Too many requests.' });
      if (status >= 500) return sendJson(res, status, { error: 'Portal unavailable.' });
      if (status === 400 || !ok) return sendJson(res, 400, { error: 'This cancel link is invalid or expired.' });
      return sendJson(res, 200, { url: '/refunds.html?portal=1' });
    }
    if (req.method === 'POST' && url.pathname === '/access-link') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
      const email = body && typeof body.email === 'string' ? body.email.trim() : '';
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      const status = checkoutConfig.accessStatus || (checkoutConfig.accessFail ? 500 : (validEmail ? 202 : 400));
      requests.push({
        method: 'POST',
        path: '/access-link',
        status,
        files: [],
        fields: body && typeof body === 'object' ? Object.keys(body) : [],
        email,
      });
      if (status === 429) return sendJson(res, 429, { error: 'Too many requests.' });
      if (status >= 500) return sendJson(res, status, { error: 'Access link unavailable.' });
      if (status === 400 || !validEmail) return sendJson(res, 400, { error: 'Email required.' });
      return sendJson(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') return await handleJobsPost(req, res);
    if (req.method === 'POST' && url.pathname === '/generate-manual') return await handleLegacy(req, res);
    if (req.method === 'GET' && url.pathname === '/__mock/requests') return sendJson(res, 200, requests);
    if (req.method === 'POST' && url.pathname === '/__mock/release') {
      for (const resolve of holds.values()) resolve();
      holds.clear();
      return sendJson(res, 200, { released: true });
    }
    const jobMatch = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && jobMatch) {
      const auth = authorizeJobRead(req);
      if (auth.failure) return sendJson(res, auth.failure[0], auth.failure[1]);
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job || job.sessionId !== auth.sessionId) return sendJson(res, 404, { error: 'Job not found or expired.' });
      return sendJson(res, 200, publicJob(job));
    }
    const pdfMatch = /^\/jobs\/([^/]+)\/pdf$/.exec(url.pathname);
    if (req.method === 'GET' && pdfMatch) {
      const auth = authorizeJobRead(req);
      if (auth.failure) return sendJson(res, auth.failure[0], auth.failure[1]);
      const job = jobs.get(decodeURIComponent(pdfMatch[1]));
      if (!job || job.sessionId !== auth.sessionId) return sendJson(res, 404, { error: 'Job not found or expired.' });
      const owner = SESSIONS[job.sessionId];
      if (owner && owner.pdfStatus === 402) return sendJson(res, 402, { error: owner.error });
      if (job.status !== 'succeeded') return sendJson(res, 409, { error: 'Manual is not ready.' });
      const pdf = pdfs.get(job.id);
      if (!pdf) return sendJson(res, 404, { error: 'Job not found or expired.' });
      record(req, { method: 'GET', path: `/jobs/${job.id}/pdf`, status: 200 });
      return sendPdf(res, pdf, job.filename);
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
