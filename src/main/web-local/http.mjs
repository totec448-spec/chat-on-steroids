/**
 * Opt-in, loopback-only browser view of a deliberately narrow CoS read.
 * The Electron owner chooses when to listen and which data is projected.
 * This module has no access to IPC, Control API tokens, or the filesystem.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { webLocalMessagesFor } from './messages.mjs';

const TOKEN_BYTES = 32;
const TICKET_LIFE = 90_000;
const SESSION_LIFE = 30 * 60_000;
const MAX_TICKETS = 4;
const MAX_READS = 2;
const MAX_REPLY_BYTES = 64 * 1024;
const CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const token = () => randomBytes(TOKEN_BYTES).toString('base64url');
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const equal = (a, b) => typeof a === 'string' && tokenShape.test(a) && b &&
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function reply(res, code, body = '', type = 'text/plain; charset=utf-8', headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(code, { 'content-type': type, ...headers });
  res.end(body);
}

function jsonError(res, code, error) {
  reply(res, code, JSON.stringify({ error }), 'application/json; charset=utf-8');
}

function cookieFrom(header, name) {
  if (typeof header !== 'string') return null;
  const values = header.split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

function page(data, path, { language, strings: copy }) {
  if (!data || !Array.isArray(data.projects) ||
      data.projects.some(project => typeof project?.name !== 'string')) {
    throw new TypeError('invalid_owner_snapshot');
  }
  // A bounded view must stay renderable even when every valid project name
  // expands into multiple HTML entities. Deep catalog views are not M0.
  const projects = data.projects.slice(0, 50);
  const rows = projects.map(project =>
    '<li>' + escapeHtml(project.name).slice(0, 320) + '</li>').join('');
  return '<!doctype html><html lang="' + language + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(copy.title) + '</title></head><body>' +
    '<main><h1>Chat On Steroids · Web Local</h1>' +
    '<p><strong>' + escapeHtml(copy.readonly) + '</strong> — ' + escapeHtml(copy.intro) + '</p>' +
    '<h2>' + escapeHtml(copy.projects) + '</h2>' +
    (rows ? '<ul>' + rows + '</ul>' : '<p>' + escapeHtml(copy.empty) + '</p>') +
    (data.projects.length > 50 ? '<p>' + escapeHtml(copy.limited) + '</p>' : '') +
    '<p><a href="' + path + '">' + escapeHtml(copy.refresh) + '</a></p>' +
    '<p>' + escapeHtml(copy.unavailable) + '</p>' +
    '</main></body></html>';
}

export function createWebLocalServer({ read, now = Date.now, readDeadlineMs = 3000, drainMs = 2000,
  onDecision = () => {}, language = 'en' }) {
  if (typeof read !== 'function' || typeof now !== 'function' || typeof onDecision !== 'function' ||
      (typeof language !== 'string' && typeof language !== 'function') ||
      !Number.isSafeInteger(readDeadlineMs) || readDeadlineMs < 1 || readDeadlineMs > 10000 ||
      !Number.isSafeInteger(drainMs) || drainMs < 1 || drainMs > 5000) {
    throw new TypeError('invalid_web_local_options');
  }
  // Cookies are scoped to host/path, *never* to TCP port. A random path and
  // per-listener name limit accidental sharing, not a hostile matching path.
  const scope = '/web/' + token() + '/';
  const name = 'cos_local_' + randomBytes(8).toString('hex');
  const tickets = new Map();
  let active = null;
  let expires = 0;
  let stopped = false;
  let stopPromise = null;
  let unfinishedReads = 0;
  let ownerReadFailureReported = false;
  let projectsViewReported = false;

  // Only fixed, low-volume outcomes can reach the Desktop diagnostics owner.
  // Never forward request targets, headers, ticket values, cookies or owner errors.
  const decide = kind => { try { onDecision(kind); } catch { /* Diagnostics must not affect HTTP. */ } };
  const noteOwnerReadFailure = () => {
    if (!ownerReadFailureReported) {
      ownerReadFailureReported = true;
      decide('owner_read_unavailable');
    }
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : null;
    const expectedHost = port ? '127.0.0.1:' + port : '';
    if (stopped || !port) return jsonError(res, 503, 'unavailable');
    if (req.socket.remoteAddress !== '127.0.0.1' ||
        req.headers.host !== expectedHost ||
        (req.headers.origin !== undefined && req.headers.origin !== 'http://' + expectedHost) ||
        (req.headers['sec-fetch-site'] !== undefined &&
         !['none', 'same-origin'].includes(req.headers['sec-fetch-site']))) {
      req.resume();
      return jsonError(res, 403, 'forbidden');
    }
    const target = req.url ?? '';
    if (!/^\/[A-Za-z0-9_/-]*$/.test(target) || target.startsWith('//')) {
      req.resume();
      return jsonError(res, 400, 'invalid_target');
    }
    if (req.method !== 'GET') {
      req.resume();
      return reply(res, 405, JSON.stringify({ error: 'method_not_allowed' }),
        'application/json; charset=utf-8', { allow: 'GET' });
    }
    if (req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      req.resume();
      return jsonError(res, 413, 'body_not_allowed');
    }
    const claim = /^\/activate\/([A-Za-z0-9_-]{43})$/.exec(target);
    if (claim) {
      const valid = tickets.get(claim[1]);
      if (!valid || now() >= valid) return jsonError(res, 404, 'not_found');
      tickets.delete(claim[1]); // spend before publishing a browser session
      active = token();
      expires = now() + SESSION_LIFE;
      decide('activation_accepted');
      return reply(res, 303, '', 'text/plain; charset=utf-8', {
        location: scope,
        'set-cookie': name + '=' + active + '; HttpOnly; SameSite=Strict; Path=' + scope + '; Max-Age=1800'
      });
    }
    if (target !== scope || !active || now() >= expires ||
        !equal(cookieFrom(req.headers.cookie, name), active)) {
      return jsonError(res, 401, 'local_activation_required');
    }
    if (unfinishedReads >= MAX_READS) return jsonError(res, 503, 'busy');
    const admittedSession = active;
    unfinishedReads++;
    const work = Promise.resolve().then(read);
    work.then(() => { unfinishedReads--; }, () => { unfinishedReads--; });
    let timer;
    try {
      const result = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('read_deadline')), readDeadlineMs);
          timer.unref?.();
        })
      ]);
      if (stopped || active !== admittedSession || now() >= expires) return jsonError(res, 503, 'unavailable');
      let requested = 'en';
      try { requested = typeof language === 'function' ? language() : language; }
      catch { /* Locale availability must not block a valid read. */ }
      const body = page(result, scope, webLocalMessagesFor(requested));
      if (Buffer.byteLength(body) > MAX_REPLY_BYTES) {
        noteOwnerReadFailure();
        return jsonError(res, 503, 'read_unavailable');
      }
      reply(res, 200, body, 'text/html; charset=utf-8');
      if (!projectsViewReported && res.headersSent && !res.destroyed) {
        projectsViewReported = true;
        decide('projects_view_served');
      }
    } catch {
      noteOwnerReadFailure();
      jsonError(res, 503, 'read_unavailable');
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  server.on('checkContinue', (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    jsonError(res, 417, 'expectation_failed');
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 20_000;
  server.maxRequestsPerSocket = 100;

  return Object.freeze({
    server,
    issueActivation() {
      if (!server.listening || stopped) throw new Error('local_web_not_listening');
      for (const [item, until] of tickets) if (now() >= until) tickets.delete(item);
      if (tickets.size >= MAX_TICKETS) throw new Error('local_web_busy');
      const ticket = token();
      tickets.set(ticket, now() + TICKET_LIFE);
      return '/activate/' + ticket;
    },
    revokeActivation(path) {
      const match = /^\/activate\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (match) tickets.delete(match[1]);
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      tickets.clear();
      active = null;
      expires = 0;
      if (!server.listening) return Promise.resolve();
      stopPromise = new Promise(resolve => {
        const timer = setTimeout(() => server.closeAllConnections(), drainMs);
        timer.unref?.();
        server.close(() => { clearTimeout(timer); resolve(); });
        server.closeIdleConnections();
      });
      return stopPromise;
    }
  });
}
