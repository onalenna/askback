const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { statements } = require('../db/queries');
const db = require('../db');
const { ingestFile, ingestSticker, replaceFile, unlinkQuiet } = require('../processor/ingest');
const { openChatExport, readChatText, parseChatTranscript, looksLikeChat } = require('../processor/text');
const { isKnowledgeOnly } = require('../whatsapp/share');
const { resolveUploadType, detectType } = require('../processor/filetype');
const { getBotMode, getPrivateChats, setPrivateChats, getRepeatNudge, setRepeatNudge, getShowSources, setShowSources } = require('../whatsapp/answer');
const { getMeetingSummaries, setMeetingSummaries } = require('../whatsapp/meetings');
const { buildAnalytics } = require('./analytics');
const { getTuning, setTuning } = require('../ai/settings');
const { providerName, CHAT_MODEL, EMBEDDING_MODEL, getEmbeddingsBatch } = require('../ai/embeddings');
const { getLemonfoxVoice, listLemonfoxVoices, setLemonfoxVoice } = require('../ai/voices');
const QRCode = require('qrcode');
const { getSocket, getPairingState, rePairWhatsApp } = require('../whatsapp/client');
const { listGroups, setGroupAllowed, sendGroupText, setGroupMode, getGroupModes } = require('../whatsapp/groups');
const { listAdmins, addAdmin, removeAdmin } = require('../whatsapp/admins');
const {
  getDailyDigest,
  setDailyDigest,
  scheduleNextDigest,
  runDailyDigest,
} = require('../whatsapp/digest');
const {
  getDeadlineReminders,
  setDeadlineReminders,
  restartDeadlineReminders,
  refreshUpcoming,
} = require('../whatsapp/reminders');
const { syncStickersLibrary } = require('../stickers/library');

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
  const onDisk = !!(file_path && fs.existsSync(file_path));
  const sticker = String(doc.type || '').toLowerCase() === 'sticker';
  return {
    ...rest,
    sticker,
    sharable: sticker ? onDisk : !isKnowledgeOnly(doc) && onDisk,
    downloadable: onDisk,
    viewable: sticker ? onDisk : Number(doc.chunk_count) > 0 || onDisk,
  };
}

function isKnowledgeListDoc(doc) {
  if (!doc) return false;
  if (String(doc.type || '').toLowerCase() === 'sticker') return false;
  // Chat-export stickers stay out of the main Knowledge list
  const name = `${doc.filename || ''} ${doc.title || ''}`;
  if (/\bSTICKER[-_]/i.test(name)) return false;
  return true;
}

const MAX_PREVIEW_MESSAGES = 2500;
const MAX_PREVIEW_CHARS = 400000;

function attachmentIndex() {
  const map = Object.create(null);
  for (const doc of statements.allDocs.all()) {
    if (!doc?.file_path || !fs.existsSync(doc.file_path)) continue;
    const base = path.basename(String(doc.filename || '')).toLowerCase();
    if (base) map[base] = doc.id;
    // Chat exports often use "TITLE - 00003962-STICKER-....webp"
    const m = base.match(/(\d{5,}-sticker-[a-z0-9._-]+\.(?:webp|png|jpe?g|gif))$/i);
    if (m) map[m[1].toLowerCase()] = doc.id;
  }
  return map;
}

function collectAttachmentNames(text, messages) {
  const names = new Set();
  const re = /\[([^\]]*)\]\(attachment:\/\/([^)\s]+)\)/gi;
  const scan = (src) => {
    const s = String(src || '');
    let match;
    while ((match = re.exec(s))) {
      const name = path.basename(String(match[2] || '').trim());
      if (name) names.add(name);
    }
  };
  scan(text);
  for (const msg of messages || []) scan(msg?.text);
  return [...names];
}

