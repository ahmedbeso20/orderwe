'use strict';
// تحويل صفوف قاعدة البيانات إلى كائنات JSON يرسلها الخادم للواجهة
const { PLANS, COURIERS, COD } = require('./domain');
const { parseJson, round2 } = require('./util');

function createModel(q) {
  const productOf = (p) => ({ id: p.id, name: p.name, sku: p.sku, cat: p.cat, markets: p.markets, price: p.price, cost: p.cost, stock: p.stock });
  const orderOf = (o) => ({
    id: o.id, no: o.no, market: o.market, customer: o.customer, phone: o.phone, gov: o.gov, address: o.address, pay: o.pay,
    courier: o.courier, total: o.total, shipFee: o.ship_fee, status: o.status, items: o.items, createdAt: o.created_at, settled: !!o.settled_at
  });
  const meOf = (u) => ({ id: u.id, storeName: u.store_name, phone: u.is_demo ? '' : u.phone, email: u.email || '', plan: u.plan, isDemo: !!u.is_demo, createdAt: u.created_at });
  const settingsOf = (u) => ({
    storeName: u.store_name,
    storeEmail: u.is_demo ? 'sales@elnoor-eg.com' : u.email || '',
    storePhone: u.is_demo ? '01012345678' : u.phone,
    taxId: u.tax_id, instaPayHandle: u.instapay,
    integrations: parseJson(u.integrations, {}), notifications: parseJson(u.notifications, {}),
    lastSyncAt: u.last_sync_at
  });
  const counts = (uid) => ({
    lowStock: q('SELECT COUNT(*) n FROM products WHERE user_id = ? AND stock <= 5').get(uid).n,
    pendingOrders: q('SELECT COUNT(*) n FROM orders WHERE user_id = ? AND status = 0').get(uid).n
  });
  const planOf = (u) => {
    const p = PLANS[u.plan] || PLANS.free;
    return { id: p.id, name: p.name, limit: p.products, markets: p.markets, used: q('SELECT COUNT(*) n FROM products WHERE user_id = ?').get(u.id).n };
  };
  const meta = (u) => ({ counts: counts(u.id), plan: planOf(u) });
  const productsOf = (uid) => q('SELECT * FROM products WHERE user_id = ? ORDER BY id DESC').all(uid).map(productOf);


  /** أرصدة الدفع عند الاستلام لكل شركة شحن: محصّل (تم التسليم ولم يُسوَّ) / قيد التوصيل / رسوم */
  function codBalances(uid) {
    const rows = q(`SELECT courier,
        COALESCE(SUM(CASE WHEN status = 2 AND settled_at IS NULL THEN total END), 0) collected,
        COALESCE(SUM(CASE WHEN status = 2 AND settled_at IS NULL THEN ship_fee END), 0) fees,
        COALESCE(SUM(CASE WHEN status = 1 THEN total END), 0) pending
      FROM orders WHERE user_id = ? AND pay = ? GROUP BY courier`).all(uid, COD);
    const couriers = Object.entries(COURIERS).map(([label, c]) => {
      const x = rows.find((row) => row.courier === label) || { collected: 0, fees: 0, pending: 0 };
      return { key: c.key, label, cycle: c.cycle, collected: round2(x.collected), pending: round2(x.pending), fees: round2(x.fees), net: round2(Math.max(0, x.collected - x.fees)) };
    });
    const sum = (k) => round2(couriers.reduce((s, c) => s + c[k], 0));
    return { couriers, totals: { collected: sum('collected'), pending: sum('pending'), fees: sum('fees'), net: sum('net') } };
  }

  return { productOf, orderOf, meOf, settingsOf, counts, planOf, meta, productsOf, codBalances };
}

module.exports = { createModel };
