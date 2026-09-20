const fs = require('fs');
const path = require('path');
const { statements } = require('../db/queries');

const STICKERS_DIR = path.join(__dirname, '..', '..', 'stickers');
const STICKER_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif']);

function stickersDir() {
  fs.mkdirSync(STICKERS_DIR, { recursive: true });
  return STICKERS_DIR;
}

function mimeForName(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/webp';
}

/** "1936-friend.png" → "friend" */
function stickerTitleFromFilename(filename) {
  const stem = String(filename || '')
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+-/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (stem || filename || 'sticker').slice(0, 120);
}

function listDiskStickerFiles() {
  const dir = stickersDir();
  return fs
    .readdirSync(dir)
    .filter((name) => {
      if (name.startsWith('.')) return false;
      return STICKER_EXTS.has(path.extname(name).toLowerCase());
    })
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((name) => {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      if (!stat.isFile()) return null;
      return {
        filename: name,
        path: full,
        title: stickerTitleFromFilename(name),
        mimetype: mimeForName(name),
        size: stat.size,
      };
    })
    .filter(Boolean);
}

/**
 * Register every file in stickers/ as a type=sticker document (file_path stays in stickers/).
 * Idempotent by filename.
 */
function syncStickersLibrary() {
  const onDisk = listDiskStickerFiles();
  const byName = new Map(
    statements.allStickers.all().map((doc) => [String(doc.filename || '').toLowerCase(), doc])
  );
  let added = 0;
  let updated = 0;

  for (const file of onDisk) {
    const key = file.filename.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      const id = statements.insertDoc.run(
        file.filename,
        'sticker',
        file.path,
        file.mimetype,
        file.title
      ).lastInsertRowid;
      statements.updateDocFile.run(file.path, file.mimetype, id);
      statements.updateDocChunks.run(0, id);
      statements.updateDocStatus.run('ready', '', id);
      added += 1;
      continue;
    }
    const needsPath = existing.file_path !== file.path || !fs.existsSync(existing.file_path || '');
    const needsTitle = !existing.title || existing.title === existing.filename;
    if (needsPath) {
      statements.updateDocFile.run(file.path, file.mimetype, existing.id);
      updated += 1;
    }
    if (needsTitle) {
      statements.updateDocTitle.run(file.title, existing.id);
    }
    if (String(existing.status) !== 'ready') {
      statements.updateDocChunks.run(0, existing.id);
      statements.updateDocStatus.run('ready', '', existing.id);
    }
  }

  return { total: onDisk.length, added, updated, dir: STICKERS_DIR };
}

function saveStickerToLibrary(srcPath, filename) {
  const dir = stickersDir();
  const safe = path.basename(String(filename || 'sticker.webp')).replace(/[^\w.\-()+ ]+/g, '_');
  const dest = path.join(dir, safe);
  fs.copyFileSync(srcPath, dest);
  return { path: dest, filename: safe, title: stickerTitleFromFilename(safe), mimetype: mimeForName(safe) };
}

module.exports = {
  STICKERS_DIR,
  stickersDir,
  listDiskStickerFiles,
  syncStickersLibrary,
  saveStickerToLibrary,
  stickerTitleFromFilename,
  mimeForName,
};
