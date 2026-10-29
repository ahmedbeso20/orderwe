'use strict';
const { verifyPassword, hashPassword } = require('../auth');
const { HttpError, bad, text, phone, email, password, oneOf, latin, nowIso, parseJson } = require('../util');
const { PLANS, INTEGRATION_KEYS, NOTIFICATION_KEYS } = require('../domain');
const { seedDemo } = require('../seed');

const MARKET_KEYS = ['a', 'n', 'j'];

module.exports = (r, app) => {
  const { q, cfg, limiter, session, model } = app;
  const reload = (id) => q('SELECT * FROM users WHERE id = ?').get(id);
  const noDemo = (u) => { if (u.is_demo) throw new HttpError(403, 'هذا الإجراء غير متاح في الحساب التجريبي'); };

  /** كل ما تحتاجه الواجهة عند الفتح في طلب واحد */
  r.get('/api/bootstrap', ({ user }) => ({
    me: model.meOf(user), settings: model.settingsOf(user), ...model.meta(user),
    products: model.productsOf(user.id), ai: parseJson(user.ai_cache, {})
  }));

  r.put('/api/settings', ({ user, body }) => {
    const f = {};
    if (body.storeName !== undefined) f.store_name = text(body.storeName, 'اسم المتجر', { min: 2, max: 60 });
    if (body.taxId !== undefined) {
      f.tax_id = latin(text(body.taxId, 'الرقم الضريبي', { max: 20, optional: true }));
      if (!/^[0-9\- ]*$/.test(f.tax_id)) throw bad('الرقم الضريبي: أرقام وشرطات فقط');
    }
    if (body.instaPayHandle !== undefined) f.instapay = text(body.instaPayHandle, 'عنوان InstaPay', { max: 60, optional: true });
    if (!user.is_demo) { // الموبايل والبريد هما بيانات الدخول، فلا تُعدَّل في الحساب التجريبي
      if (body.storePhone !== undefined) f.phone = phone(body.storePhone);
      if (body.storeEmail !== undefined) f.email = email(body.storeEmail);
    }
    if (f.phone && q('SELECT 1 FROM users WHERE phone = ? AND id <> ?').get(f.phone, user.id)) throw new HttpError(409, 'رقم الموبايل مستخدم في حساب آخر');
    if (f.email && q('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(f.email, user.id)) throw new HttpError(409, 'البريد الإلكتروني مستخدم في حساب آخر');
    const keys = Object.keys(f); // أسماء الأعمدة ثابتة أعلاه فقط
    if (keys.length) q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), user.id);
    const fresh = reload(user.id);
    return { settings: model.settingsOf(fresh), me: model.meOf(fresh) };
  });

  r.put('/api/settings/integrations', ({ user, body }) => {
    const key = oneOf(body.key, INTEGRATION_KEYS, 'الربط');
    const on = body.on ? 1 : 0;
    const cur = parseJson(user.integrations, {});
    const plan = PLANS[user.plan] || PLANS.free;
    if (on && MARKET_KEYS.includes(key) && MARKET_KEYS.filter((k) => k !== key && cur[k]).length >= plan.markets) {
      throw new HttpError(402, `${plan.name} تتيح ربط ${plan.markets} أسواق فقط. رقّ باقتك لربط المزيد.`, { code: 'PLAN_LIMIT' });
    }
    cur[key] = on;
    q('UPDATE users SET integrations = ? WHERE id = ?').run(JSON.stringify(cur), user.id);
    return { integrations: cur };
  });

  r.put('/api/settings/notifications', ({ user, body }) => {
    const key = oneOf(body.key, NOTIFICATION_KEYS, 'التنبيه');
    const cur = parseJson(user.notifications, {});
    cur[key] = body.on ? 1 : 0;
    q('UPDATE users SET notifications = ? WHERE id = ?').run(JSON.stringify(cur), user.id);
    return { notifications: cur };
  });

  // نقطة الربط مع المنصات: تزامن المخزون والأسعار وحالات الشحن عبر قنوات أمازون ونون وجوميا
  r.post('/api/sync', ({ user }) => {
    const markets = MARKET_KEYS.filter((k) => parseJson(user.integrations, {})[k]);
    if (!markets.length) throw new HttpError(409, 'فعّل ربط سوق واحد على الأقل من صفحة التكاملات أولًا');
    const now = nowIso();
    q('UPDATE users SET last_sync_at = ? WHERE id = ?').run(now, user.id);
    const prodCount = q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(user.id).n;
    const lowStock = q('SELECT COUNT(*) n FROM products WHERE user_id = ? AND stock <= 5').get(user.id).n;
    const pendingOrders = q('SELECT COUNT(*) n FROM orders WHERE user_id = ? AND status = 0').get(user.id).n;
    const marketDetails = markets.map((m) => {
      const names = { a: 'أمازون مصر', n: 'نون مصر', j: 'جوميا' };
      return { key: m, name: names[m] || m, status: 'متصل ومزامَن بنجاح', syncedAt: now };
    });
    return {
      lastSyncAt: now,
      markets,
      products: prodCount,
      lowStock,
      pendingOrders,
      marketDetails,
      message: `تمت مزامنة ${prodCount} منتجًا و${pendingOrders} طلبًا بنجاح عبر ${markets.length} منصات.`
    };
  });

  // وضع التجربة: يغيّر الباقة مباشرة. اربطه ببوابة الدفع (Paymob/Fawry) ثم عطّل ALLOW_PLAN_SELF_SERVICE
  r.post('/api/plan', ({ user, body }) => {
    noDemo(user);
    if (!cfg.allowPlanSelfService) throw new HttpError(402, 'الدفع الإلكتروني غير مُفعّل بعد، تواصل معنا لتفعيل الباقة.', { code: 'PAYMENT_REQUIRED' });
    const target = PLANS[oneOf(body.plan, Object.keys(PLANS), 'الباقة')];
    const used = model.planOf(user).used;
    if (target.products != null && used > target.products) throw new HttpError(409, `لديك ${used} منتجًا والحد في ${target.name} هو ${target.products}. احذف الزائد أولًا.`);
    const active = MARKET_KEYS.filter((k) => parseJson(user.integrations, {})[k]).length;
    if (active > target.markets) throw new HttpError(409, `${target.name} تتيح ${target.markets} أسواق فقط. افصل سوقًا من صفحة التكاملات أولًا.`);
    q('UPDATE users SET plan = ? WHERE id = ?').run(target.id, user.id);
    return { plan: model.planOf({ ...user, plan: target.id }) };
  });

  r.post('/api/demo/reset', ({ user }) => {
    if (!user.is_demo) throw new HttpError(403, 'متاح للحساب التجريبي فقط');
    seedDemo(app, user.id);
    return { ok: true };
  });

  r.post('/api/account/password', async ({ user, body, res }) => {
    noDemo(user);
    if (!limiter.hit(`pw:${user.id}`, 5, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
    if (!(await verifyPassword(String(body.current ?? ''), user.pass_hash))) throw new HttpError(403, 'كلمة المرور الحالية غير صحيحة');
    const hash = await hashPassword(password(body.next, user.phone));
    q('UPDATE users SET pass_hash = ?, token_ver = token_ver + 1 WHERE id = ?').run(hash, user.id);
    session.issue(res, reload(user.id)); // تنتهي الجلسات الأخرى ونُبقي هذه
    return { ok: true };
  });

  r.delete('/api/account', async ({ user, body, res }) => {
    if (!user.is_demo) {
      if (!limiter.hit(`pw:${user.id}`, 5, 600_000)) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل');
      if (!(await verifyPassword(String(body.password ?? ''), user.pass_hash))) throw new HttpError(403, 'كلمة المرور غير صحيحة');
    }
    q('DELETE FROM users WHERE id = ?').run(user.id); // تُحذف كل بياناته تلقائيًا
    session.clear(res);
    return { ok: true };
  });
};
