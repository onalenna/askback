const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// The database file lives in the project root by default (data.db). Set
// DATA_DIR to put it (and any future data files) on a mounted volume instead —
// this is what the Docker/Coolify deploy uses so the DB survives redeploys.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', '..');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

require('./schema')(db);

module.exports = db;