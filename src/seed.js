'use strict';
// بيانات الحساب التجريبي: المنتجات والطلبات الأصلية + سجل مبيعات سنة كاملة لتبدو اللوحة واقعية
const { COURIERS, COD } = require('./domain');
const { nowIso } = require('./util');

const DAY = 86400000;
const arNum = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);

// [الاسم، SKU، الأسواق، السعر، المخزون، التكلفة، الفئة]
const PRODUCTS = [
  ['سماعة بلوتوث لاسلكية عازلة للضوضاء', '101-BT', 'anj', 450, 4, 250, 'إلكترونيات'],
  ['حافظة هاتف مقاومة للصدمات شفاف', '220-CS', 'an', 95, 12, 35, 'إكسسوارات'],
  ['شاحن سريع Gan بقدرة ٦٥ واط', '330-CH', 'aj', 320, 8, 185, 'إلكترونيات'],
  ['ساعة ذكية رياضية ضد الماء IP68', '410-SW', 'anj', 990, 38, 610, 'ساعات ذكية'],
  ['كابل شحن قماشي USB-C سريع ٢ متر', '505-CB', 'an', 75, 115, 25, 'إكسسوارات'],
  ['باور بانك ٢٠٠٠٠ مللي أمبير شحن فائق', '612-PB', 'anj', 680, 26, 410, 'إلكترونيات'],
  ['حامل لابتوب ألومنيوم قابل للطي', '718-ST', 'nj', 260, 19, 130, 'مكتب']
];

// [السوق، العميل، المحافظة، الدفع، الشحن، قبل كم يوم، الحالة، [[رقم المنتج، الكمية]]]
const RECENT = [
  ['a', 'هبة إبراهيم', 'أسيوط', COD, 'بوسطة', 0, 0, [[5, 1]]],
  ['n', 'كريم عادل', 'القاهرة الجديدة', 'فودافون كاش', 'أرامكس', 0, 0, [[1, 1]]],
  ['j', 'نورا فتحي', 'الشرقية', COD, 'مايلرز', 1, 1, [[3, 1]]],
  ['a', 'أحمد محمد علي', 'القاهرة', COD, 'بوسطة', 1, 0, [[0, 1]]],
  ['n', 'سارة علي حسن', 'الجيزة', 'إنستاباي', 'أرامكس', 2, 1, [[2, 1]]],
  ['j', 'محمود حسن', 'الإسكندرية', COD, 'بوسطة', 3, 2, [[0, 2]]],
  ['a', 'منى سعيد', 'الدقهلية', COD, 'مايلرز', 4, 3, [[6, 1]]],
  ['n', 'خالد يوسف', 'الغربية', 'بطاقة بنكية', 'أرامكس', 5, 2, [[2, 1], [4, 1]]]
];

const FIRST = ['أحمد', 'محمد', 'محمود', 'مصطفى', 'خالد', 'كريم', 'عمر', 'يوسف', 'حسن', 'إبراهيم', 'هبة', 'نورا', 'سارة', 'منى', 'دينا', 'ياسمين', 'آية', 'ريم', 'هدى', 'فاطمة'];
const LAST = ['علي', 'حسن', 'إبراهيم', 'عبد الله', 'سعيد', 'فتحي', 'عادل', 'السيد', 'محمود', 'شحاتة', 'رمضان', 'جمال'];
const GOVS = [['القاهرة', 18], ['الجيزة', 14], ['الإسكندرية', 10], ['الدقهلية', 6], ['الشرقية', 6], ['الغربية', 5], ['القليوبية', 6], ['المنوفية', 4], ['أسيوط', 3], ['سوهاج', 3], ['المنيا', 3], ['البحيرة', 4], ['الفيوم', 2], ['بورسعيد', 2], ['السويس', 2], ['الإسماعيلية', 2], ['كفر الشيخ', 2], ['أسوان', 1]];
const MARKET_W = [['a', 52], ['n', 31], ['j', 17]];
const PAY_W = [[COD, 64], ['فودافون كاش', 11], ['إنستاباي', 10], ['بطاقة بنكية', 10], ['فوري', 5]];
const COURIER_W = [['بوسطة', 50], ['أرامكس', 30], ['مايلرز', 20]];
const PRODUCT_W = [16, 22, 14, 8, 24, 10, 6];

