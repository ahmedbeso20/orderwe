'use strict';
const { HttpError, round2, nowIso } = require('../util');
const { MARKETS, COURIERS, COURIER_BY_KEY, COD, PAY_BUCKET, FEE_RATE_SQL } = require('../domain');

const DAY = 86400000;
// الإيراد/العمولات/صافي الربح لكل طلب. المرتجع: لا إيراد وخسارة شحن ذهابًا وإيابًا (×١٫٨ كما في الحاسبة)
const REV = 'CASE WHEN status <> 3 THEN total ELSE 0 END';
const FEES = `CASE WHEN status <> 3 THEN total * ${FEE_RATE_SQL} ELSE 0 END`;
const NET = `CASE WHEN status <> 3 THEN total - total * ${FEE_RATE_SQL} - cost_total - ship_fee ELSE -ship_fee * 1.8 END`;

module.exports = (r, { q, tx, model }) => {
  const iso = (t) => new Date(t).toISOString();
  const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null);

  const { codBalances } = model;

  r.get('/api/dashboard', ({ user, query }) => {
    const range = [7, 30, 90].includes(+query.range) ? +query.range : 30;
    const market = MARKETS[query.market] ? query.market : null;
    const mk = market ? ' AND market = ?' : '';
    const now = Date.now();
    const win = (from, to) => q(`SELECT COALESCE(SUM(${REV}), 0) gross, COALESCE(SUM(${FEES}), 0) fees, COALESCE(SUM(${NET}), 0) net,
        COUNT(*) orders, COALESCE(SUM(status = 2), 0) delivered, COALESCE(SUM(status = 3), 0) returned
      FROM orders WHERE user_id = ? AND created_at >= ? AND created_at < ?${mk}`).get(...[user.id, iso(from), iso(to), ...(market ? [market] : [])]);

    const cur = win(now - range * DAY, now + 60_000);
    const prev = win(now - 2 * range * DAY, now - range * DAY);
    const finished = cur.delivered + cur.returned;

    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1);
    const byMonth = new Map(q(`SELECT substr(created_at, 1, 7) ym, COALESCE(SUM(${REV}), 0) revenue, COALESCE(SUM(${NET}), 0) profit
      FROM orders WHERE user_id = ? AND created_at >= ?${mk} GROUP BY ym`).all(...[user.id, iso(start), ...(market ? [market] : [])]).map((x) => [x.ym, x]));
    const months = Array.from({ length: 12 }, (_, i) => {
      const ym = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7);
      const x = byMonth.get(ym);
      return { ym, revenue: round2(x?.revenue), profit: round2(x?.profit) };
    });

    const since = iso(now - range * DAY);
    const mRows = q(`SELECT market, COALESCE(SUM(${REV}), 0) amount FROM orders WHERE user_id = ? AND created_at >= ? GROUP BY market`).all(user.id, since);
    const mTotal = mRows.reduce((s, x) => s + x.amount, 0);
    const marketShare = Object.fromEntries(Object.keys(MARKETS).map((k) => {
      const amount = round2(mRows.find((x) => x.market === k)?.amount);
      return [k, { amount, pct: mTotal ? Math.round((amount / mTotal) * 1000) / 10 : 0 }];
    }));

    const payShare = { cod: 0, wallet: 0, card: 0 };
    const pRows = q('SELECT pay, COUNT(*) n FROM orders WHERE user_id = ? AND created_at >= ? GROUP BY pay').all(user.id, since);
    const pTotal = pRows.reduce((s, x) => s + x.n, 0);
    for (const x of pRows) payShare[PAY_BUCKET[x.pay] || 'card'] += x.n;
    for (const k of Object.keys(payShare)) payShare[k] = pTotal ? Math.round((payShare[k] / pTotal) * 1000) / 10 : 0;

    const recent = q(`SELECT * FROM orders WHERE user_id = ?${mk} ORDER BY created_at DESC, id DESC LIMIT 5`).all(...[user.id, ...(market ? [market] : [])]).map(model.orderOf);

    return {
      range, market: market || 'all',
      kpis: {
        gross: round2(cur.gross), net: round2(cur.net), fees: round2(cur.fees), orders: cur.orders,
        margin: cur.gross ? Math.round((cur.net / cur.gross) * 1000) / 10 : 0,
        deliveryRate: finished ? Math.round((cur.delivered / finished) * 1000) / 10 : 0,
        grossDelta: pct(cur.gross, prev.gross), netDelta: pct(cur.net, prev.net),
        codReady: codBalances(user.id).totals.net
      },
      months, marketShare, payShare, recent
    };
  });

  r.get('/api/cod', ({ user }) => ({ ...codBalances(user.id), instaPayHandle: user.instapay }));

  r.post('/api/cod/:courier/payout', ({ user, params }) => {
    const label = COURIER_BY_KEY[params.courier];
    if (!label) throw new HttpError(404, 'شركة الشحن غير معروفة');
    if (!user.instapay) throw new HttpError(409, 'أضف عنوان InstaPay لاستلام التحصيلات من صفحة الإعدادات أولًا');
    const out = tx(() => {
      const c = codBalances(user.id).couriers.find((x) => x.key === params.courier);
      if (c.collected <= 0 || c.net <= 0) throw new HttpError(409, 'لا يوجد رصيد قابل للسحب لدى هذه الشركة حاليًا');
      const now = nowIso();
      q("UPDATE orders SET settled_at = ? WHERE user_id = ? AND pay = ? AND courier = ? AND status = 2 AND settled_at IS NULL").run(now, user.id, COD, label);
      q('INSERT INTO payouts (user_id,courier,gross,fees,net,handle,created_at) VALUES (?,?,?,?,?,?,?)').run(user.id, label, c.collected, c.fees, c.net, user.instapay, now);
      return c;
    });
    return { net: out.net, handle: user.instapay, ...codBalances(user.id), instaPayHandle: user.instapay };
  });
};
