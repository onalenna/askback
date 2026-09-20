const fs = require('fs');
const path = require('path');
const { openai, CHAT_MODEL_MINI } = require('../ai/embeddings');
const { statements } = require('../db/queries');
const { stickerTitleFromFilename } = require('./library');

const MODEL = CHAT_MODEL_MINI;
const MAX_BYTES = 6 * 1024 * 1024;
const META_PREFIX = 'STICKER_META_V1';
const VALID_MOODS = new Set([
  'thanks',
  'love',
  'laugh',
  'hi',
  'bye',
  'hype',
  'yes',
  'no',
  'confused',
  'shock',
  'sleepy',
  'awkward',
  'support',
  'reject',
  'chill',
  'cute',
]);

const memory = new Map(); // docId → understanding
let queue = Promise.resolve();
let running = false;

/** Filenames that must never be treated as playful/safe, even if vision misfires. */
const HARD_UNSAFE =
  /\b(sex|porn|nude|nsfw|cyberbull|prisoner|bomb|autism|kill|dies|rape)\b/i;

function applyFilenameSafety(doc, understanding) {
  if (!understanding) return understanding;
  const name = `${doc.filename || ''} ${doc.title || ''}`;
  if (HARD_UNSAFE.test(name)) {
    understanding.safe = false;
    if (['warm', 'funny', 'neutral', 'cute'].includes(understanding.tone)) {
      understanding.tone = 'nsfw';
    }
  }
  return understanding;
}

async function withRetries(fn, { tries = 4, baseMs = 700 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || '');
      const retryable = /\b429\b|rate limit|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!retryable || i === tries - 1) throw err;
      const wait = baseMs * 2 ** i + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function fileKey(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return '';
  }
}

function mimeOf(doc) {
  const mime = String(doc.mime_type || '').split(';')[0].trim();
  if (mime) return mime;
  const ext = path.extname(doc.filename || doc.file_path || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'image/webp';
}

function parseMetaContent(content) {
  const raw = String(content || '').trim();
  if (!raw.startsWith(META_PREFIX)) return null;
  const json = raw.slice(META_PREFIX.length).trim();
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;
    return normalizeUnderstanding(data);
  } catch {
    return null;
  }
}