function documentPreview(doc) {
  const type = String(doc.type || '').toLowerCase();
  const onDisk = !!(doc.file_path && fs.existsSync(doc.file_path));

  // Stickers / images: show the media itself, not OCR / chunk text
  if ((type === 'sticker' || type === 'image') && onDisk) {
    return {
      id: doc.id,
      title: doc.title || doc.filename,
      filename: doc.filename,
      type: doc.type,
      kind: type === 'sticker' ? 'sticker' : 'image',
      messages: [],
      text: '',
      truncated: false,
      mediaUrl: `/api/documents/${doc.id}/file`,
      attachments: {},
    };
  }

  const chunks = statements.allChunksByDoc.all(doc.id);
  let text = chunks.map((chunk) => chunk.content).join('\n');
  if (doc.type === 'text' && doc.file_path && fs.existsSync(doc.file_path)) {
    try {
      text = readChatText(doc.file_path);
    } catch {
      /* keep chunk text */
    }
  }

  const truncated = text.length > MAX_PREVIEW_CHARS;
  if (truncated) text = text.slice(0, MAX_PREVIEW_CHARS);

  const parsed = parseChatTranscript(text);
  const chat = looksLikeChat(doc.filename, doc.title, parsed);
  const messages = chat ? parsed.slice(0, MAX_PREVIEW_MESSAGES) : [];

  const index = attachmentIndex();
  const attachments = {};
  for (const name of collectAttachmentNames(text, messages)) {
    const id = index[name.toLowerCase()] || index[path.basename(name).toLowerCase()];
    if (id) attachments[name] = id;
  }

  return {
    id: doc.id,
    title: doc.title || doc.filename,
    filename: doc.filename,
    type: doc.type,
    kind: chat ? 'chat' : doc.type || 'text',
    messages,
    text: chat ? '' : text,
    truncated: truncated || messages.length < parsed.length,
    mediaUrl: '',
    attachments,
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
    privateChats: getPrivateChats(),
    dailyDigest: getDailyDigest(),
    deadlineReminders: getDeadlineReminders(),
    meetingSummaries: getMeetingSummaries(),
    repeatNudge: getRepeatNudge(),
    showSources: getShowSources(),
    lemonfoxVoice: getLemonfoxVoice(),
    lemonfoxVoices: listLemonfoxVoices(),
  };
}

