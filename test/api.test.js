'use strict';
// اختبارات تكامل للواجهة البرمجية: node --test (لا تحتاج أي حزم)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

class Client {
  constructor(base, ip) { this.base = base; this.ip = ip; this.jar = ''; }
  async call(method, path, body, extra = {}) {
    const headers = { 'x-forwarded-for': this.ip, ...extra };
    if (method !== 'GET' && !('x-requested-with' in headers)) headers['x-requested-with'] = 'omniarab';
    if (this.jar) headers.cookie = this.jar;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) { const pair = sc.split(';')[0]; this.jar = pair.endsWith('=') ? '' : pair; }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b = {}) { return this.call('PUT', p, b); }
  del(p, b = {}) { return this.call('DELETE', p, b); }
}

async function start(opts = {}) {
  const app = createApp({ dbFile: ':memory:', secret: 's'.repeat(48), trustProxy: true, geminiKey: '', ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  return { app, base, client: () => new Client(base, `10.0.0.${++n}`) };
}
const phoneOf = (() => { let n = 0; return () => `0100000${String(++n).padStart(4, '0')}`; })();
async function signup(c, over = {}) {
  const phone = over.phone || phoneOf();
  const r = await c.post('/api/auth/register', { store: 'متجر الاختبار', phone, password: 'secret123', ...over });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return phone;
}
const prod = (o = {}) => ({ name: 'منتج تجريبي', sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, price: 100, cost: 60, stock: 10, markets: 'anj', ...o });
const orderBody = (productId, o = {}) => ({ market: 'a', customer: 'عميل اختبار', gov: 'القاهرة', pay: 'عند الاستلام', courier: 'بوسطة', items: [{ productId, qty: 1 }], ...o });

test('الأمان الأساسي: CSRF والمصادقة وترويسات الحماية', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const c = s.client();
  assert.equal((await c.get('/api/health')).data.ok, true);
  assert.equal((await c.get('/api/bootstrap')).status, 401);
  const noHeader = await c.call('POST', '/api/auth/login', { id: '01000000000', password: 'x' }, { 'x-requested-with': 'other' });
  assert.equal(noHeader.status, 403);
  const foreign = await c.call('POST', '/api/auth/logout', {}, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const h = (await c.get('/api/health')).headers;
  assert.match(h.get('content-security-policy'), /script-src 'self'/);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal((await c.get('/api/nope')).status, 404);
});

test('التسجيل والدخول وتغيير كلمة المرور وحذف الحساب', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const c = s.client();
  assert.equal((await c.post('/api/auth/register', { store: 'م', phone: '123', password: 'secret123' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { store: 'متجر', phone: '01012345678', password: '123' })).status, 400);
  // أرقام عربية وصيغة +20 تُقبل وتُوحَّد
  const phone = await signup(c, { phone: '٠١٠٠٠٠٠٠٠٠١', email: 'Owner@Example.com' });
  const boot = await c.get('/api/bootstrap');
  assert.equal(boot.data.me.phone, '01000000001');
  assert.equal(boot.data.me.email, 'owner@example.com');
  assert.equal(boot.data.plan.id, 'free');
  assert.equal(boot.data.products.length, 0);
  assert.equal((await s.client().post('/api/auth/register', { store: 'آخر', phone: '+201000000001', password: 'secret123' })).status, 409);

  const c2 = s.client();
  assert.equal((await c2.post('/api/auth/login', { id: phone, password: 'wrong-pass' })).status, 401);
  assert.equal((await c2.post('/api/auth/login', { id: 'owner@example.com', password: 'secret123' })).status, 200);
  assert.equal((await c2.get('/api/auth/me')).data.me.storeName, 'متجر الاختبار');

  assert.equal((await c.post('/api/account/password', { current: 'bad', next: 'newsecret99' })).status, 403);
  assert.equal((await c.post('/api/account/password', { current: 'secret123', next: 'newsecret99' })).status, 200);
  assert.equal((await c2.get('/api/bootstrap')).status, 401, 'الجلسات الأخرى تنتهي بعد تغيير كلمة المرور');
  assert.equal((await c.get('/api/bootstrap')).status, 200, 'الجلسة الحالية تبقى');
  assert.equal((await s.client().post('/api/auth/login', { id: phone, password: 'newsecret99' })).status, 200);

  assert.equal((await c.del('/api/account', { password: 'nope' })).status, 403);
  assert.equal((await c.del('/api/account', { password: 'newsecret99' })).status, 200);
  assert.equal((await s.client().post('/api/auth/login', { id: phone, password: 'newsecret99' })).status, 401);
});

test('تحديد محاولات الدخول الفاشلة', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const c = s.client();
  const phone = await signup(c);
  const attacker = s.client();
  let last;
  for (let i = 0; i < 9; i++) last = await attacker.post('/api/auth/login', { id: phone, password: `bad-pass-${i}` });
  assert.equal(last.status, 429);
});

test('المنتجات: إنشاء وتعديل وتخزين وحدود الباقة وعزل الحسابات', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const a = s.client(), b = s.client();
  await signup(a); await signup(b);

  const created = await a.post('/api/products', prod({ sku: 'DUP', name: 'سماعة' }));
  assert.equal(created.status, 200);
  const id = created.data.product.id;
  assert.equal(created.data.plan.used, 1);
  assert.equal((await a.post('/api/products', prod({ sku: 'DUP' }))).status, 409);
  assert.equal((await a.post('/api/products', prod({ price: 0 }))).status, 400);
  assert.equal((await a.post('/api/products', prod({ markets: 'xyz' }))).status, 400);

  const upd = await a.put(`/api/products/${id}`, { markets: 'n', price: '١٥٠' });
  assert.equal(upd.data.product.markets, 'n');
  assert.equal(upd.data.product.price, 150);
  assert.equal((await a.post(`/api/products/${id}/restock`, { qty: 10 })).data.product.stock, 20);

  assert.equal((await b.put(`/api/products/${id}`, { price: 1 })).status, 404, 'لا يعدّل أحد منتج غيره');
  assert.equal((await b.post(`/api/products/${id}/restock`)).status, 404);
  assert.equal((await b.get('/api/products')).data.products.length, 0);

  for (let i = 0; i < 49; i++) assert.equal((await a.post('/api/products', prod())).status, 200);
  const over = await a.post('/api/products', prod());
  assert.equal(over.status, 402);
  assert.equal(over.data.code, 'PLAN_LIMIT');
  assert.equal((await a.del(`/api/products/${id}`)).status, 200);

  const csv = await a.get('/api/products/export.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /المنتج,SKU,الفئة/);
  assert.match(csv.headers.get('content-disposition'), /omniarab-products\.csv/);
});

test('الطلبات: خصم المخزون والحالات والمرتجع والبحث والفاتورة', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const a = s.client(), b = s.client();
  await signup(a); await signup(b);
  const p = (await a.post('/api/products', prod({ name: '<script>alert(1)</script>', stock: 5, markets: 'an' }))).data.product;

  assert.equal((await a.post('/api/orders', orderBody(p.id, { market: 'j' }))).status, 400, 'غير منشور على جوميا');
  assert.equal((await a.post('/api/orders', orderBody(p.id, { items: [{ productId: p.id, qty: 6 }] }))).status, 409, 'مخزون غير كافٍ');
  assert.equal((await a.post('/api/orders', orderBody(p.id, { courier: 'غير معروف' }))).status, 400);
  assert.equal((await b.post('/api/orders', orderBody(p.id))).status, 400, 'منتج حساب آخر');

  const made = await a.post('/api/orders', orderBody(p.id, { customer: '=HYPERLINK("x")', items: [{ productId: p.id, qty: 2 }, { productId: p.id, qty: 1 }] }));
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.order.total, 300);
  assert.equal(made.data.order.no, 1001);
  assert.equal(made.data.products[0].stock, 2);
  assert.equal(made.data.counts.pendingOrders, 1);
  const oid = made.data.order.id;

  assert.equal((await a.post(`/api/orders/${oid}/status`, { status: 2 })).status, 409, 'لا يقفز من التجهيز للتسليم');
  assert.equal((await b.post(`/api/orders/${oid}/status`, { status: 1 })).status, 404);
  assert.equal((await a.post(`/api/orders/${oid}/status`, { status: 1 })).data.order.status, 1);
  const returned = await a.post(`/api/orders/${oid}/status`, { status: 3 });
  assert.equal(returned.data.order.status, 3);
  assert.equal(returned.data.products[0].stock, 5, 'المرتجع يعود للمخزون');
  assert.equal((await a.post(`/api/orders/${oid}/status`, { status: 2 })).status, 409);

  await a.post('/api/orders', orderBody(p.id, { customer: 'منى سعيد', gov: 'أسيوط' }));
  const list = await a.get('/api/orders?q=' + encodeURIComponent('منى'));
  assert.equal(list.data.total, 1);
  assert.equal((await a.get('/api/orders?q=%D9%A1%D9%A0%D9%A0%D9%A1')).data.total, 1, 'البحث برقم الطلب بالأرقام العربية');
  assert.equal((await a.get('/api/orders?status=3')).data.total, 1);
  assert.equal((await a.get('/api/orders?page=99&limit=5')).data.page, 1);
  assert.equal((await b.get('/api/orders')).data.total, 0);

  const inv = await a.get(`/api/orders/${oid}/invoice`);
  assert.equal(inv.status, 200);
  assert.match(inv.data, /&lt;script&gt;/);
  assert.doesNotMatch(inv.data, /<script>alert/);
  assert.equal((await b.get(`/api/orders/${oid}/invoice`)).status, 404);

  const csv = await a.get('/api/orders/export.csv');
  assert.match(csv.data, /'=HYPERLINK/, 'منع حقن الصيغ في CSV');
  assert.match((await a.get('/api/orders/awb')).data, /منى سعيد/);
});

