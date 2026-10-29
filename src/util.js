'use strict';

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg) => new HttpError(400, msg);

const AR = '٠١٢٣٤٥٦٧٨٩';
const FA = '۰۱۲۳۴۵۶۷۸۹';
/** يحوّل الأرقام العربية/الفارسية إلى لاتينية */
const latin = (s) => String(s ?? '').replace(/[٠-٩۰-۹]/g, (d) => String(AR.includes(d) ? AR.indexOf(d) : FA.indexOf(d)));
/** ينظّف النص: يزيل المحارف غير المرئية وعلامات الاتجاه ويضغط المسافات */
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

function text(v, name, { min = 1, max = 100, optional = false } = {}) {
  const s = clean(v);
  if (!s && optional) return '';
  if (s.length < min || s.length > max) throw bad(`${name}: يجب أن يكون بين ${min} و${max} حرفًا`);
  return s;
}
function money(v, name, { min = 0, max = 10_000_000 } = {}) {
  const n = Number(latin(v));
  if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) throw bad(`${name}: قيمة غير صالحة`);
  return Math.round(n * 100) / 100;
}
function integer(v, name, { min = 0, max = 1_000_000 } = {}) {
  const n = Number(latin(v));
  if (v === '' || v == null || !Number.isInteger(n) || n < min || n > max) throw bad(`${name}: أدخل عددًا صحيحًا بين ${min} و${max}`);
  return n;
}
function phone(v, { optional = false } = {}) {
  let s = latin(v).replace(/[\s\-()]/g, '');
  if (!s && optional) return '';
  s = s.replace(/^(?:\+|00)?20(?=1[0125]\d{8}$)/, '0');
  if (!/^01[0125]\d{8}$/.test(s)) throw bad('رقم الموبايل غير صحيح، مثال: 01012345678');
  return s;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function email(v) {
  const s = clean(v).toLowerCase();
  if (!s) return null;
  if (s.length > 120 || !EMAIL_RE.test(s)) throw bad('البريد الإلكتروني غير صحيح');
  return s;
}
function password(v, phoneNo) {
  const s = String(v ?? '');
  if (s.length < 8 || s.length > 128) throw bad('كلمة المرور يجب أن تكون ٨ أحرف على الأقل');
  if (s === phoneNo) throw bad('اختر كلمة مرور مختلفة عن رقم الموبايل');
  return s;
}
const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw bad(`${name}: قيمة غير مسموح بها`);
  return v;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: d });
const egp = (n) => `${fmt(n)} ج.م`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nowIso = () => new Date().toISOString();

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // حماية من حقن الصيغ في Excel
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (rows) => '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const parseJson = (s, dflt) => { try { return JSON.parse(s) ?? dflt; } catch { return dflt; } };

module.exports = { HttpError, bad, latin, clean, text, money, integer, phone, email, password, oneOf, esc, fmt, egp, round2, nowIso, toCsv, parseJson };