function rng(seed) { // مولّد أرقام شبه عشوائية ثابت (mulberry32)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => {
  let t = rand() * list.reduce((s, x) => s + x[1], 0);
  for (const [v, w] of list) if ((t -= w) < 0) return v;
  return list[list.length - 1][0];
};

function seedDemo({ q, tx }, uid) {
  const now = Date.now();
  const rand = rng(uid * 7919 + 13);

  tx(() => {
    for (const t of ['orders', 'products', 'payouts']) q(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);

    const stamp = nowIso();
    const ids = PRODUCTS.map((p) => Number(q('INSERT INTO products (user_id,name,sku,cat,markets,price,cost,stock,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid, p[0], p[1], p[6], p[2], p[3], p[5], p[4], stamp, stamp).lastInsertRowid));

    const rows = []; // {t, market, customer, gov, pay, courier, status, lines}
    const person = () => `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;

    for (const [market, customer, gov, pay, courier, daysAgo, status, lines] of RECENT) {
      rows.push({ t: now - daysAgo * DAY - (1 + Math.floor(rand() * 9)) * 3600_000, market, customer, gov, pay, courier, status, lines });
    }

    for (let d = 365; d >= 0; d--) { // سجل المبيعات حتى اليوم: يزداد تدريجيًا من ~٢ إلى ~٥ طلبات يوميًا
      const n = Math.floor(1.6 + ((365 - d) / 365) * 3.4 + rand());
      for (let i = 0; i < n; i++) {
        const t = d === 0 ? now - 60_000 - Math.floor(rand() * 14 * 3600_000) : now - d * DAY + Math.floor(rand() * DAY);
        const market = pick(rand, MARKET_W);
        const pool = PRODUCTS.map((p, i2) => [i2, PRODUCT_W[i2]]).filter(([i2]) => PRODUCTS[i2][2].includes(market));
        const lines = [[pick(rand, pool), rand() < 0.8 ? 1 : rand() < 0.85 ? 2 : 3]];
        if (rand() < 0.18) { const extra = pick(rand, pool); if (extra !== lines[0][0]) lines.push([extra, 1]); }
        const age = (now - t) / DAY;
        const r = rand();
        // الأقدم مُسلَّم غالبًا، والأحدث قيد التجهيز أو الشحن
        const status = age > 12 ? (r < 0.06 ? 3 : 2)
          : age > 6 ? (r < 0.72 ? 2 : r < 0.95 ? 1 : 3)
          : age > 2 ? (r < 0.35 ? 2 : r < 0.9 ? 1 : 0)
          : (r < 0.55 ? 0 : 1);
        rows.push({ t, market, customer: person(), gov: pick(rand, GOVS), pay: pick(rand, PAY_W), courier: pick(rand, COURIER_W), status, lines });
      }
    }

    rows.sort((a, b) => a.t - b.t);
    const insOrder = q('INSERT INTO orders (user_id,no,market,customer,phone,gov,address,pay,courier,total,cost_total,ship_fee,status,items,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insItem = q('INSERT INTO order_items (order_id,product_id,name,qty,price,cost) VALUES (?,?,?,?,?,?)');

    rows.forEach((o, i) => {
      let total = 0, cost = 0;
      const parts = o.lines.map(([pi, qty]) => {
        const p = PRODUCTS[pi];
        total += p[3] * qty; cost += p[5] * qty;
        return `${p[0]}${qty > 1 ? ` (${arNum(qty)} قطع)` : ''}`;
      });
      const age = (now - o.t) / DAY;
      const settled = o.status === 2 && o.pay === COD && age > 14 ? new Date(o.t + 6 * DAY).toISOString() : null;
      const info = insOrder.run(uid, 1001 + i, o.market, o.customer, '', o.gov, '', o.pay, o.courier, total, cost, COURIERS[o.courier].fee, o.status, parts.join(' + '), new Date(o.t).toISOString(), settled);
      for (const [pi, qty] of o.lines) insItem.run(Number(info.lastInsertRowid), ids[pi], PRODUCTS[pi][0], qty, PRODUCTS[pi][3], PRODUCTS[pi][5]);
    });

    q('UPDATE users SET order_seq = ?, last_sync_at = ?, ai_cache = ? WHERE id = ?')
      .run(1000 + rows.length, new Date(now - 2 * 60_000).toISOString(), '{}', uid);
  });
}

module.exports = { seedDemo };