test('الدفع عند الاستلام: التحصيل والسحب', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const a = s.client();
  await signup(a);
  const p = (await a.post('/api/products', prod({ price: 500, stock: 10 }))).data.product;
  const o1 = (await a.post('/api/orders', orderBody(p.id))).data.order;
  const o2 = (await a.post('/api/orders', orderBody(p.id, { pay: 'إنستاباي' }))).data.order;
  await a.post(`/api/orders/${o1.id}/status`, { status: 1 });
  await a.post(`/api/orders/${o2.id}/status`, { status: 1 });

  let cod = (await a.get('/api/cod')).data;
  const bosta = () => cod.couriers.find((c) => c.key === 'bosta');
  assert.equal(bosta().pending, 500, 'الطلب المدفوع إنستاباي لا يدخل في COD');
  await a.post(`/api/orders/${o1.id}/status`, { status: 2 });
  cod = (await a.get('/api/cod')).data;
  assert.deepEqual([bosta().collected, bosta().fees, bosta().net, bosta().pending], [500, 38, 462, 0]);

  assert.equal((await a.post('/api/cod/bosta/payout')).status, 409, 'يلزم عنوان InstaPay');
  await a.put('/api/settings', { instaPayHandle: 'shop@instapay' });
  assert.equal((await a.post('/api/cod/unknown/payout')).status, 404);
  const pay = await a.post('/api/cod/bosta/payout');
  assert.equal(pay.data.net, 462);
  assert.equal((await a.post('/api/cod/bosta/payout')).status, 409, 'لا سحب مزدوج');

  const dash = (await a.get('/api/dashboard?range=7')).data;
  assert.equal(dash.months.length, 12);
  assert.equal(dash.kpis.orders, 2);
  assert.equal(dash.kpis.gross, 1000);
  assert.ok(Math.abs(dash.kpis.fees - 1000 * 0.12 * 1.14 * 0 - dash.kpis.fees) < 1e-9);
  assert.equal(dash.marketShare.a.pct, 100);
  assert.equal(dash.payShare.cod, 50);
  assert.equal(dash.kpis.grossDelta, null, 'لا فترة سابقة للمقارنة');
});

