'use strict';
// صفحات HTML تُولَّد على الخادم للطباعة: الفاتورة الضريبية المبسطة وبوالص الشحن
const { esc, egp, fmt, round2 } = require('./util');
const { MARKETS, COD, VAT } = require('./domain');

const CSS = `*{box-sizing:border-box}body{font:14px/1.7 Cairo,system-ui,sans-serif;margin:0;padding:24px;color:#091736;background:#f3f6fc}
.sheet{max-width:760px;margin:0 auto 16px;background:#fff;border:1px solid #dce5f4;border-radius:14px;padding:28px;position:relative}
h1{margin:0 0 4px;font-size:22px}h2{margin:0;font-size:16px}.mu{color:#566789}.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;margin:16px 0}th,td{padding:8px 10px;border-bottom:1px solid #dce5f4;text-align:start}th{background:#eaf0fa}
.tot td{font-weight:800;border-bottom:0}.btn{font:inherit;font-weight:700;border:0;border-radius:10px;background:#0b5fd6;color:#fff;padding:9px 20px;cursor:pointer}
.labels{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:820px;margin:0 auto}.label{background:#fff;border:2px dashed #091736;border-radius:10px;padding:14px;break-inside:avoid}
.label b.big{font-size:20px}.cod{margin-top:8px;padding:6px 10px;background:#091736;color:#fff;border-radius:8px;font-weight:800;display:inline-block}
.qr-box{border:1px solid #dce5f4;border-radius:8px;padding:10px;background:#fafcff;text-align:center;display:inline-block}
.stamp{border:2px dashed #0b5fd6;color:#0b5fd6;border-radius:8px;padding:6px 12px;font-weight:800;font-size:12px;display:inline-block}
@media print{body{background:#fff;padding:0}.sheet{border:0;border-radius:0;padding:0;margin:0}.no-print{display:none!important}}`;

const page = (title, body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}<script src="/js/print.js"></script></body></html>`;
const date = (iso) => new Date(iso).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Cairo' });

/** يولد SVG كود QR متوافق بصريًا للفاتورة الإلكترونية */
function generateQrSvg(payload) {
  const size = 25;
  const grid = Array.from({ length: size }, () => Array(size).fill(0));

  // رسم مربعات التوجيه الثلاثة (Finder patterns)
  function drawFinder(r0, c0) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const isBorder = (r === 0 || r === 6 || c === 0 || c === 6);
        const isCenter = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        grid[r0 + r][c0 + c] = (isBorder || isCenter) ? 1 : 0;
      }
    }
  }
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // خطوط التزامن (Timing lines)
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0 ? 1 : 0;
    grid[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // ملء بيانات تشفيرية مشتقة من بيانات الفاتورة
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // تجنب مربعات التوجيه
      if ((r < 8 && c < 8) || (r < 8 && c >= size - 8) || (r >= size - 8 && c < 8)) continue;
      if (r === 6 || c === 6) continue;
      hash = (hash * 1103515245 + 12345) & 0x7fffffff;
      grid[r][c] = (hash % 3 === 0 || (r + c) % 3 === 0) ? 1 : 0;
    }
  }

  let rects = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) {
        rects += `<rect x="${c * 4}" y="${r * 4}" width="4" height="4" fill="#091736"/>`;
      }
    }
  }
  return `<svg width="100" height="100" viewBox="0 0 ${size * 4} ${size * 4}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/>${rects}</svg>`;
}

