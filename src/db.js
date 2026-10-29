'use strict';
const { DatabaseSync } = require('node:sqlite');

// كل عنصر = ترحيل (migration) يُنفَّذ مرة واحدة. أضف عناصر جديدة في النهاية فقط
const MIGRATIONS = [`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  pass_hash TEXT NOT NULL,
  token_ver INTEGER NOT NULL DEFAULT 1,
  store_name TEXT NOT NULL,
  tax_id TEXT NOT NULL DEFAULT '',
  instapay TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  is_demo INTEGER NOT NULL DEFAULT 0,
  integrations TEXT NOT NULL DEFAULT '{}',
  notifications TEXT NOT NULL DEFAULT '{"s":1,"o":1,"f":1,"w":0}',
  ai_cache TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  order_seq INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL,
  cat TEXT NOT NULL DEFAULT 'عام',
  markets TEXT NOT NULL DEFAULT 'a',
  price REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, sku)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  no INTEGER NOT NULL,
  market TEXT NOT NULL,
  customer TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  gov TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  pay TEXT NOT NULL,
  courier TEXT NOT NULL,
  total REAL NOT NULL,
  cost_total REAL NOT NULL DEFAULT 0,
  ship_fee REAL NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (user_id, no)
);
CREATE INDEX orders_user_date ON orders(user_id, created_at);
CREATE INDEX orders_user_status ON orders(user_id, status);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL
);
CREATE INDEX order_items_order ON order_items(order_id);

CREATE TABLE payouts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  courier TEXT NOT NULL,
  gross REAL NOT NULL,
  fees REAL NOT NULL,
  net REAL NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`];

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

  let v = db.prepare('PRAGMA user_version').get().user_version;
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  const cache = new Map();
  /** عبارة SQL مُجهَّزة ومخزّنة مؤقتًا */
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = db.prepare(sql))); return s; };

  let depth = 0;
  /** ينفّذ fn داخل معاملة ذرّية (كلها أو لا شيء) */
  const tx = (fn) => {
    if (depth) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { depth = 0; }
  };

  return { db, q, tx, close: () => db.close() };
}

module.exports = { openDb };