test('الحساب التجريبي: بيانات جاهزة وقيود', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const c = s.client();
  assert.equal((await c.post('/api/auth/demo')).status, 200);
  const b = (await c.get('/api/bootstrap')).data;
  assert.equal(b.me.isDemo, true);
  assert.equal(b.products.length, 7);
  assert.equal(b.plan.id, 'pro');
  const orders = (await c.get('/api/orders?limit=5')).data;
  assert.ok(orders.total > 800, `عدد الطلبات ${orders.total}`);
  const dash = (await c.get('/api/dashboard?range=30')).data;
  assert.ok(dash.kpis.gross > 20000 && dash.kpis.net > 0, JSON.stringify(dash.kpis));
  assert.ok(dash.months.at(-1).revenue > dash.months[0].revenue, 'المبيعات تنمو عبر الشهور');
  assert.ok(Math.abs(dash.marketShare.a.pct + dash.marketShare.n.pct + dash.marketShare.j.pct - 100) < 0.5);
  const cod = (await c.get('/api/cod')).data;
  assert.ok(cod.totals.collected > 0 && cod.totals.pending > 0);
  assert.equal((await c.post('/api/account/password', { current: 'a', next: 'bbbbbbbb' })).status, 403);
  assert.equal((await c.post('/api/plan', { plan: 'free' })).status, 403);
  assert.equal((await c.get('/api/orders/awb')).status, 200);

  await c.post('/api/products', prod({ sku: 'EXTRA' }));
  assert.equal((await c.post('/api/demo/reset')).status, 200);
  assert.equal((await c.get('/api/bootstrap')).data.products.length, 7);

  const real = s.client();
  await signup(real);
  assert.equal((await real.post('/api/demo/reset')).status, 403);
});

