const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { statements } = require('../db/queries');
const db = require('../db');
const { ingestFile, replaceFile, unlinkQuiet } = require('../processor/ingest');
const { openChatExport } = require('../processor/text');
const { isKnowledgeOnly } = require('../whatsapp/share');
const { resolveUploadType } = require('../processor/filetype');
const { getBotMode } = require('../whatsapp/answer');
const { getLemonfoxVoice, listLemonfoxVoices, setLemonfoxVoice } = require('../ai/voices');
const { getSocket } = require('../whatsapp/client');
const { listGroups, setGroupAllowed, sendGroupText } = require('../whatsapp/groups');
const { listAdmins, addAdmin, removeAdmin } = require('../whatsapp/admins');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 80 * 1024 * 1024 },
});

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
    sharable: !isKnowledgeOnly(doc) && !!(file_path && fs.existsSync(file_path)),
    downloadable: !!(file_path && fs.existsSync(file_path)),
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
    lemonfoxVoice: getLemonfoxVoice(),
    lemonfoxVoices: listLemonfoxVoices(),
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

  router.post('/api/tts-voice', express.json(), (req, res) => {
    try {
      const voice = setLemonfoxVoice(req.body?.voice);
      res.json({ voice, voices: listLemonfoxVoices() });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not save voice' });
    }
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

  router.post('/api/send', express.json(), async (req, res) => {
    try {
      const result = await sendGroupText(getSocket(), req.body?.jid, req.body?.text, {
        asVoice: Boolean(req.body?.asVoice),
      });
      res.json(result);
    } catch (err) {
      const msg = err.message || 'Could not send message';
      const code = /not connected/i.test(msg) ? 503 : 400;
      res.status(code).json({ error: msg });
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

    const { original, type } = resolveUploadType(req.file);
    const displayName = sanitizeDisplayName(original) || original || 'chat.txt';
    if (!type) {
      console.warn('[admin] unsupported upload', {
        original: req.file.originalname,
        mime: req.file.mimetype,
      });
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: 'Unsupported file type. Upload a WhatsApp .txt (or zip) export, PDF, or audio.' });
    }

    const title = sanitizeTitle(req.body?.title);
    if (!title) {
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: 'Give the file a short name, like Meeting notes or Group chat.' });
    }

    let ingestPath = req.file.path;
    let ingestName = displayName;
    let ingestType = type;
    let cleanup = '';
    try {
      if (type === 'zip') {
        const opened = openChatExport(req.file.path, displayName);
        ingestPath = opened.path;
        ingestName = path.basename(opened.path) || '_chat.txt';
        ingestType = 'text';
        cleanup = opened.cleanup;
      }
      const result = await ingestFile(ingestPath, ingestName, ingestType, title);
      res.json(result);
    } catch (err) {
      console.error('[admin] ingest failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Ingest failed' });
    } finally {
      unlinkQuiet(req.file.path);
      if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
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

    const { original, type } = resolveUploadType(req.file);
    const displayName = sanitizeDisplayName(original) || original || 'chat.txt';
    if (!type) {
      console.warn('[admin] unsupported replace', {
        original: req.file.originalname,
        mime: req.file.mimetype,
      });
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: 'Unsupported file type. Upload a WhatsApp .txt (or zip) export, PDF, or audio.' });
    }

    let ingestPath = req.file.path;
    let ingestName = displayName;
    let ingestType = type;
    let cleanup = '';
    try {
      if (type === 'zip') {
        const opened = openChatExport(req.file.path, displayName);
        ingestPath = opened.path;
        ingestName = path.basename(opened.path) || '_chat.txt';
        ingestType = 'text';
        cleanup = opened.cleanup;
      }
      const result = await replaceFile(id, ingestPath, ingestName, ingestType);
      res.json(result);
    } catch (err) {
      console.error('[admin] replace failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Replace failed' });
    } finally {
      unlinkQuiet(req.file.path);
      if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
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
