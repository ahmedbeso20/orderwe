'use strict';
// ثوابت المجال التجاري المشتركة بين المسارات

const VAT = 0.14;

const MARKETS = {
  a: { name: 'أمازون مصر', fee: 12 },
  n: { name: 'نون مصر', fee: 10 },
  j: { name: 'جوميا', fee: 11 }
};

// رسوم الشحن التقديرية للطلب (عدّلها لتطابق عقدك مع شركة الشحن)
const COURIERS = {
  'بوسطة': { key: 'bosta', fee: 38, cycle: 'تحويل يومي متاح' },
  'أرامكس': { key: 'aramex', fee: 45, cycle: 'تحويل مرتين أسبوعيًا' },
  'مايلرز': { key: 'mylerz', fee: 35, cycle: 'تحويل كل خميس' }
};
const COURIER_BY_KEY = Object.fromEntries(Object.entries(COURIERS).map(([label, c]) => [c.key, label]));

const COD = 'عند الاستلام';
const PAYMENTS = [COD, 'فودافون كاش', 'إنستاباي', 'بطاقة بنكية', 'فوري'];
const PAY_BUCKET = { [COD]: 'cod', 'فودافون كاش': 'wallet', 'إنستاباي': 'wallet', 'بطاقة بنكية': 'card', 'فوري': 'card' };

const PLANS = {
  free: { id: 'free', name: 'باقة البداية', products: 50, markets: 2, ai: 15 },
  pro: { id: 'pro', name: 'باقة التاجر المحترف', products: 1500, markets: 3, ai: 200 },
  business: { id: 'business', name: 'باقة الشركات والعلامات', products: null, markets: 3, ai: 1000 }
};

// حالات الطلب: 0 قيد التجهيز، 1 تم الشحن، 2 تم التسليم، 3 مرتجع
const STATUS_NEXT = { 0: [1], 1: [2, 3] };

const INTEGRATION_KEYS = ['a', 'n', 'j', 'bs', 'ar', 'my', 'eta', 'fw', 'vc'];
const NOTIFICATION_KEYS = ['s', 'o', 'f', 'w'];

// عمولة السوق + ضريبة القيمة المضافة عليها كنسبة من إجمالي الطلب (جزء SQL)
const FEE_RATE_SQL = `(CASE market WHEN 'a' THEN ${MARKETS.a.fee} WHEN 'n' THEN ${MARKETS.n.fee} ELSE ${MARKETS.j.fee} END) / 100.0 * ${1 + VAT}`;

module.exports = { VAT, MARKETS, COURIERS, COURIER_BY_KEY, COD, PAYMENTS, PAY_BUCKET, PLANS, STATUS_NEXT, INTEGRATION_KEYS, NOTIFICATION_KEYS, FEE_RATE_SQL };
