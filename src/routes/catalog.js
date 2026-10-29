'use strict';
const { HttpError, bad, text, money, integer, toCsv, nowIso } = require('../util');
const { MARKETS, PLANS } = require('../domain');

module.exports = (r, { q, model }) => {
  const find = (uid, id) => {
    const p = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(Number(id) || 0, uid);
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    return p;
  };
  const dupSku = (fn) => {
    try { return fn(); } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'كود SKU مستخدم بالفعل لمنتج آخر'); throw e; }
  };

  /** يتحقق من الحقول المرسلة فقط (partial) أو من كلها عند الإنشاء */
  function read(b, partial) {
    const o = {};
    const need = (k) => !partial || b[k] !== undefined;
    if (need('name')) o.name = text(b.name, 'اسم المنتج', { min: 2, max: 140 });
    if (need('sku')) o.sku = text(b.sku, 'كود SKU', { min: 1, max: 40 });
    if (need('cat')) o.cat = text(b.cat, 'الفئة', { max: 40, optional: true }) || 'عام';
    if (need('price')) o.price = money(b.price, 'سعر البيع', { min: 0.01 });
    if (need('cost')) o.cost = money(b.cost ?? 0, 'تكلفة الشراء');
    if (need('stock')) o.stock = integer(b.stock ?? 0, 'الكمية');
    if (need('markets')) {
      const set = new Set(String(b.markets ?? 'a').split(''));
      o.markets = Object.keys(MARKETS).filter((k) => set.has(k)).join('');
      if (!o.markets) throw bad('اختر سوقًا واحدًا على الأقل');
    }
    return o;
  }

  r.get('/api/products', ({ user }) => ({ products: model.productsOf(user.id) }));

  r.post('/api/products', ({ user, body }) => {
    const plan = PLANS[user.plan] || PLANS.free;
    const used = q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(user.id).n;
    if (plan.products != null && used >= plan.products) {
      throw new HttpError(402, `وصلت للحد الأقصى (${plan.products} منتج) في ${plan.name}. رقّ باقتك لإضافة المزيد.`, { code: 'PLAN_LIMIT' });
    }
    const p = read(body, false);
    const now = nowIso();
    const id = dupSku(() => q('INSERT INTO products (user_id,name,sku,cat,markets,price,cost,stock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(user.id, p.name, p.sku, p.cat, p.markets, p.price, p.cost, p.stock, now, now).lastInsertRowid);
    return { product: model.productOf(find(user.id, id)), ...model.meta(user) };
  });

  r.put('/api/products/:id', ({ user, params, body }) => {
    const cur = find(user.id, params.id);
    const patch = read(body, true);
    const keys = Object.keys(patch); // أسماء الأعمدة ثابتة من read() فقط
    if (!keys.length) throw bad('لا توجد تغييرات للحفظ');
    dupSku(() => q(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(...keys.map((k) => patch[k]), nowIso(), cur.id, user.id));
    return { product: model.productOf(find(user.id, cur.id)), ...model.meta(user) };
  });

  r.post('/api/products/:id/restock', ({ user, params, body }) => {
    const qty = body.qty === undefined ? 10 : integer(body.qty, 'الكمية', { min: 1, max: 100000 });
    const p = find(user.id, params.id);
    q('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').run(qty, nowIso(), p.id);
    return { product: model.productOf(find(user.id, p.id)), ...model.meta(user) };
  });

  r.delete('/api/products/:id', ({ user, params }) => {
    const p = find(user.id, params.id);
    q('DELETE FROM products WHERE id = ?').run(p.id);
    return { ok: true, ...model.meta(user) };
  });

  r.get('/api/products/export.csv', ({ user, res }) => {
    const rows = [['المنتج', 'SKU', 'الفئة', 'الأسواق', 'التكلفة', 'السعر', 'المخزون']];
    for (const p of q('SELECT * FROM products WHERE user_id = ? ORDER BY id').all(user.id)) {
      rows.push([p.name, p.sku, p.cat, p.markets.split('').map((k) => MARKETS[k].name).join(' + '), p.cost, p.price, p.stock]);
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="omniarab-products.csv"', 'Cache-Control': 'no-store' });
    res.end(toCsv(rows));
  });
};
