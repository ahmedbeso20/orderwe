'use strict';
const { createApp } = require('./src/app');

const app = createApp();
const { port, host, geminiKey } = app.cfg;

app.server.listen(port, host, () => {
  console.log(`OmniArab يعمل على http://localhost:${port}`);
  if (!geminiKey) console.log('تنبيه: GEMINI_API_KEY غير مضبوط — ستعمل ميزات الذكاء الاصطناعي بقوالب جاهزة.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.close().then(() => process.exit(0)));
}
