'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.zip': 'application/zip'
};

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors *";

function securityHeaders(res, cfg) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (cfg.hsts && cfg.nodeEnv === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** راوتر بسيط: مسارات مثل /api/orders/:id/status */
function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler, opts = {}) => {
    const keys = [];
    const source = pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)'));
    routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, auth: opts.auth !== false });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        try { r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); } catch { throw new HttpError(400, 'مسار غير صالح'); }
        return { route: r, params, pathMatched };
      }
      return { route: null, params: {}, pathMatched };
    }
  };
}

/** محدّد معدّل الطلبات في الذاكرة */
function createLimiter() {
  const hits = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, 60_000);
  timer.unref();
  return {
    /** true إذا ما زال الطلب ضمن الحد المسموح */
    hit(key, max, windowMs) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || v.reset <= now) { v = { n: 0, reset: now + windowMs }; hits.set(key, v); }
      return ++v.n <= max;
    },
    reset: (key) => hits.delete(key),
    stop: () => clearInterval(timer)
  };
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'حجم الطلب كبير جدًا')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]; // آخر عنوان أضافه الوسيط الموثوق
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** يقدّم ملفات public مع ETag وضغط gzip، ويرجع index.html للمسارات بدون امتداد */
function createStatic(dir) {
  const root = path.resolve(dir);
  const cache = new Map();

  const load = (abs) => {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return null;
    let c = cache.get(abs);
    if (!c || c.mtime !== st.mtimeMs) {
      const buf = fs.readFileSync(abs);
      const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      const compressible = /^(text\/|application\/(json|javascript)|image\/svg)/.test(type) && buf.length > 1024;
      c = { mtime: st.mtimeMs, buf, type, gz: compressible ? zlib.gzipSync(buf) : null, etag: `W/"${st.size}-${Math.round(st.mtimeMs)}"` };
      cache.set(abs, c);
    }
    return c;
  };

  return (req, res, pathname) => {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
    if (rel.includes('\0') || rel.split('/').some((s) => s.startsWith('.'))) return sendText(res, 404, 'غير موجود', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = path.join(root, path.normalize(rel));
    if (!abs.startsWith(root + path.sep)) return sendText(res, 403, 'ممنوع', { 'Content-Type': 'text/plain; charset=utf-8' });

    const c = load(abs) || (!path.extname(rel) ? load(path.join(root, 'index.html')) : null);
    if (!c) return sendText(res, 404, 'الصفحة غير موجودة', { 'Content-Type': 'text/plain; charset=utf-8' });

    const headers = { 'Content-Type': c.type, ETag: c.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
    const gzip = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = gzip ? c.gz : c.buf;
    if (gzip) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

module.exports = { createRouter, createLimiter, createStatic, readBody, clientIp, sendJson, sendText, securityHeaders };