function normalizeUnderstanding(data) {
  const moods = Array.isArray(data.moods)
    ? data.moods.map((m) => String(m || '').toLowerCase().trim()).filter((m) => VALID_MOODS.has(m))
    : [];
  const tags = Array.isArray(data.tags)
    ? [...new Set(data.tags.map((t) => String(t || '').toLowerCase().trim()).filter(Boolean))].slice(0, 24)
    : [];
  const text = String(data.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const description = String(data.description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
  const tone = String(data.tone || 'neutral').toLowerCase().trim();
  const safe = data.safe !== false && tone !== 'nsfw' && tone !== 'rude';
  return {
    moods,
    tags,
    text,
    description,
    tone: ['warm', 'funny', 'rude', 'nsfw', 'neutral', 'sad', 'shocked'].includes(tone) ? tone : 'neutral',
    safe,
    fileKey: String(data.fileKey || ''),
  };
}

function serializeUnderstanding(u) {
  return `${META_PREFIX}\n${JSON.stringify({
    moods: u.moods,
    tags: u.tags,
    text: u.text,
    description: u.description,
    tone: u.tone,
    safe: u.safe,
    fileKey: u.fileKey,
  })}`;
}

function loadCached(doc) {
  const id = Number(doc.id);
  if (memory.has(id)) return memory.get(id);
  const rows = statements.allChunksByDoc.all(id);
  for (const row of rows) {
    const parsed = parseMetaContent(row.content);
    if (parsed) {
      const fixed = applyFilenameSafety(doc, parsed);
      memory.set(id, fixed);
      return fixed;
    }
  }
  return null;
}

function saveUnderstanding(docId, understanding) {
  statements.deleteChunksByDoc.run(docId);
  statements.insertChunk.run(docId, 0, serializeUnderstanding(understanding), null);
  statements.updateDocChunks.run(1, docId);
  memory.set(Number(docId), understanding);
}

async function describeStickerWithVision(doc) {
  const filePath = doc.file_path;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (!buffer.length) return null;
  if (buffer.length > MAX_BYTES) {
    console.warn(`[stickers] skip vision (too large): ${doc.filename}`);
    return null;
  }

  const title = doc.title || stickerTitleFromFilename(doc.filename);
  const mime = mimeOf(doc);
  const completion = await openai.chat.completions.create({
    model: MODEL(),
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You label WhatsApp stickers for a friendly group chat bot. Return JSON only. Be accurate about emotion and text on the sticker. Prefer safe, warm stickers for thanks/love/hi. Mark safe=false for sexual, violent, slur, or insulting stickers — including when the joke is dark or the filename looks innocent.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `Filename hint: ${doc.filename || ''}`,
              `Title hint: ${title}`,
              'Return JSON with keys:',
              'moods: array from [thanks,love,laugh,hi,bye,hype,yes,no,confused,shock,sleepy,awkward,support,reject,chill,cute] (pick 1-4 that truly fit)',
              'tags: 3-10 short lowercase tags (subject, action, emotion, meme vibe)',
              'text: any readable words on the sticker (empty string if none)',
              'description: one plain sentence of what it shows and the vibe',
              'tone: one of warm,funny,rude,nsfw,neutral,sad,shocked',
              'safe: boolean — false if sexual, violent, slur, or mean/insulting',
            ].join('\n'),
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` },
          },
        ],
      },
    ],
  });

  const raw = (completion.choices[0]?.message?.content || '').trim();
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  let understanding = normalizeUnderstanding(data);
  understanding.fileKey = fileKey(filePath);
  // Filename fallback moods if model returned none
  if (!understanding.moods.length) {
    const blob = `${title} ${doc.filename || ''}`.toLowerCase();
    for (const mood of VALID_MOODS) {
      if (blob.includes(mood)) understanding.moods.push(mood);
    }
  }
  understanding = applyFilenameSafety(doc, understanding);
  return understanding;
}

/**
 * Ensure a sticker has vision understanding cached. Returns understanding or null.
 */
async function ensureStickerUnderstood(doc, { force = false } = {}) {
  if (!doc?.id || !doc.file_path) return null;
  const key = fileKey(doc.file_path);
  const cached = loadCached(doc);
  if (!force && cached && cached.fileKey === key) return cached;

  try {
    const understanding = await withRetries(() => describeStickerWithVision(doc));
    if (!understanding) return cached;
    saveUnderstanding(doc.id, understanding);
    console.log(
      `[stickers] understood ${doc.filename}: moods=${understanding.moods.join(',') || '-'} safe=${understanding.safe}`
    );
    return understanding;
  } catch (err) {
    console.warn(`[stickers] understand failed (${doc.filename}):`, err.message || err);
    return cached;
  }
}

function getStickerUnderstanding(doc) {
  return loadCached(doc);
}

function understandingBlob(u) {
  if (!u) return '';
  return [u.description, u.text, ...(u.tags || []), ...(u.moods || [])].join(' ').toLowerCase();
}

/**
 * Background: understand every library sticker that lacks fresh meta.
 */
async function understandAllStickers({ concurrency = 1, force = false } = {}) {
  if (running) return { skipped: true };
  running = true;
  const stickers = statements.allStickers.all().filter((d) => d?.file_path && fs.existsSync(d.file_path));
  let done = 0;
  let understood = 0;
  let failed = 0;

  try {
    let i = 0;
    async function worker() {
      while (i < stickers.length) {
        const idx = i;
        i += 1;
        const doc = stickers[idx];
        const before = loadCached(doc);
        const key = fileKey(doc.file_path);
        if (!force && before && before.fileKey === key) {
          // Re-assert filename safety on already-cached labels
          const fixed = applyFilenameSafety(doc, { ...before });
          if (fixed && fixed.safe !== before.safe) saveUnderstanding(doc.id, fixed);
          done += 1;
          continue;
        }
        const result = await ensureStickerUnderstood(doc, { force });
        done += 1;
        if (result && (!before || before.fileKey !== key)) understood += 1;
        else if (!result) failed += 1;
        // Pace requests to stay under TPM limits
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
    await Promise.all(workers);
    console.log(
      `[stickers] understand pass done — ${understood} new/updated, ${failed} failed, ${done}/${stickers.length} checked`
    );
    return { total: stickers.length, understood, failed, done };
  } finally {
    running = false;
  }
}

/** Queue a single sticker (e.g. after upload) without blocking the request. */
function queueUnderstandSticker(doc) {
  if (!doc?.id) return;
  queue = queue
    .then(() => ensureStickerUnderstood(doc))
    .catch((err) => console.warn('[stickers] queued understand:', err.message || err));
}

function startStickerUnderstanding({ delayMs = 2500 } = {}) {
  setTimeout(() => {
    understandAllStickers({ concurrency: 1 })
      .then((result) => {
        if (result?.failed > 0) {
          console.log(`[stickers] retrying ${result.failed} failed label(s) in 20s…`);
          setTimeout(() => {
            understandAllStickers({ concurrency: 1 }).catch((err) => {
              console.warn('[stickers] retry understand:', err.message || err);
            });
          }, 20000);
        }
      })
      .catch((err) => {
        console.warn('[stickers] background understand:', err.message || err);
      });
  }, delayMs);
}

module.exports = {
  ensureStickerUnderstood,
  getStickerUnderstanding,
  understandingBlob,
  understandAllStickers,
  queueUnderstandSticker,
  startStickerUnderstanding,
  VALID_MOODS,
  META_PREFIX,
};
