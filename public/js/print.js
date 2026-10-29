// يربط زر الطباعة ويطبع تلقائيًا عند فتح الصفحة بـ ?print=1 (الـ CSP يمنع السكربتات المضمّنة)
document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
if (new URLSearchParams(location.search).has('print')) window.addEventListener('load', () => setTimeout(() => window.print(), 300));
