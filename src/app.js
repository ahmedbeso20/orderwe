'use strict';
const http = require('node:http');
const { load } = require('./config');
const { openDb } = require('./db');
const { createSession } = require('./auth');
const { createModel } = require('./model');
const { createRouter, createLimiter, createStatic, readBody, clientIp, sendJson, securityHeaders } = require('./http');
const { HttpError } = require('./util');

function createApp(overrides = {}) {
  const cfg = load(overrides);
  const store = openDb(cfg.dbFile);
  const limiter = createLimiter();
  const session = createSession(cfg, store.q);
  const app = { cfg, ...store, limiter, session, model: createModel(store.q) };
  const router = createRouter();
  const serveStatic = createStatic(cfg.publicDir);

  for (const name of ['auth', 'catalog', 'orders', 'finance', 'account', 'ai']) require(`./routes/${name}`)(router, app);
  router.get('/api/health', () => ({ ok: true }), { auth: false });

  // حذف الحسابات التجريبية المنتهية (تُحذف بياناتها تلقائيًا)
  const purge = () => store.q('DELETE FROM users WHERE is_demo = 1 AND created_at < ?').run(new Date(Date.now() - cfg.demoTtlSec * 1000).toISOString());
  purge();
  const purgeTimer = setInterval(purge, 3600_000);
  purgeTimer.unref();

  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    const fHost = req.headers['x-forwarded-host'];
    const host = (cfg.trustProxy && fHost) || req.headers.host;
    try {
      const u = new URL(origin);
      if (u.host === host || (fHost && u.host === fHost)) return true;
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
      if (u.hostname.endsWith('.run.app') || u.hostname.endsWith('.google.com')) return true;
      return false;
    } catch { return true; }
  };

  async function handleApi(req, res, url) {
    const ip = clientIp(req, cfg.trustProxy);
    if (!limiter.hit(`api:${ip}`, 600, 60_000)) throw new HttpError(429, 'طلبات كثيرة، انتظر قليلًا ثم حاول مجددًا');

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const { route, params, pathMatched } = router.match(method, url.pathname);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'الطريقة غير مسموحة' : 'المسار غير موجود');

    if (method !== 'GET') { // حماية CSRF: ترويسة مخصصة + فحص Origin (مع كوكي SameSite=Lax)
      if (req.headers['x-requested-with'] !== 'omniarab' || !sameOrigin(req)) throw new HttpError(403, 'طلب غير مسموح');
    }

    const user = session.read(req);
    if (route.auth && !user) throw new HttpError(401, 'سجّل الدخول للمتابعة', { code: 'AUTH' });

    let body = {};
    if (method !== 'GET') {
      const raw = await readBody(req);
      if (raw.length) {
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'نوع المحتوى غير مدعوم');
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'صيغة JSON غير صالحة'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'صيغة الطلب غير صالحة');
      }
    }

    const out = await route.handler({ req, res, url, query: Object.fromEntries(url.searchParams), params, body, user, ip });
    if (!res.writableEnded && !res.headersSent) sendJson(res, 200, out ?? { ok: true });
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res, cfg);
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { throw new HttpError(400, 'عنوان غير صالح'); }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'الطريقة غير مسموحة');
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      console.error('[server]', e);
      sendJson(res, 500, { error: 'حدث خطأ في الخادم، حاول مجددًا.' });
    }
  });

  const close = async () => {
    clearInterval(purgeTimer);
    limiter.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    store.close();
  };

  return { server, cfg, close, app };
}

module.exports = { createApp };
