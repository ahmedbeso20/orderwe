'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* ملف .env اختياري */ }

const flag = (v, dflt) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

/** يبني الإعدادات من متغيرات البيئة، ويمكن تجاوزها (للاختبارات) عبر o */
function load(o = {}) {
  const e = process.env;
  const dataDir = path.resolve(o.dataDir || e.DATA_DIR || path.join(ROOT, 'data'));
  const dbFile = o.dbFile || path.join(dataDir, 'omniarab.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const production = (o.nodeEnv || e.NODE_ENV) === 'production';
  const isCloud = Boolean(e.K_SERVICE || e.APP_URL || production);
  const isHttps = Boolean((e.APP_URL && e.APP_URL.startsWith('https')) || production);

  let secret = o.secret || e.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    const file = path.join(dataDir, '.session-secret');
    try { secret = fs.readFileSync(file, 'utf8').trim(); } catch { /* سيُولَّد */ }
    if (!secret || secret.length < 32) {
      fs.mkdirSync(dataDir, { recursive: true });
      secret = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }

  return Object.freeze({
    port: +(o.port ?? e.PORT ?? 3000),
    host: o.host || e.HOST || '0.0.0.0',
    dbFile,
    publicDir: path.join(ROOT, 'public'),
    secret,
    cookieName: 'omni_sid',
    secureCookie: flag(o.secureCookie ?? e.COOKIE_SECURE, isHttps),
    hsts: production,
    trustProxy: flag(o.trustProxy ?? e.TRUST_PROXY, isCloud || true),
    geminiKey: o.geminiKey ?? e.GEMINI_API_KEY ?? '',
    geminiModel: o.geminiModel || e.GEMINI_MODEL || 'gemini-3-flash-preview',
    allowPlanSelfService: flag(o.allowPlanSelfService ?? e.ALLOW_PLAN_SELF_SERVICE, true),
    maxDemos: +(o.maxDemos ?? e.MAX_DEMOS ?? 500),
    demoTtlSec: 24 * 3600,
    fetch: o.fetch || globalThis.fetch
  });
}

module.exports = { load };