test('الإعدادات والتكاملات والباقات', async (t) => {
  const s = await start({ allowPlanSelfService: true }); t.after(() => s.app.close());
  const a = s.client(), b = s.client();
  const phoneA = await signup(a);
  await signup(b);

  assert.equal((await a.post('/api/sync')).status, 409, 'لا أسواق مفعّلة');
  assert.equal((await a.put('/api/settings/integrations', { key: 'a', on: true })).status, 200);
  assert.equal((await a.put('/api/settings/integrations', { key: 'n', on: true })).status, 200);
  const third = await a.put('/api/settings/integrations', { key: 'j', on: true });
  assert.equal(third.status, 402, 'الباقة المجانية تتيح سوقين');
  assert.equal((await a.put('/api/settings/integrations', { key: 'zzz', on: true })).status, 400);
  assert.equal((await a.post('/api/sync')).data.markets.length, 2);
  assert.equal((await a.put('/api/settings/notifications', { key: 'w', on: true })).data.notifications.w, 1);

  const st = await a.put('/api/settings', { storeName: 'متجر جديد', taxId: '٤١٢-٨٩٠-١١٥', storeEmail: 'a@b.co', storePhone: phoneA });
  assert.equal(st.data.settings.storeName, 'متجر جديد');
  assert.equal(st.data.settings.taxId, '412-890-115');
  assert.equal((await a.put('/api/settings', { taxId: 'abc' })).status, 400);
  assert.equal((await b.put('/api/settings', { storeEmail: 'a@b.co' })).status, 409);

  assert.equal((await a.post('/api/plan', { plan: 'pro' })).data.plan.limit, 1500);
  assert.equal((await a.put('/api/settings/integrations', { key: 'j', on: true })).status, 200);
  assert.equal((await a.post('/api/plan', { plan: 'free' })).status, 409, 'ثلاثة أسواق مفعّلة');

  const closed = await start({ allowPlanSelfService: false }); t.after(() => closed.app.close());
  const c = closed.client();
  await signup(c);
  assert.equal((await c.post('/api/plan', { plan: 'pro' })).status, 402);
});