function createAdminRouter() {
  const router = express.Router();

  router.get('/api/stats', (_req, res) => {
    res.json(liveStats());
  });

  router.get('/api/whatsapp', (_req, res) => {
    const { connected, hasQr, phone, pairing } = getPairingState();
    res.json({ connected, hasQr, phone: phone || '', pairing: Boolean(pairing) });
  });

  router.post('/api/whatsapp/re-pair', async (_req, res) => {
    try {
      const { connected, hasQr, phone, pairing } = await rePairWhatsApp();
      res.json({ connected, hasQr, phone: phone || '', pairing: Boolean(pairing) });
    } catch (err) {
      console.error('[admin] re-pair failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Could not start pairing' });
    }
  });

  router.get('/whatsapp-qr.png', async (_req, res) => {
    const { qr } = getPairingState();
    if (!qr) {
      res.status(404).type('text').send('No QR yet');
      return;
    }
    try {
      const buf = await QRCode.toBuffer(qr, {
        type: 'png',
        width: 560,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#12151a', light: '#ffffff' },
      });
      res.set('Cache-Control', 'no-store');
      res.type('png').send(buf);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not draw QR' });
    }
  });

  router.get('/api/documents', (_req, res) => {
    res.json(statements.allKnowledgeDocs.all().filter(isKnowledgeListDoc).map(publicDoc));
  });

  router.get('/api/stickers', (_req, res) => {
    try {
      syncStickersLibrary();
    } catch (err) {
      console.warn('[admin] sticker sync:', err.message || err);
    }
    res.json(statements.allStickers.all().map(publicDoc));
  });

  router.post('/api/stickers/sync', (_req, res) => {
    try {
      const result = syncStickersLibrary();
      res.json({
        ...result,
        stickers: statements.allStickers.all().map(publicDoc),
      });
    } catch (err) {
      console.error('[admin] sticker sync failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Sync failed' });
    }
  });

  router.post('/api/stickers', upload.array('file', 40), async (req, res) => {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'No sticker files selected' });
    }

    const packTitle = sanitizeTitle(req.body?.title) || 'Stickers';
    const multi = files.length > 1;
    const added = [];
    const errors = [];

    try {
      for (const file of files) {
        const displayName = sanitizeDisplayName(file.originalname) || 'sticker.webp';
        const stem = displayName.replace(/\.[^.]+$/, '') || displayName;
        const label = multi ? `${packTitle} - ${stem}`.slice(0, 120) : sanitizeTitle(req.body?.title) || stem;
        try {
          added.push(await ingestSticker(file.path, displayName, label));
        } catch (err) {
          console.error('[admin] sticker ingest failed:', err.message || err);
          errors.push({ filename: file.originalname, error: err.message || 'Ingest failed' });
        } finally {
          unlinkQuiet(file.path);
        }
      }
      if (!added.length) {
        return res.status(400).json({
          error: errors[0]?.error || 'Could not add any stickers.',
          errors,
        });
      }
      res.json({
        added: added.map((item) => ({
          id: item.id,
          filename: item.filename,
          title: item.title,
          type: 'sticker',
          chunkCount: 0,
        })),
        errors: errors.length ? errors : undefined,
      });
    } catch (err) {
      for (const file of files) unlinkQuiet(file.path);
      console.error('[admin] sticker upload failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Upload failed' });
    }
  });

  router.get('/api/qa', (_req, res) => {
    res.json(statements.recentQA.all(50));
  });

  // ── Feedback / self-learning ───────────────────────────────────────────────
  router.post('/api/qa/:id/feedback', express.json(), async (req, res) => {
    const { learnFromQA } = require('../ai/selflearn');
    const id = Number(req.params.id);
    const { feedback, correction } = req.body || {};
    if (!['good', 'bad', 'corrected'].includes(feedback)) {
      return res.status(400).json({ error: 'feedback must be good | bad | corrected' });
    }
    const db = require('../db/index');
    try {
      if (feedback === 'good' || feedback === 'corrected') {
        const result = await learnFromQA(id, correction || undefined);
        return res.json(result);
      }
      // 'bad' — just mark it, don't embed
      db.prepare(`UPDATE qa_history SET feedback = 'bad' WHERE id = ?`).run(id);
      return res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sentiment & insights analytics ────────────────────────────────────────
  router.get('/api/analytics/sentiment', (_req, res) => {
    const db = require('../db/index');
    try {
      const counts = db.prepare(`
        SELECT COALESCE(sentiment,'neutral') AS sentiment, COUNT(*) AS c
        FROM qa_history GROUP BY 1
      `).all();

      const confused = db.prepare(`
        SELECT question, group_name, created_at FROM qa_history
        WHERE sentiment = 'confused'
        ORDER BY created_at DESC LIMIT 20
      `).all();

      const topQuestions = db.prepare(`
        SELECT question, COUNT(*) AS c, GROUP_CONCAT(DISTINCT group_name) AS groups
        FROM qa_history
        GROUP BY LOWER(TRIM(question))
        ORDER BY c DESC LIMIT 20
      `).all();

      const feedbackStats = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN feedback='good' THEN 1 ELSE 0 END) AS good,
          SUM(CASE WHEN feedback='bad' THEN 1 ELSE 0 END) AS bad,
          SUM(CASE WHEN feedback='corrected' THEN 1 ELSE 0 END) AS corrected,
          SUM(CASE WHEN learned=1 THEN 1 ELSE 0 END) AS learned
        FROM qa_history
      `).get();

      res.json({ counts, confused, topQuestions, feedbackStats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/analytics', (_req, res) => {
    try {
      res.json(buildAnalytics());
    } catch (err) {
      console.error('[admin] analytics failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Could not build analytics' });
    }
  });

  // ---- Dev / Control panel ----

  // Live system status + all tuning knobs, for the Control tab.
  router.get('/api/control', (_req, res) => {
    try {
      const wa = getPairingState();
      res.json({
        provider: providerName(),
        chatModel: CHAT_MODEL(),
        embeddingModel: EMBEDDING_MODEL(),
        whatsapp: { connected: wa.connected, phone: wa.phone || '' },
        botMode: getBotMode(),
        counts: {
          documents: db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE type != 'sticker'`).get().c,
          chunks: db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get().c,
          qa: db.prepare(`SELECT COUNT(*) AS c FROM qa_history`).get().c,
          messages: db.prepare(`SELECT COUNT(*) AS c FROM chat_messages`).get().c,
        },
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        tuning: getTuning(),
      });
    } catch (err) {
      console.error('[admin] control status failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Could not read control status' });
    }
  });

  // Update one answer-tuning value live (no restart).
  router.post('/api/tuning', express.json(), (req, res) => {
    const key = String(req.body?.key || '').trim();
    try {
      const value = setTuning(key, req.body?.value);
      res.json({ key, value });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not update setting' });
    }
  });

  // Danger zone: wipe all Q&A history (answers + their embeddings). Keeps
  // documents/knowledge. Useful when testing or clearing a bad training set.
  router.post('/api/maintenance/clear-qa', (_req, res) => {
    try {
      const before = db.prepare(`SELECT COUNT(*) AS c FROM qa_history`).get().c;
      db.prepare(`DELETE FROM qa_history`).run();
      res.json({ ok: true, deleted: before });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not clear history' });
    }
  });

  // Danger zone: recompute embeddings for every stored chunk (e.g. after
  // switching embedding provider/model). Runs in the background; returns
  // immediately with the count queued.
  router.post('/api/maintenance/rebuild-embeddings', async (_req, res) => {
    try {
      const rows = db.prepare(`SELECT id, content FROM chunks ORDER BY id ASC`).all();
      res.json({ ok: true, queued: rows.length });
      // Rebuild after responding so the request does not hang.
      setImmediate(async () => {
        try {
          const BATCH = 50;
          for (let i = 0; i < rows.length; i += BATCH) {
            const slice = rows.slice(i, i + BATCH);
            const vecs = await getEmbeddingsBatch(slice.map((r) => r.content));
            const upd = db.prepare(`UPDATE chunks SET embedding = ? WHERE id = ?`);
            slice.forEach((r, j) => upd.run(JSON.stringify(vecs[j]), r.id));
          }
          const { invalidateChunkCache } = require('../db/queries');
          invalidateChunkCache();
          console.log(`[admin] rebuilt embeddings for ${rows.length} chunk(s)`);
        } catch (err) {
          console.error('[admin] rebuild embeddings failed:', err.message || err);
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not start rebuild' });
    }
  });

  router.post('/api/bot-mode', express.json(), (req, res) => {
    const mode = req.body?.mode === 'off' ? 'off' : 'auto';
    statements.setSetting.run('bot_mode', mode);
    process.env.BOT_MODE = mode;
    res.json({ botMode: mode });
  });

  router.post('/api/private-chats', express.json(), (req, res) => {
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 'off';
    res.json({ privateChats: setPrivateChats(enabled) });
  });

  router.post('/api/daily-digest', express.json(), (req, res) => {
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 'off';
    const dailyDigest = setDailyDigest(enabled);
    scheduleNextDigest();
    res.json({ dailyDigest });
  });

  router.post('/api/daily-digest/run', async (_req, res) => {
    try {
      const result = await runDailyDigest({ force: true });
      if (!result.ok && result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error('[admin] digest run failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Could not send digest' });
    }
  });

  router.post('/api/deadline-reminders', express.json(), (req, res) => {
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 'off';
    const deadlineReminders = setDeadlineReminders(enabled);
    restartDeadlineReminders();
    if (enabled) {
      refreshUpcoming().catch((err) =>
        console.warn('[reminders] refresh after toggle failed:', err.message || err)
      );
    }
    res.json({ deadlineReminders });
  });

  router.post('/api/meeting-summaries', express.json(), (req, res) => {
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 'off';
    res.json({ meetingSummaries: setMeetingSummaries(enabled) });
  });

  router.post('/api/repeat-nudge', express.json(), (req, res) => {
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 'off';
    res.json({ repeatNudge: setRepeatNudge(enabled) });
  });

  router.post('/api/show-sources', express.json(), (req, res) => {
    const enabled = req.body?.enabled !== false && req.body?.enabled !== 'off';
    res.json({ showSources: setShowSources(enabled) });
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

  async function ingestUploadedFile(file, title, { multi = false } = {}) {
    const { original, type } = resolveUploadType(file);
    const displayName = sanitizeDisplayName(original) || original || 'chat.txt';
    if (!type) {
      unlinkQuiet(file.path);
      throw new Error(
        `Unsupported file type: ${displayName}. Upload a WhatsApp .txt/.zip export, PDF, image, Word/Excel/PowerPoint, or audio.`
      );
    }

    const stem = displayName.replace(/\.[^.]+$/, '') || displayName;
    const label =
      multi && title
        ? `${title} - ${stem}`.slice(0, 120)
        : title;

    let ingestPath = file.path;
    let ingestName = displayName;
    let ingestType = type;
    let cleanup = '';
    let mediaFiles = [];
    try {
      if (type === 'zip') {
        const opened = openChatExport(file.path, displayName);
        ingestPath = opened.path;
        ingestName = path.basename(opened.path) || '_chat.txt';
        ingestType = 'text';
        cleanup = opened.cleanup;
        mediaFiles = opened.media || [];
      }
      const result = await ingestFile(ingestPath, ingestName, ingestType, label);
      const extras = [];
      for (const mediaPath of mediaFiles) {
        const mediaName = path.basename(mediaPath);
        const mediaType = detectType(mediaName, '');
        if (!mediaType || mediaType === 'zip' || mediaType === 'text') continue;
        try {
          extras.push(
            await ingestFile(
              mediaPath,
              mediaName,
              mediaType,
              `${label} - ${mediaName}`.slice(0, 120)
            )
          );
        } catch (err) {
          console.warn(`[admin] skip export media ${mediaName}:`, err.message || err);
        }
      }
      return { ...result, extras };
    } finally {
      unlinkQuiet(file.path);
      if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
    }
  }

  router.post('/api/upload', upload.array('file', 40), async (req, res) => {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const title = sanitizeTitle(req.body?.title);
    if (!title) {
      for (const file of files) unlinkQuiet(file.path);
      return res.status(400).json({ error: 'Give the file a short name, like Meeting notes or Group chat.' });
    }

    const multi = files.length > 1;
    const added = [];
    const errors = [];
    try {
      for (const file of files) {
        try {
          added.push(await ingestUploadedFile(file, title, { multi }));
        } catch (err) {
          console.error('[admin] ingest failed:', err.message || err);
          errors.push({ filename: file.originalname, error: err.message || 'Ingest failed' });
        }
      }
      if (!added.length) {
        return res.status(400).json({
          error: errors[0]?.error || 'Could not add any files.',
          errors,
        });
      }
      const primary = added[0];
      res.json({
        ...primary,
        added,
        errors: errors.length ? errors : undefined,
      });
    } catch (err) {
      console.error('[admin] upload failed:', err.message || err);
      res.status(500).json({ error: err.message || 'Ingest failed' });
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
      return res.status(400).json({
        error: 'Unsupported file type. Upload a WhatsApp .txt/.zip export, PDF, image, Word/Excel/PowerPoint, or audio.',
      });
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

  router.get('/api/documents/:id/preview', (req, res) => {
    const id = Number(req.params.id);
    const doc = statements.getDoc.get(id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    try {
      res.json(documentPreview(doc));
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not open this file' });
    }
  });

  router.get('/api/documents/:id/file', (req, res) => {
    const id = Number(req.params.id);
    const doc = statements.getDoc.get(id);
    if (!doc?.file_path || !fs.existsSync(doc.file_path)) {
      return res.status(404).json({ error: 'Original file is not stored. Re-upload it.' });
    }
    const abs = path.resolve(doc.file_path);
    const mime = String(doc.mime_type || '').toLowerCase();
    const ext = path.extname(doc.filename || abs).toLowerCase();
    const inline =
      String(doc.type || '').toLowerCase() === 'sticker' ||
      String(doc.type || '').toLowerCase() === 'image' ||
      mime.startsWith('image/') ||
      /\.(webp|png|jpe?g|gif)$/i.test(ext);

    if (inline) {
      if (mime) res.type(mime);
      else if (ext === '.webp') res.type('image/webp');
      else if (ext === '.png') res.type('image/png');
      else if (ext === '.gif') res.type('image/gif');
      else if (ext === '.jpg' || ext === '.jpeg') res.type('image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.sendFile(abs);
    }

    const title = sanitizeTitle(doc.title);
    const downloadName = title
      ? path.extname(title)
        ? title
        : `${title}${ext}`
      : doc.filename;
    res.download(abs, downloadName);
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

  // ── Group mode (active / observer / disabled) ──────────────────────────────
  router.post('/api/groups/mode', express.json(), (req, res) => {
    const { jid, mode } = req.body || {};
    try {
      const modes = setGroupMode(jid, mode);
      res.json({ ok: true, modes });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/groups/modes', (_req, res) => {
    res.json(getGroupModes());
  });

  // ── Availability calendar ──────────────────────────────────────────────────
  router.get('/api/availability', (_req, res) => {
    const db = require('../db/index');
    const rows = db.prepare(`SELECT * FROM availability ORDER BY name, dow, start_h`).all();
    res.json(rows);
  });

  router.post('/api/availability', express.json(), (req, res) => {
    const { name, phone = '', dow, start_h, end_h, label = '' } = req.body || {};
    if (!name || dow === undefined || start_h === undefined || end_h === undefined) {
      return res.status(400).json({ error: 'name, dow, start_h, end_h are required' });
    }
    const db = require('../db/index');
    const result = db.prepare(
      `INSERT INTO availability (name, phone, dow, start_h, end_h, label) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(String(name).trim(), String(phone).trim(), Number(dow), Number(start_h), Number(end_h), String(label).trim());
    res.json({ ok: true, id: result.lastInsertRowid });
  });

  router.delete('/api/availability/:id', (req, res) => {
    const db = require('../db/index');
    db.prepare(`DELETE FROM availability WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAdminRouter };
