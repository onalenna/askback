const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { statements } = require('../db/queries');
const { syncStickersLibrary, stickerTitleFromFilename } = require('./library');
const { getStickerUnderstanding, understandingBlob } = require('./understand');

const execFileAsync = promisify(execFile);

/** Mood → keywords that should appear in sticker title/filename/description */
const MOOD_KEYS = {
  thanks: [
    'friend',
    'love',
    'kiss',
    'homiekiss',
    'rose',
    'yay',
    'cute',
    'hi',
    'chill',
    'welcome',
    'you are welcome',
    'warm',
    'heart',
    'hug',
  ],
  love: ['friend', 'love', 'kiss', 'homiekiss', 'rose', 'cute', 'yay', 'heart', 'hug', 'blush'],
  laugh: ['lol', 'haha', 'crazy', 'yay', 'plink', 'goofy', 'hilarious', 'funny', 'laugh', 'cry laugh'],
  hi: ['hi', 'yay', 'friend', 'cute', 'wave', 'hello', 'welcome'],
  bye: ['bye', 'kiss', 'love', 'friend', 'wave', 'goodbye', 'later'],
  hype: ['yay', 'crazy', 'plink', 'bussin', 'dance', 'fire', 'peak', 'lets go', 'hype'],
};

/** Always skip these for playful replies, even before vision labels them. */
const HARD_BLOCK = /\b(sex|cyberbull|prisoner|bomb|autism)\b/i;
/** Soft-block filenames until vision confirms they are safe/warm. */
const SOFT_BLOCK = /\b(shit|dies|mad|nerd|screaming|wtf|smell|trappin)\b/i;

function ffmpegBin() {
  try {
    const bin = require('ffmpeg-static');
    return bin && fs.existsSync(bin) ? bin : '';
  } catch {
    return '';
  }
}

