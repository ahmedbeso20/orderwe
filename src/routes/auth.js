'use strict';
const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('../auth');
const { HttpError, bad, text, phone, email, password, clean, nowIso } = require('../util');
const { seedDemo } = require('../seed');

const BAD_LOGIN = 'بيانات الدخول غير صحيحة';

module.exports = (r, app) => {
  const { q, tx, cfg, limiter, session, model } = app;
  const dummyHash = hashPassword(crypto.randomBytes(12).toString('hex')); // يُستخدم لتمويه زمن الرد عند عدم وجود الحساب

  r.post('/api/auth/register', async ({ body, res, ip }) => {
    if (!limiter.hit(`reg:${ip}`, 10, 3600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقًا');
    const store = text(body.store, 'اسم المتجر', { min: 2, max: 60 });
    const ph = phone(body.phone);
    const mail = email(body.email);
    const pw = password(body.password, ph);
    if (q('SELECT 1 FROM users WHERE phone = ?').get(ph)) throw new HttpError(409, 'رقم الموبايل مسجّل بالفعل، جرّب تسجيل الدخول');
    if (mail && q('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new HttpError(409, 'البريد الإلكتروني مسجّل بالفعل');
    const hash = await hashPassword(pw);
    let id;
    try {
      id = q('INSERT INTO users (phone,email,pass_hash,store_name,created_at) VALUES (?,?,?,?,?)')
        .run(ph, mail, hash, store, nowIso()).lastInsertRowid;
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'الحساب مسجّل بالفعل');
      throw e;
    }
    const token = session.issue(res, q('SELECT * FROM users WHERE id = ?').get(id));
    return { ok: true, token };
  }, { auth: false });

  r.post('/api/auth/login', async ({ body, res, ip }) => {
    const raw = clean(body.id);
    const pw = String(body.password ?? '');
    if (!raw || !pw) throw bad('أدخل رقم الموبايل أو البريد الإلكتروني وكلمة المرور');
    const byMail = raw.includes('@');
    let ident;
    try { ident = byMail ? raw.toLowerCase() : phone(raw); } catch { throw new HttpError(401, BAD_LOGIN); }
    if (!limiter.hit(`login-ip:${ip}`, 30, 600_000) || !limiter.hit(`login-id:${ident}`, 8, 600_000)) throw new HttpError(429, 'محاولات دخول كثيرة، انتظر ١٠ دقائق ثم حاول مجددًا');
    const u = q(`SELECT * FROM users WHERE ${byMail ? 'email' : 'phone'} = ? AND is_demo = 0`).get(ident);
    const ok = await verifyPassword(pw, u ? u.pass_hash : await dummyHash);
    if (!u || !ok) throw new HttpError(401, BAD_LOGIN);
    limiter.reset(`login-id:${ident}`);
    const token = session.issue(res, u);
    return { ok: true, token };
  }, { auth: false });

  // حساب تجريبي مؤقت ببيانات جاهزة (يُحذف بعد ٢٤ ساعة)
  r.post('/api/auth/demo', async ({ res, ip }) => {
    if (!limiter.hit(`demo:${ip}`, 120, 3600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقًا');
    const demoCount = q('SELECT COUNT(*) n FROM users WHERE is_demo = 1').get().n;
    if (demoCount >= cfg.maxDemos) {
      // تفريغ الحسابات التجريبية القديمة لضمان عدم توقف الزوار
      try {
        q('DELETE FROM users WHERE is_demo = 1 AND id IN (SELECT id FROM users WHERE is_demo = 1 ORDER BY created_at ASC LIMIT 10)').run();
      } catch (_) {}
    }
    const id = tx(() => {
      const tag = crypto.randomBytes(6).toString('hex');
      const info = q(`INSERT INTO users (phone,pass_hash,store_name,plan,is_demo,integrations,tax_id,instapay,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(`demo-${tag}`, '!', 'متجر النور للإلكترونيات', 'pro', 1,
        JSON.stringify({ a: 1, n: 1, j: 1, bs: 1, ar: 1, my: 0, fw: 1, vc: 1, eta: 1 }), '412-890-115', 'elnoor.store@instapay', nowIso());
      seedDemo(app, Number(info.lastInsertRowid));
      return info.lastInsertRowid;
    });
    const user = q('SELECT * FROM users WHERE id = ?').get(id);
    const token = session.issue(res, user);
    return { ok: true, token, me: model.meOf(user) };
  }, { auth: false });

  r.post('/api/auth/logout', ({ res }) => {
    session.clear(res);
    return { ok: true };
  }, { auth: false });

  r.get('/api/auth/me', ({ user }) => ({ me: model.meOf(user) }));
};
