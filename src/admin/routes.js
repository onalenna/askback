const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { statements } = require('../db/queries');
const db = require('../db');
const { ingestFile, replaceFile, unlinkQuiet } = require('../processor/ingest');
const { getBotMode } = require('../whatsapp/answer');
const { getSocket } = require('../whatsapp/client');
const { listGroups, setGroupAllowed } = require('../whatsapp/groups');
const { listAdmins, addAdmin, removeAdmin } = require('../whatsapp/admins');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.mp4'];

function detectType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return null;
}

function sanitizeDisplayName(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') return '';
  return base;
}

function sanitizeTitle(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function publicDoc(doc) {
  if (!doc) return null;
  const { file_path, ...rest } = doc;
  return {
    ...rest,
    sharable: !!(file_path && fs.existsSync(file_path)),
  };
}

function liveStats() {
  return {
    totalQA: db.prepare(`SELECT COUNT(*) AS c FROM qa_history`).get().c,
    todayQA: db.prepare(
      `SELECT COUNT(*) AS c FROM qa_history WHERE date(created_at) = date('now')`
    ).get().c,
    totalDocs: db.prepare(`SELECT COUNT(*) AS c FROM documents`).get().c,
    totalChunks: db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get().c,
    bySource: db
      .prepare(`SELECT source, COUNT(*) AS c FROM qa_history GROUP BY source`)
      .all(),
    botMode: getBotMode(),
  };
}

function createAdminRouter() {
  const router = express.Router();

  router.get('/api/stats', (_req, res) => {
    res.json(liveStats());
  });

  router.get('/api/documents', (_req, res) => {
    res.json(statements.allDocs.all().map(publicDoc));
  });

  router.get('/api/qa', (_req, res) => {
    res.json(statements.recentQA.all(50));
  });

  router.post('/api/bot-mode', express.json(), (req, res) => {
    const mode = req.body?.mode === 'off' ? 'off' : 'auto';
    statements.setSetting.run('bot_mode', mode);
    process.env.BOT_MODE = mode;
    res.json({ botMode: mode });
  });

  router.get('/api/groups', async (_req, res) => {
    try {
      const groups = await listGroups(getSocket());
      res.json(groups);
    } catch (err) {
      console.error('[admin] list groups failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Could not list groups' });
    }
  });

  router.post('/api/groups', express.json(), async (req, res) => {
    try {
      const jid = String(req.body?.jid || '').trim();
      const enabled = Boolean(req.body?.enabled);
      setGroupAllowed(jid, enabled);
      const groups = await listGroups(getSocket());
      res.json(groups);
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not update group' });
    }
  });

  router.get('/api/admins', (_req, res) => {
    res.json(listAdmins());
  });

  router.post('/api/admins', express.json(), (req, res) => {
    try {
      res.json(addAdmin({ name: req.body?.name, phone: req.body?.phone }));
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not add admin' });
    }
  });

  router.delete('/api/admins/:id', (req, res) => {
    try {
      res.json(removeAdmin(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not remove admin' });
    }
  });

  router.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const original = sanitizeDisplayName(req.file.originalname || req.file.filename);
    const type = detectType(original);
    if (!type) {
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: 'Unsupported file type. Upload PDF or audio.' });
    }

    const title = sanitizeTitle(req.body?.title);
    if (!title) {
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: 'Give the file a short name, like Meeting notes or Programme.' });
    }

    try {
      const result = await ingestFile(req.file.path, original, type, title);
      res.json(result);
    } catch (err) {
      console.error('[admin] ingest failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Ingest failed' });
    } finally {
      unlinkQuiet(req.file.path);
    }
  });

  router.patch('/api/documents/:id', express.json(), (req, res) => {
    const id = Number(req.params.id);
    const doc = statements.getDoc.get(id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const title = sanitizeTitle(req.body?.title);
    const filename = sanitizeDisplayName(req.body?.filename);
    if (!title && !filename) {
      return res.status(400).json({ error: 'Name required' });
    }

    if (title) statements.updateDocTitle.run(title, id);
    if (filename) statements.updateDocFilename.run(filename, id);
    res.json(publicDoc(statements.getDoc.get(id)));
  });

  router.post('/api/documents/:id/replace', upload.single('file'), async (req, res) => {
    const id = Number(req.params.id);
    const doc = statements.getDoc.get(id);
    if (!doc) {
      if (req.file) unlinkQuiet(req.file.path);
      return res.status(404).json({ error: 'Document not found' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const original = sanitizeDisplayName(req.file.originalname || req.file.filename);
    const type = detectType(original);
    if (!type) {
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: 'Unsupported file type. Upload PDF or audio.' });
    }

    try {
      const result = await replaceFile(id, req.file.path, original, type);
      res.json(result);
    } catch (err) {
      console.error('[admin] replace failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Replace failed' });
    } finally {
      unlinkQuiet(req.file.path);
    }
  });

  router.get('/api/documents/:id/file', (req, res) => {
    const id = Number(req.params.id);
    const doc = statements.getDoc.get(id);
    if (!doc?.file_path || !fs.existsSync(doc.file_path)) {
      return res.status(404).json({ error: 'Original file is not stored. Re-upload it.' });
    }
    const ext = path.extname(doc.filename || '');
    const title = sanitizeTitle(doc.title);
    const downloadName = title
      ? path.extname(title)
        ? title
        : `${title}${ext}`
      : doc.filename;
    res.download(doc.file_path, downloadName);
  });

  router.delete('/api/documents/:id', (req, res) => {
    const id = Number(req.params.id);
    const doc = statements.getDoc.get(id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    unlinkQuiet(doc.file_path);
    statements.deleteChunksByDoc.run(id);
    statements.deleteQAByDoc.run(id);
    statements.deleteDoc.run(id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAdminRouter };
