'use strict';
const { HttpError, bad, text, integer, phone, oneOf, latin, toCsv, nowIso } = require('../util');
const { MARKETS, COURIERS, PAYMENTS, STATUS_NEXT } = require('../domain');
const { invoicePage, awbPage } = require('../pages');
const { sendText } = require('../http');

const STATUS_LABEL = ['قيد التجهيز', 'تم الشحن', 'تم التسليم', 'مرتجع'];

module.exports = (r, { q, tx, model }) => {
  const find = (uid, id) => {
    const o = q('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(id) || 0, uid);
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    return o;
  };
  const productsByIds = (uid, ids) => ids.map((id) => q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(id, uid)).filter(Boolean).map(model.productOf);

  r.get('/api/orders', ({ user, query }) => {
    const where = ['user_id = ?'];
    const args = [user.id];
    const status = Number(query.status);
    if (Number.isInteger(status) && status >= 0 && status <= 3) { where.push('status = ?'); args.push(status); }
    const search = String(query.q ?? '').trim().slice(0, 60);
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      const no = Number(latin(search));
      where.push(`(customer LIKE ? ESCAPE '\\' OR gov LIKE ? ESCAPE '\\' OR courier LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'${Number.isInteger(no) ? ' OR no = ?' : ''})`);
      args.push(like, like, like, like);
      if (Number.isInteger(no)) args.push(no);
    }
    const perPage = Math.min(100, Math.max(5, Number(query.limit) || 25));
    const total = q(`SELECT COUNT(*) n FROM orders WHERE ${where.join(' AND ')}`).get(...args).n;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
    const items = q(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, perPage, (page - 1) * perPage).map(model.orderOf);
    return { items, total, page, pages, perPage, counts: model.counts(user.id) };
  });

  r.post('/api/orders', ({ user, body }) => {
    const market = oneOf(body.market, Object.keys(MARKETS), 'السوق');
    const customer = text(body.customer, 'اسم العميل', { min: 2, max: 60 });
    const ph = phone(body.phone, { optional: true });
    const gov = text(body.gov, 'المحافظة', { min: 2, max: 40 });
    const address = text(body.address, 'العنوان', { max: 200, optional: true });
    const pay = oneOf(body.pay, PAYMENTS, 'طريقة الدفع');
    const courier = oneOf(body.courier, Object.keys(COURIERS), 'شركة الشحن');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) throw bad('أضف منتجًا واحدًا على الأقل (حتى ٢٠ منتجًا)');
    const wanted = new Map();
    for (const it of body.items) {
      const pid = integer(it?.productId, 'المنتج', { min: 1, max: 2 ** 31 });
      wanted.set(pid, (wanted.get(pid) || 0) + integer(it?.qty, 'الكمية', { min: 1, max: 999 }));
    }

    const order = tx(() => { // خصم المخزون وتسجيل الطلب معًا: إما ينجح الاثنان أو لا شيء
      const now = nowIso();
      const lines = [];
      let total = 0, cost = 0;
      for (const [pid, qty] of wanted) {
        const p = q('SELECT * FROM products WHERE id = ? AND user_id = ?').get(pid, user.id);
        if (!p) throw bad('أحد المنتجات غير موجود');
        if (!p.markets.includes(market)) throw bad(`"${p.name}" غير منشور على ${MARKETS[market].name}`);
        if (!q('UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock >= ?').run(qty, now, p.id, qty).changes) {
          throw new HttpError(409, `المخزون غير كافٍ لـ "${p.name}" (المتاح ${p.stock} قطعة)`);
        }
        total += p.price * qty; cost += p.cost * qty;
        lines.push({ p, qty });
      }
      const no = q('UPDATE users SET order_seq = order_seq + 1 WHERE id = ? RETURNING order_seq').get(user.id).order_seq;
      const itemsText = lines.map(({ p, qty }) => `${p.name}${qty > 1 ? ` (${qty} قطع)` : ''}`).join(' + ').slice(0, 500);
      const id = q(`INSERT INTO orders (user_id,no,market,customer,phone,gov,address,pay,courier,total,cost_total,ship_fee,status,items,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(user.id, no, market, customer, ph, gov, address, pay, courier,
        Math.round(total * 100) / 100, Math.round(cost * 100) / 100, COURIERS[courier].fee, itemsText, now).lastInsertRowid;
      for (const { p, qty } of lines) q('INSERT INTO order_items (order_id,product_id,name,qty,price,cost) VALUES (?,?,?,?,?,?)').run(id, p.id, p.name, qty, p.price, p.cost);
      return q('SELECT * FROM orders WHERE id = ?').get(id);
    });
    const ids = [...wanted.keys()];
    return { order: model.orderOf(order), products: productsByIds(user.id, ids), counts: model.counts(user.id) };
  });

  r.post('/api/orders/:id/status', ({ user, params, body }) => {
    const next = integer(body.status, 'الحالة', { min: 1, max: 3 });
    const changed = tx(() => {
      const o = find(user.id, params.id);
      if (!(STATUS_NEXT[o.status] || []).includes(next)) throw new HttpError(409, `لا يمكن نقل الطلب من "${STATUS_LABEL[o.status]}" إلى "${STATUS_LABEL[next]}"`);
      q('UPDATE orders SET status = ? WHERE id = ?').run(next, o.id);
      const restored = [];
      if (next === 3) { // المرتجع يعود للمخزون
        for (const it of q('SELECT * FROM order_items WHERE order_id = ? AND product_id IS NOT NULL').all(o.id)) {
          q('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ? AND user_id = ?').run(it.qty, nowIso(), it.product_id, user.id);
          restored.push(it.product_id);
        }
      }
      return { id: o.id, restored };
    });
    return { order: model.orderOf(find(user.id, changed.id)), products: productsByIds(user.id, changed.restored), counts: model.counts(user.id) };
  });

  r.get('/api/orders/export.csv', ({ user, res }) => {
    const rows = [['رقم الطلب', 'التاريخ', 'السوق', 'العميل', 'الموبايل', 'المحافظة', 'الدفع', 'الشحن', 'الإجمالي', 'الحالة', 'المنتجات']];
    for (const o of q('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(user.id)) {
      rows.push([o.no, o.created_at.slice(0, 10), MARKETS[o.market]?.name, o.customer, o.phone, o.gov, o.pay, o.courier, o.total, STATUS_LABEL[o.status], o.items]);
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="omniarab-orders.csv"', 'Cache-Control': 'no-store' });
    res.end(toCsv(rows));
  });

  r.get('/api/orders/awb', ({ user, res }) => {
    const list = q('SELECT * FROM orders WHERE user_id = ? AND status = 0 ORDER BY created_at LIMIT 200').all(user.id);
    sendText(res, 200, awbPage(list, user), { 'Content-Type': 'text/html; charset=utf-8' });
  });

  r.get('/api/orders/:id/invoice', ({ user, params, res }) => {
    const o = find(user.id, params.id);
    const items = q('SELECT name, qty, price FROM order_items WHERE order_id = ?').all(o.id);
    sendText(res, 200, invoicePage(o, items, user), { 'Content-Type': 'text/html; charset=utf-8' });
  });
};