function playfulMood(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 120) return '';
  if (/\b(thank|thanks|ty|thx|merci|gracias|obrigad[oa]|grazie|dankie)\b/.test(t)) return 'thanks';
  if (/\b(bestie|bestiee|best friend|love you|luv you|ily|miss you|muah|xoxo|mwah)\b/.test(t)) {
    return 'love';
  }
  if (/\b(lol|lmao|haha|hehe|hilarious|funny)\b/.test(t)) return 'laugh';
  if (/^(hi|hii+|hello|hey|yo|sup|wassup|good morning|gm|good evening)\b/.test(t)) return 'hi';
  if (/^(bye|goodbye|see you|cya|later)\b/.test(t)) return 'bye';
  if (/\b(lets go|let'?s go|yay|woo+|nice one|well done|proud of you)\b/.test(t)) return 'hype';
  return '';
}

function isPlayfulStickerAsk(text) {
  return Boolean(playfulMood(text));
}

function stickerBlob(doc, understanding) {
  const base = `${doc.title || ''} ${stickerTitleFromFilename(doc.filename || '')} ${doc.filename || ''}`.toLowerCase();
  const extra = understandingBlob(understanding);
  return `${base} ${extra}`.trim();
}

function scoreSticker(doc, mood, keys) {
  const understanding = getStickerUnderstanding(doc);
  const nameBlob = `${doc.title || ''} ${doc.filename || ''}`.toLowerCase();
  if (HARD_BLOCK.test(nameBlob)) return -100;
  if (understanding && understanding.safe === false) return -100;
  if (SOFT_BLOCK.test(nameBlob) && !(understanding && understanding.safe)) return -100;

  const blob = stickerBlob(doc, understanding);
  let score = 0;

  if (understanding) {
    if (understanding.moods.includes(mood)) score += 14;
    // Related moods
    if (mood === 'thanks' && understanding.moods.some((m) => ['love', 'hi', 'cute', 'support'].includes(m))) {
      score += 6;
    }
    if (mood === 'love' && understanding.moods.some((m) => ['thanks', 'cute', 'hi'].includes(m))) {
      score += 5;
    }
    if (mood === 'laugh' && understanding.moods.some((m) => ['hype', 'cute'].includes(m))) {
      score += 4;
    }
    if (['rude', 'nsfw'].includes(understanding.tone)) score -= 40;
    if (understanding.tone === 'warm' || understanding.tone === 'funny') score += 2;

    for (const key of keys) {
      if (understanding.tags.some((t) => t.includes(key) || key.includes(t))) score += 3;
      if (understanding.description.toLowerCase().includes(key)) score += 2;
      if (understanding.text.toLowerCase().includes(key)) score += 4;
    }
  }

  for (const key of keys) {
    if (blob.includes(key)) score += key.length >= 5 ? 3 : 2;
  }

  return score;
}

function listReadyStickers() {
  try {
    syncStickersLibrary();
  } catch {
    /* folder may already be synced */
  }
  return statements.allStickers
    .all()
    .filter((doc) => doc?.file_path && fs.existsSync(doc.file_path) && String(doc.status) !== 'error');
}

/**
 * Pick a sticker for a playful moment. Returns null if none fit or chance says skip.
 */
function pickPlayfulSticker(text, { force = false, chance = 0.85 } = {}) {
  const mood = playfulMood(text);
  if (!mood) return null;
  if (!force && Math.random() > chance) return null;

  const keys = MOOD_KEYS[mood] || MOOD_KEYS.thanks;
  const stickers = listReadyStickers();
  if (!stickers.length) return null;

  const ranked = stickers
    .map((doc) => ({ doc, score: scoreSticker(doc, mood, keys), understanding: getStickerUnderstanding(doc) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  let pool = ranked.length ? ranked.slice(0, Math.min(8, ranked.length)) : [];
  if (!pool.length) {
    const softKeys = ['friend', 'cute', 'hi', 'yay', 'love', 'kiss', 'welcome', 'wave', 'heart'];
    const soft = stickers
      .map((doc) => ({ doc, score: scoreSticker(doc, mood, softKeys), understanding: getStickerUnderstanding(doc) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    if (!soft.length) return null;
    pool = soft;
  }

  // Prefer top scores; slight randomness among the best few
  const topScore = pool[0].score;
  const best = pool.filter((row) => row.score >= topScore - 4);
  const pick = best[Math.floor(Math.random() * best.length)];
  const understanding = pick.understanding;

  return {
    path: pick.doc.file_path,
    fileName: pick.doc.filename,
    mimetype: pick.doc.mime_type || 'image/webp',
    type: 'sticker',
    title: pick.doc.title || stickerTitleFromFilename(pick.doc.filename),
    mood,
    score: pick.score,
    why: understanding
      ? `${understanding.moods.join(',') || 'untagged'}: ${understanding.description || understanding.text || ''}`.slice(
          0,
          120
        )
      : 'filename',
  };
}

/** WhatsApp stickers need WebP (ideally ~512px). Raw PNG often shows as an empty bubble. */
async function toWhatsAppStickerWebp(filePath) {
  const bin = ffmpegBin();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askback-sticker-'));
  const input = path.join(dir, `in${path.extname(filePath) || '.png'}`);
  const output = path.join(dir, 'out.webp');
  try {
    fs.copyFileSync(filePath, input);
    await execFileAsync(
      bin,
      [
        '-y',
        '-i',
        input,
        '-vf',
        'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
        '-c:v',
        'libwebp',
        '-lossless',
        '0',
        '-q:v',
        '80',
        '-compression_level',
        '4',
        '-loop',
        '0',
        '-an',
        '-vsync',
        '0',
        output,
      ],
      { timeout: 20000 }
    );
    if (!fs.existsSync(output)) return null;
    const webp = fs.readFileSync(output);
    return webp.length ? webp : null;
  } catch (err) {
    console.warn('[stickers] webp convert failed:', err.message || err);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function sendPlayfulSticker(sock, chatJid, file, quoted, mentions = []) {
  if (!file?.path || !fs.existsSync(file.path)) return false;
  const ext = path.extname(file.fileName || file.path).toLowerCase();
  const { mentionJidList } = require('../whatsapp/mentions');
  const mentionIds = mentionJidList(mentions, sock, chatJid);
  const raw = fs.readFileSync(file.path);

  // Prefer a real WhatsApp sticker (webp). Fall back to a visible image.
  let webp = null;
  if (ext === '.webp') {
    webp = raw;
  } else if (ext !== '.gif') {
    webp = await toWhatsAppStickerWebp(file.path);
  }

  if (webp?.length) {
    try {
      const payload = { sticker: webp };
      if (mentionIds.length) payload.mentions = mentionIds;
      await sock.sendMessage(chatJid, payload, quoted ? { quoted } : undefined);
      return true;
    } catch (err) {
      console.warn('[stickers] webp sticker send failed:', err.message || err);
    }
  }

  try {
    const payload = {
      image: raw,
      mimetype:
        file.mimetype ||
        (ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png'),
    };
    if (mentionIds.length) payload.mentions = mentionIds;
    await sock.sendMessage(chatJid, payload, quoted ? { quoted } : undefined);
    return true;
  } catch (err) {
    console.error('[stickers] could not send playful sticker:', err.message || err);
    return false;
  }
}

module.exports = {
  playfulMood,
  isPlayfulStickerAsk,
  pickPlayfulSticker,
  sendPlayfulSticker,
  toWhatsAppStickerWebp,
};
