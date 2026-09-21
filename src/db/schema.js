module.exports = function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_jid TEXT NOT NULL,
      group_name TEXT DEFAULT '',
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      similarity_score REAL,
      source TEXT DEFAULT 'generated',
      embedding TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'processing',
      chunk_count INTEGER DEFAULT 0,
      error TEXT DEFAULT '',
      file_path TEXT DEFAULT '',
      mime_type TEXT DEFAULT '',
      title TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      chat_jid TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      sender_name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      quoted TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_jid, msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_ts ON chat_messages(chat_jid, ts);
  `);

  // Older DBs may predate the embedding column
  const qaCols = db.prepare(`PRAGMA table_info(qa_history)`).all().map((c) => c.name);
  if (!qaCols.includes('embedding')) {
    db.exec(`ALTER TABLE qa_history ADD COLUMN embedding TEXT`);
  }
  if (!qaCols.includes('document_id')) {
    db.exec(`ALTER TABLE qa_history ADD COLUMN document_id INTEGER`);
  }

  const docCols = db.prepare(`PRAGMA table_info(documents)`).all().map((c) => c.name);
  if (!docCols.includes('file_path')) {
    db.exec(`ALTER TABLE documents ADD COLUMN file_path TEXT DEFAULT ''`);
  }
  if (!docCols.includes('mime_type')) {
    db.exec(`ALTER TABLE documents ADD COLUMN mime_type TEXT DEFAULT ''`);
  }
  if (!docCols.includes('title')) {
    db.exec(`ALTER TABLE documents ADD COLUMN title TEXT DEFAULT ''`);
  }

  const backfillTitle = db.prepare(`UPDATE documents SET title = ? WHERE id = ?`);
  db.prepare(`SELECT id, filename, title FROM documents WHERE title IS NULL OR title = ''`)
    .all()
    .forEach((row) => {
      const stem = String(row.filename || '').replace(/\.[^.]+$/, '') || row.filename;
      backfillTitle.run(stem, row.id);
    });

  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('bot_mode', 'auto')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('private_chats', 'on')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('allowed_groups', '[]')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_users', '[]')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('lemonfox_voice', ?)`
  ).run(String(process.env.LEMONFOX_VOICE || 'sarah').trim().toLowerCase() || 'sarah');
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_digest', 'on')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('deadline_reminders', 'on')`
  ).run();
  // Auto-summarize uploaded call/meeting recordings into Key points / Decisions / Action items.
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('meeting_summaries', 'on')`
  ).run();
  // Prepend a short "this came up before" note when reusing a stored answer.
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('repeat_nudge', 'on')`
  ).run();
  // Append a one-line "Source: <document>" footer to answers built from an uploaded file.
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('show_sources', 'on')`
  ).run();

  // Admin availability calendar — stores per-person weekly schedules.
  db.exec(`
    CREATE TABLE IF NOT EXISTS availability (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT    NOT NULL,
      phone     TEXT    NOT NULL DEFAULT '',
      dow       INTEGER NOT NULL,  -- 0=Sun 1=Mon … 6=Sat
      start_h   INTEGER NOT NULL,  -- 0-23
      end_h     INTEGER NOT NULL,  -- 1-24 (exclusive)
      label     TEXT    NOT NULL DEFAULT '',  -- optional display note e.g. "Mornings only"
      created_at TEXT   DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_avail_name ON availability(name);
  `);

  // Group mode: 'active' (reply normally), 'observer' (learn silently, never reply).
  // Stored in settings as JSON map { "jid@g.us": "active"|"observer" }
  db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('group_modes', '{}')`
  ).run();

  // Session tokens for cookie-based login (replaces HTTP Basic Auth popup).
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
};