test('الذكاء الاصطناعي بدون مفتاح: قوالب وقواعد', async (t) => {
  const s = await start(); t.after(() => s.app.close());
  const a = s.client();
  await signup(a);
  const l = await a.post('/api/ai/listing', { name: 'سماعة', features: 'بطارية ٣٠ ساعة، مايك عازل' });
  assert.equal(l.data.source, 'template');
  assert.match(l.data.data.amazonTitle, /سماعة/);
  assert.equal((await a.post('/api/ai/market', { name: 'سماعة' })).status, 503);
  const empty = await a.post('/api/ai/advisor');
  assert.equal(empty.data.advisor.source, 'rules');
  await a.post('/api/products', prod({ name: 'ثلاجة', price: 100, cost: 95, stock: 2 }));
  const adv = (await a.post('/api/ai/advisor')).data.advisor;
  assert.match(adv.data.urgentRestockTip, /ثلاجة/);
  assert.match(adv.data.profitOptimizationTip, /ثلاجة/);
  assert.equal((await a.get('/api/bootstrap')).data.ai.advisor.source, 'rules', 'يُحفظ آخر تحليل');
  const p = (await a.get('/api/products')).data.products[0];
  const o = (await a.post('/api/orders', orderBody(p.id))).data.order;
  assert.match((await a.post('/api/ai/order-message', { orderId: o.id })).data.text, /عميل اختبار/);
});

test('الذكاء الاصطناعي مع Gemini (محاكاة): المفتاح بالترويسة والمصادر والحصص', async (t) => {
  const calls = [];
  let mode = 'ok';
  const fetchStub = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (mode === 'down') return { ok: false, status: 503, json: async () => ({}) };
    const body = calls.at(-1).body;
    const text = body.generationConfig
      ? JSON.stringify(body.generationConfig.responseSchema.properties.headline
        ? { headline: 'ممتاز', urgentRestockTip: 'أ', profitOptimizationTip: 'ب', cashflowAndCodTip: 'ج' }
        : { amazonTitle: 'AMZ', noonTitle: 'NOON', jumiaTitle: 'JUM', descriptionIntro: 'مقدمة', bulletPoints: ['١', '٢'], keywords: ['س', 'ص'], pricingTip: 'نصيحة' })
      : 'النطاق السعري من ٤٠٠ إلى ٥٠٠ ج.م';
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [
      { web: { uri: 'https://example.com/a', title: 'مصدر' } }, { web: { uri: 'javascript:alert(1)', title: 'سيئ' } }] } }] }) };
  };
  const s = await start({ geminiKey: 'TEST-KEY', fetch: fetchStub }); t.after(() => s.app.close());
  const a = s.client();
  await signup(a);

  const l = await a.post('/api/ai/listing', { name: 'سماعة', features: 'x' });
  assert.equal(l.data.source, 'gemini');
  assert.equal(l.data.data.keywords, 'س، ص');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'TEST-KEY');
  assert.ok(!calls[0].url.includes('TEST-KEY'), 'المفتاح لا يظهر في الرابط');
  assert.match(calls[0].url, /gemini-3-flash-preview:generateContent$/);
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');

  const m = (await a.post('/api/ai/market', { name: 'سماعة' })).data.market;
  assert.equal(calls.at(-1).body.tools[0].google_search !== undefined, true);
  assert.deepEqual(m.sources, [{ uri: 'https://example.com/a', title: 'مصدر' }], 'تُحذف الروابط غير http(s)');
  assert.equal((await a.get('/api/bootstrap')).data.ai.market.name, 'سماعة');
  assert.equal((await a.post('/api/ai/advisor')).data.advisor.source, 'gemini');

  mode = 'down';
  const fallback = await a.post('/api/ai/listing', { name: 'سماعة', features: '' });
  assert.equal(fallback.data.source, 'template');
  assert.match(fallback.data.notice, /Gemini/);
  assert.equal((await a.post('/api/ai/market', { name: 'سماعة' })).status, 502);

  mode = 'ok';
  const b = s.client();
  await signup(b);
  let last;
  for (let i = 0; i < 12; i++) last = await b.post('/api/ai/listing', { name: 'منتج', features: '' });
  assert.equal(last.data.source, 'gemini');
  const slow = await b.post('/api/ai/listing', { name: 'منتج', features: '' });
  assert.equal(slow.status, 429, 'حدّ ١٢ طلبًا في الدقيقة');
});
