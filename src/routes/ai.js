'use strict';
const { HttpError, text, integer, nowIso, parseJson } = require('../util');
const { MARKETS, PLANS } = require('../domain');
const ai = require('../ai');

const STATUS_LABEL = ['قيد التجهيز', 'تم الشحن', 'تم التسليم', 'مرتجع'];

module.exports = (r, app) => {
  const { q, cfg, limiter, model } = app;

  /** يحتسب طلب ذكاء اصطناعي ضمن حدّ الدقيقة والحدّ اليومي للباقة (لحماية مفتاح Gemini من الاستنزاف) */
  function quota(user) {
    if (!limiter.hit(`ai:${user.id}`, 12, 60_000)) throw new HttpError(429, 'انتظر قليلًا قبل طلب جديد من الذكاء الاصطناعي');
    const plan = PLANS[user.plan] || PLANS.free;
    const day = new Date().toISOString().slice(0, 10);
    const { n } = q('INSERT INTO ai_usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET n = n + 1 RETURNING n').get(user.id, day);
    if (n > plan.ai) throw new HttpError(429, `استهلكت حدّ الذكاء الاصطناعي اليومي (${plan.ai} طلبًا) في ${plan.name}. رقّ باقتك أو حاول غدًا.`, { code: 'PLAN_LIMIT' });
  }
  const saveCache = (user, key, value) => {
    const c = parseJson(user.ai_cache, {});
    c[key] = value;
    q('UPDATE users SET ai_cache = ? WHERE id = ?').run(JSON.stringify(c), user.id);
  };
  /** يجرّب Gemini، وعند أي فشل غير الحصة يعيد null ليُستخدم البديل الجاهز */
  async function tryGemini(user, req) {
    if (!cfg.geminiKey) return null;
    try { quota(user); return await ai.gemini(cfg, req); } catch (e) { if (e.status === 429) throw e; return null; }
  }
  const isObj = (d) => d && typeof d === 'object' && !Array.isArray(d);

  r.post('/api/ai/listing', async ({ user, body }) => {
    const name = text(body.name, 'اسم المنتج', { min: 2, max: 140 });
    const features = text(body.features, 'المميزات', { max: 400, optional: true });
    const tone = text(body.tone, 'النبرة', { max: 120, optional: true }) || 'احترافية مقنعة تناسب المتسوق المصري';
    const res = await tryGemini(user, ai.listingPrompt({ name, features, tone }));
    if (res && isObj(res.data)) return { source: 'gemini', data: ai.normalizeListing(res.data) };
    return { source: 'template', data: ai.templateListing(name, features), notice: cfg.geminiKey ? 'تعذر الاتصال بـ Gemini حاليًا، استخدمنا قالبًا جاهزًا.' : '' };
  });

  r.post('/api/ai/market', async ({ user, body }) => {
    const name = text(body.name, 'اسم المنتج', { min: 2, max: 140 });
    if (!cfg.geminiKey) throw new HttpError(503, 'فحص أسعار السوق يحتاج تفعيل مفتاح Gemini (GEMINI_API_KEY) على الخادم.', { code: 'AI_OFF' });
    quota(user);
    const res = await ai.gemini(cfg, {
      search: true,
      system: 'أنت محلل أسعار تجارة إلكترونية في مصر. قدم ملخصًا موجزًا وواضحًا باللغة العربية عن النطاق السعري للمنتج في مصر (بالجنيه المصري) على المتاجر مثل أمازون مصر ونون وجوميا، مع نصيحة للتاجر حول أفضل سعر تنافسي.',
      prompt: `ابحث عن أسعار "${name}" الحالية في السوق المصري بالجنيه المصري (EGP)، واذكر النطاق السعري التقريبي (أقل سعر ومتوسط السعر)، وقدم نصيحة تسعير مختصرة للتاجر في 3 نقاط واضحة.`
    });
    const market = { name, text: ai.str(res.text, 3000), sources: res.sources, at: nowIso() };
    saveCache(user, 'market', market);
    return { market };
  });

  r.post('/api/ai/advisor', async ({ user, body = {} }) => {
    const thinking = Boolean(body.thinking);
    const input = {
      storeName: user.store_name,
      products: q('SELECT name, price, cost, stock FROM products WHERE user_id = ? ORDER BY stock').all(user.id),
      codReady: model.codBalances(user.id).totals.net,
      orderCount: q('SELECT COUNT(*) n FROM orders WHERE user_id = ?').get(user.id).n,
      thinking
    };
    const res = await tryGemini(user, ai.advisorPrompt({ ...input, products: input.products.slice(0, 40) }));
    const advisor = res && isObj(res.data)
      ? { source: thinking ? 'gemini-thinking' : 'gemini', thinking, data: ai.normalizeAdvisor(res.data), at: nowIso() }
      : { source: 'rules', thinking, data: ai.rulesAdvisor(input), at: nowIso() };
    saveCache(user, 'advisor', advisor);
    return { advisor };
  });

  r.post('/api/ai/order-message', async ({ user, body }) => {
    const o = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(integer(body.orderId, 'الطلب', { min: 1, max: 2 ** 31 }), user.id);
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    const res = await tryGemini(user, ai.orderMessagePrompt(o, user.store_name, MARKETS[o.market].name, STATUS_LABEL[o.status]));
    if (res && res.text) return { source: 'gemini', text: ai.str(res.text, 1200) };
    return { source: 'template', text: ai.templateOrderMessage(o, user.store_name) };
  });
};