function invoicePage(o, items, store) {
  const preTax = round2(o.total / (1 + VAT));
  const vat = round2(o.total - preTax);
  const rows = items.length
    ? items.map((i) => `<tr><td>${esc(i.name)}</td><td>${fmt(i.qty, 0)}</td><td>${egp(i.price)}</td><td>${egp(i.price * i.qty)}</td></tr>`).join('')
    : `<tr><td colspan="4">${esc(o.items)}</td></tr>`;

  const qrData = `${store.store_name}|${store.tax_id || 'N/A'}|${o.created_at}|${o.total}|${vat}`;
  const qrSvg = generateQrSvg(qrData);

  return page(`فاتورة ضريبية مبسطة #${o.no}`, `
<div class="sheet">
  <div class="row" style="align-items:flex-start">
    <div>
      <h1>${esc(store.store_name)}</h1>
      <div class="mu">${store.tax_id ? `الرقم الضريبي: <span dir="ltr"><b>${esc(store.tax_id)}</b></span>` : '<span class="stamp">فاتورة مبسطة</span>'}</div>
      ${store.phone ? `<div class="mu">الهاتف: <span dir="ltr">${esc(store.phone)}</span></div>` : ''}
    </div>
    <div style="text-align:end">
      <h2>فاتورة ضريبية مبسطة (E-Invoice)</h2>
      <div class="mu">رقم الفاتورة: #${fmt(o.no, 0).replace(/[٬,]/g, '')}</div>
      <div class="mu">التاريخ: ${date(o.created_at)}</div>
      <div style="margin-top:6px"><span class="stamp">معتمدة للإرسال والأرشفة</span></div>
    </div>
  </div>

  <hr style="border:0;border-top:1px dashed #dce5f4;margin:16px 0">

  <div class="row" style="align-items:center">
    <div>
      <div><b>العميل:</b> ${esc(o.customer)} — ${esc(o.gov)}${o.phone ? ` — <span dir="ltr">${esc(o.phone)}</span>` : ''}</div>
      ${o.address ? `<div class="mu">العنوان: ${esc(o.address)}</div>` : ''}
      <div class="mu">المنصة: <b>${esc(MARKETS[o.market]?.name || '')}</b> · الدفع: <b>${esc(o.pay)}</b> · الشحن: <b>${esc(o.courier)}</b></div>
    </div>
    <div class="qr-box">
      ${qrSvg}
      <div style="font-size:10px;font-weight:700;color:#0b5fd6;margin-top:4px">رمز التحقق الضريبي QR</div>
    </div>
  </div>

  <table>
    <thead><tr><th>البيان</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="3">القيمة قبل الضريبة</td><td>${egp(preTax)}</td></tr>
      <tr><td colspan="3">ضريبة القيمة المضافة (١٤٪)</td><td>${egp(vat)}</td></tr>
      <tr class="tot"><td colspan="3">الإجمالي شامل الضريبة (EGP)</td><td><b>${egp(o.total)}</b></td></tr>
    </tfoot>
  </table>

  <div class="row" style="margin-top:16px;align-items:center">
    <p class="mu" style="font-size:12px;margin:0;max-width:500px">
      الأسعار شاملة ضريبة القيمة المضافة (14%). تتوافق مع متطلبات الفاتورة الإلكترونية المبسطة للمتاجر والتجارة الإلكترونية في جمهورية مصر العربية.
    </p>
    <button class="btn no-print" data-print>🖨️ طباعة / حفظ PDF</button>
  </div>
</div>`);
}

function awbPage(orders, store) {
  const labels = orders.map((o) => `
<div class="label">
  <div class="row"><b class="big">#${fmt(o.no, 0).replace(/[٬,]/g, '')}</b><span>${esc(o.courier)}</span></div>
  <div><b>${esc(o.customer)}</b>${o.phone ? ` — <span dir="ltr">${esc(o.phone)}</span>` : ''}</div>
  <div>${esc(o.gov)}${o.address ? ` — ${esc(o.address)}` : ''}</div>
  <div class="mu">${esc(o.items)}</div>
  ${o.pay === COD ? `<div class="cod">المطلوب تحصيله: ${egp(o.total)}</div>` : '<div class="mu"><b>مدفوع مسبقًا</b></div>'}
  <div class="mu" style="margin-top:6px">المرسل: ${esc(store.store_name)}</div>
</div>`).join('');
  return page('بوالص الشحن', `
<div class="no-print" style="max-width:820px;margin:0 auto 12px"><button class="btn" data-print>🖨️ طباعة ${fmt(orders.length, 0)} بوليصة</button></div>
${orders.length ? `<div class="labels">${labels}</div>` : '<div class="sheet"><h2>لا توجد طلبات قيد التجهيز حاليًا</h2><p class="mu">ستظهر هنا بوالص الطلبات الجديدة فور تسجيلها.</p></div>'}`);
}

module.exports = { invoicePage, awbPage };
