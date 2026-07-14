-- hoshosho 初期スキーマ (design.md §5.1 + セッション管理)

CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- 内部ID
  google_sub    TEXT UNIQUE NOT NULL,
  email         TEXT NOT NULL,
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,            -- セッショントークンのSHA-256ハッシュ(hex)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,               -- ISO 8601 (UTC)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE warranties (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_name       TEXT NOT NULL,
  purchase_date      TEXT,                 -- YYYY-MM-DD、null可
  warranty_months    INTEGER,              -- null可
  warranty_end_date  TEXT,                 -- YYYY-MM-DD、null可(検索の主キー)
  note               TEXT,
  source             TEXT NOT NULL DEFAULT 'manual',  -- 'ocr' | 'manual' | 'mixed'
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_warranties_user_end
  ON warranties(user_id, warranty_end_date);
CREATE INDEX idx_warranties_user_name
  ON warranties(user_id, product_name);

CREATE TABLE ocr_usage (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start  TEXT NOT NULL,               -- 週の起点(YYYY-MM-DD、月曜JST)
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_start)
);

CREATE TABLE daily_ocr_total (
  date   TEXT PRIMARY KEY,                 -- YYYY-MM-DD(UTC、無料枠リセットに合わせる)
  count  INTEGER NOT NULL DEFAULT 0
);
