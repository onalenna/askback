const fs = require('fs');
const path = require('path');
const { statements } = require('../db/queries');
const { mentionJidList } = require('./mentions');

const SHARE_VERB =
  /\b(send|share|forward|attach|show|see|display|resend|re-send|envoie|envoyer|envoy[ée]e?s?|partage|partager|envía|envia|comparte|compartir|manda|mandar|invia|condividi|mostra|muéstr|muestra|montre)\b/i;

const SHARE_PHRASE =
  /\b((send|share|give|attach|show|see|get|display)\s+(me|us|the|that|this|it)|can you (send|share|attach|show|get)|please (send|share|attach|show)|envoie[- ]moi|partage[- ]moi|montre[- ]moi|m[' ]envoyer|m[' ]envoie|peux[- ]tu.{0,24}envoy|pouvez[- ]vous.{0,24}envoy|i need|i want|once more|one more time)\b/i;

const FILE_NOUN =
  /\b(file|files|pdf|document|documents|doc|docs|image|images|photo|photos|picture|pictures|pic|pics|media|medias|audio|recording|recordings|mp3|video|videos|slide|slides|ppt|pptx|presentation|attachment|attachments|screenshot|screenshots|sticker|stickers|guideline|guidelines|guide|guides|fichier|fichiers|archivo|archivos|documento|documentos|ficheiro|difaele|tokomane)\b|\.(pdf|mp3|wav|m4a|ogg|webm|mp4|docx?|xlsx?|pptx?|jpe?g|png|webp|gif)\b/i;

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'and',
  'please',
  'send',
  'share',
  'attach',
  'show',
  'see',
  'display',
  'file',
  'files',
  'document',
  'documents',
  'doc',
  'docs',
  'pdf',
  'audio',
  'media',
  'photo',
  'image',
  'me',
  'us',
  'this',
  'that',
  'give',
  'can',
  'you',
  'your',
  'our',
  'my',
  'original',
  'copy',
  'again',
  'same',
  'whatsapp',
  'chat',
  'unipods',
  'meti',
  'program',
  'programme',
  'cohort',
  '2026',
  '2025',
  '2024',
]);

/** Last files shared per chat — used for "send it again" without a text caption. */
const lastSharedByChat = new Map();
/** chatJid:path → last send time — blocks accidental double attach. */
const recentlySentAt = new Map();
const SHARE_COOLDOWN_MS = 12_000;
const inFlightShare = new Set();

function fileKey(file) {
  try {
    if (file?.path && fs.existsSync(file.path)) return fs.realpathSync(file.path);
  } catch {
    /* fall through */
  }
  return String(file?.path || file?.fileName || '')
    .toLowerCase()
    .trim();
}

function wantsMultipleFiles(text) {
  const t = String(text || '').toLowerCase();
  return /\b(all|both|every|these|those)\b/.test(t) || /\b(files|documents|photos|images|pdfs)\b/.test(t);
}

function dedupeShareFiles(files) {
  const out = [];
  const seen = new Set();
  for (const file of files || []) {
    const key = fileKey(file);
    const nameKey = String(file?.fileName || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!key && !nameKey) continue;
    if (key && seen.has(`p:${key}`)) continue;
    if (nameKey && seen.has(`n:${nameKey}`)) continue;
    if (key) seen.add(`p:${key}`);
    if (nameKey) seen.add(`n:${nameKey}`);
    out.push(file);
  }
  return out;
}

function wasJustSent(chatJid, file) {
  const key = `${chatJid}:${fileKey(file)}`;
  const at = recentlySentAt.get(key);
  return Boolean(at && Date.now() - at < SHARE_COOLDOWN_MS);
}

function markJustSent(chatJid, file) {
  recentlySentAt.set(`${chatJid}:${fileKey(file)}`, Date.now());
}

function isShareRequest(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  // Prefer the human ask when OCR / quoted-document text is appended
  const ask = t.split(/\n\n(?:Quoted document:|Document \()/i)[0].trim() || t;
  if ((SHARE_VERB.test(ask) || SHARE_PHRASE.test(ask)) && FILE_NOUN.test(ask)) return true;
  if ((SHARE_VERB.test(t) || SHARE_PHRASE.test(t)) && FILE_NOUN.test(t)) return true;
  if (/\battach(ed|ment|ments)?\b/i.test(ask) && FILE_NOUN.test(ask)) return true;
  if (
    /\b(where('?s| is)|got|have|need|want|looking for|show me|get me|see the|look at)\b/i.test(ask) &&
    FILE_NOUN.test(ask)
  ) {
    return true;
  }
  if (
    /\b(again|once more|one more|resend|re-send|same (one|file|photo|image|media|doc|document|pdf))\b/i.test(
      ask
    ) &&
    (FILE_NOUN.test(ask) || /\b(it|that|this|same)\b/i.test(ask))
  ) {
    return true;
  }
  // "not this / wrong file — send the guidelines" while quoting something else
  if (
    /\b(not this|wrong (one|file|doc|document|pdf)|other (one|file|doc|document)|instead)\b/i.test(ask) &&
    FILE_NOUN.test(ask)
  ) {
    return true;
  }
  if (
    /\b(guidelines?|guide|hackathon)\b/i.test(ask) &&
    /\b(document|pdf|file|doc|send|share|attach|not this|wrong)\b/i.test(ask)
  ) {
    return true;
  }
  return false;
}

/** Human ask text without pasted OCR / quoted-document dump. */
function shareAskText(text) {
  return String(text || '')
    .split(/\n\n(?:Quoted document:|Document \()/i)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function isShareFollowUp(text, chatHistory = [], chatJid = '') {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const hadShare =
    (chatJid && lastSharedByChat.has(chatJid)) ||
    (chatHistory || []).some(
      (line) =>
        line?.fromMe &&
        /^(here'?s |here are the files|voici |aquí est|aqui est|ecco )/i.test(String(line.text || ''))
    );
  if (!hadShare) return false;
  if (isShareRequest(t)) return true;
  return /\b(again|same|resend|re-send|once more|one more|that (one|file|photo|media)|send it|show it|share it)\b/i.test(
    t
  );
}

function isKnowledgeOnly(doc) {
  const type = String(doc?.type || '').toLowerCase();
  const name = String(doc?.filename || '').toLowerCase();
  const title = String(doc?.title || '').toLowerCase();
  if (type === 'text') return true;
  if (name.endsWith('.txt') || name.endsWith('.text')) return true;
  if (name === '_chat.txt' || name.includes('whatsapp chat') || title.includes('_chat.txt')) return true;
  return false;
}

function mimeFor(filename, type) {
  const ext = path.extname(filename || '').toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  if (map[ext]) return map[ext];
  if (type === 'pdf') return 'application/pdf';
  if (type === 'image') return 'image/jpeg';
  if (type === 'audio') return 'audio/mpeg';
  return 'application/octet-stream';
}

function sendKind(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  const name = String(file?.fileName || file?.path || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (type === 'sticker' || /sticker/i.test(name)) return 'sticker';
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(name)) return 'image';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|opus)$/i.test(name)) return 'audio';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(name)) return 'video';
  return 'document';
}

function words(s) {
  return (
    String(s || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  );
}

/** Prefer the real media name after a chat-export prefix. */
function shortLabel(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const base = path.basename(raw);
  const cleaned = base
    .replace(/^whatsapp\s+chat[^-]*-\s*/i, '')
    .replace(/^\d{5,}-/, '')
    .trim();
  return cleaned || base;
}

function displayFileName(doc) {
  const ext = path.extname(doc.filename || '') || path.extname(doc.title || '');
  const fromFile = shortLabel(doc.filename || '');
  const fromTitle = shortLabel(doc.title || '');
  // Prefer the concrete media filename over a long chat-export title
  if (fromFile && !/^whatsapp chat/i.test(fromFile)) {
    return path.extname(fromFile) ? fromFile : `${fromFile}${ext}`;
  }
  if (fromTitle) {
    return path.extname(fromTitle) ? fromTitle : `${fromTitle}${ext}`;
  }
  return doc.filename || 'file';
}

function searchableName(doc) {
  return `${shortLabel(doc.title || '')} ${shortLabel(doc.filename || '')} ${doc.filename || ''}`.toLowerCase();
}

function toShareable(doc) {
  if (!doc?.file_path || !fs.existsSync(doc.file_path)) return null;
  if (isKnowledgeOnly(doc)) return null;
  return {
    path: doc.file_path,
    fileName: displayFileName(doc),
    mimetype: doc.mime_type || mimeFor(doc.filename, doc.type),
    type: doc.type || '',
    searchName: searchableName(doc),
    id: doc.id,
  };
}

function docsFromIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  return unique.map((id) => toShareable(statements.getDoc.get(id))).filter(Boolean);
}

function wantsMediaKind(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(sticker|stickers)\b/.test(t)) return 'sticker';
  if (/\b(photo|photos|image|images|pic|pics|picture|pictures|screenshot)\b/.test(t)) return 'image';
  if (/\b(media|medias)\b/.test(t) && !/\b(document|pdf|file|guide|guideline)\b/.test(t)) return 'image';
  if (/\b(audio|recording|recordings|mp3|voice note)\b/.test(t)) return 'audio';
  if (/\b(video|videos|mp4)\b/.test(t)) return 'video';
  if (
    /\b(pdf|document|documents|doc|docs|file|files|slide|slides|ppt|pptx|guide|guides|guideline|guidelines)\b/.test(
      t
    )
  ) {
    return 'document';
  }
  return '';
}

function matchesKind(file, kind) {
  if (!kind) return true;
  const actual = sendKind(file);
  if (kind === 'sticker') return actual === 'sticker' || actual === 'image';
  if (kind === 'image') return actual === 'image' || actual === 'sticker';
  if (kind === 'audio') return actual === 'audio';
  if (kind === 'video') return actual === 'video';
  if (kind === 'document') return actual === 'document';
  return true;
}

function normalizeToken(w) {
  let t = String(w || '').toLowerCase();
  if (t.endsWith('lines') && t.length > 6) t = t.slice(0, -1); // guidelines -> guideline
  if (t.endsWith('s') && t.length > 4) t = t.slice(0, -1);
  // common OCR/title typos
  if (t === 'guidline' || t === 'guidelin') t = 'guideline';
  return t;
}

function queryKeys(text) {
  return words(text)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(normalizeToken)
    .filter(Boolean);
}

function scoreFile(file, text) {
  const keys = queryKeys(text);
  if (!keys.length) return 0;
  const blob = normalizeToken(String(file.searchName || file.fileName || '').replace(/[^a-z0-9]+/gi, ' '));
  const blobTokens = new Set(words(blob).map(normalizeToken));
  let score = 0;
  for (const key of keys) {
    if (blobTokens.has(key)) score += 3;
    else if (blob.includes(key)) score += 2;
    else {
      // soft prefix match for typos (guidelines ~ guidlines)
      for (const tok of blobTokens) {
        if (tok.length >= 5 && key.length >= 5 && (tok.startsWith(key.slice(0, 5)) || key.startsWith(tok.slice(0, 5)))) {
          score += 2;
          break;
        }
      }
    }
  }
  // Prefer PDFs / real docs when the ask sounds like a document
  const kind = wantsMediaKind(text);
  const actual = sendKind(file);
  if (kind === 'document' && actual === 'document') score += 2;
  if (kind === 'document' && /\.pdf$/i.test(file.fileName || '')) score += 2;
  if (kind === 'document' && (actual === 'image' || actual === 'sticker')) score -= 8;
  if (/sticker/i.test(file.fileName || '') && kind === 'document') score -= 10;
  return score;
}

function rankFiles(files, text) {
  return (files || [])
    .map((file) => ({ file, score: scoreFile(file, text) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}

function bestMatches(files, text, { max = 1, minScore = 2 } = {}) {
  const ranked = rankFiles(files, text).filter((row) => row.score >= minScore);
  if (!ranked.length) return [];
  const top = ranked[0].score;
  // Only keep near-ties with the best score (avoid dumping 5 unrelated files)
  const close = ranked.filter((row) => row.score >= top - 1).slice(0, max);
  return close.map((row) => row.file);
}

function allShareableDocs() {
  return statements.allDocs
    .all()
    .filter((doc) => String(doc.type || '').toLowerCase() !== 'sticker')
    .map(toShareable)
    .filter(Boolean);
}

function allStickerDocs() {
  return statements.allStickers.all().map(toShareable).filter(Boolean);
}

function pickFilesToShare(
  text,
  { knowledge = [], repeated = [], wantsShare = false, chatHistory = [], chatJid = '' } = {}
) {
  if (!wantsShare) return [];

  const ask = shareAskText(text) || String(text || '');
  const kind = wantsMediaKind(ask);
  const pool =
    kind === 'sticker'
      ? allStickerDocs().concat(
          allShareableDocs().filter((file) => sendKind(file) === 'sticker' || sendKind(file) === 'image')
        )
      : allShareableDocs().filter((file) => matchesKind(file, kind || ''));
  const maxFiles = wantsMultipleFiles(ask) ? 3 : 1;

  // 1) Best name match across all docs of the right kind
  const named = bestMatches(pool, ask, { max: maxFiles, minScore: 2 });
  if (named.length) return dedupeShareFiles(named).slice(0, maxFiles);

  // 2) Knowledge search hits
  const fromKnowledge = bestMatches(
    docsFromIds(knowledge.map((k) => k.document_id)).filter((file) => matchesKind(file, kind || '')),
    ask,
    { max: maxFiles, minScore: 1 }
  );
  if (fromKnowledge.length) return dedupeShareFiles(fromKnowledge).slice(0, maxFiles);

  if (repeated[0]?.document_id) {
    const fromRepeat = docsFromIds([repeated[0].document_id]).filter((file) =>
      matchesKind(file, kind || '')
    );
    if (fromRepeat.length) return dedupeShareFiles(fromRepeat).slice(0, 1);
  }

  // 3) Re-ask: last files we actually shared in this chat
  if (chatJid && lastSharedByChat.has(chatJid)) {
    const prior = lastSharedByChat.get(chatJid) || [];
    if (prior.length) return dedupeShareFiles(prior).slice(0, 1);
  }

  // 4) Soft fallback only when the ask has distinctive words
  const keys = queryKeys(ask);
  if (keys.length && kind) {
    const soft = bestMatches(pool, ask, { max: 1, minScore: 2 });
    if (soft.length) return dedupeShareFiles(soft).slice(0, 1);
  }

  // 5) Bare "show the document/pdf" with no name — only if exactly one doc of that kind
  if (kind === 'document' || kind === 'pdf') {
    const docsOnly = pool.filter((f) => sendKind(f) === 'document');
    if (docsOnly.length === 1) return docsOnly;
  }

  // 6) Last resort: distinctive keywords against all shareable docs (any kind)
  if (keys.length >= 1) {
    const any = bestMatches(allShareableDocs(), ask, { max: 1, minScore: 2 });
    if (any.length) return dedupeShareFiles(any).slice(0, 1);
  }

  return [];
}

function rememberShared(chatJid, files) {
  if (!chatJid || !files?.length) return;
  lastSharedByChat.set(
    chatJid,
    files.map((f) => ({
      path: f.path,
      fileName: f.fileName,
      mimetype: f.mimetype,
      type: f.type,
      searchName: f.searchName || f.fileName,
    }))
  );
}

async function sendSharedFiles(sock, chatJid, files, quoted, mentions, { force = false } = {}) {
  const mentionIds = mentionJidList(mentions, sock, chatJid);
  const unique = dedupeShareFiles(files);
  if (!unique.length) return [];

  const lockKey = String(chatJid || '');
  if (lockKey && inFlightShare.has(lockKey)) {
    console.log('[whatsapp] skip share — already sending media in this chat');
    return [];
  }
  if (lockKey) inFlightShare.add(lockKey);

  const sent = [];
  try {
    for (const file of unique) {
      if (!file?.path || !fs.existsSync(file.path)) {
        console.warn(`[whatsapp] missing file to share: ${file?.fileName || file?.path}`);
        continue;
      }
      if (!force && chatJid && wasJustSent(chatJid, file)) {
        console.log(`[whatsapp] skip duplicate attach: ${file.fileName || file.path}`);
        continue;
      }
      const bytes = fs.readFileSync(file.path);
      const kind = sendKind(file);
      const niceName = shortLabel(file.fileName) || file.fileName;
      let payload;
      if (kind === 'sticker') {
        payload = { sticker: bytes };
      } else if (kind === 'image') {
        payload = {
          image: bytes,
          mimetype: file.mimetype || 'image/jpeg',
        };
      } else if (kind === 'audio') {
        payload = {
          audio: bytes,
          mimetype: file.mimetype || 'audio/mpeg',
          ptt: false,
          fileName: niceName,
        };
      } else if (kind === 'video') {
        payload = {
          video: bytes,
          mimetype: file.mimetype || 'video/mp4',
          fileName: niceName,
        };
      } else {
        payload = {
          document: bytes,
          mimetype: file.mimetype || 'application/octet-stream',
          fileName: niceName,
        };
      }
      if (mentionIds.length) payload.mentions = mentionIds;
      await sock.sendMessage(chatJid, payload, quoted ? { quoted } : undefined);
      markJustSent(chatJid, file);
      sent.push(file);
    }
    if (sent.length) rememberShared(chatJid, sent);
    return sent;
  } finally {
    if (lockKey) inFlightShare.delete(lockKey);
  }
}

module.exports = {
  isShareRequest,
  isShareFollowUp,
  isKnowledgeOnly,
  mimeFor,
  pickFilesToShare,
  sendSharedFiles,
  rememberShared,
  dedupeShareFiles,
  toShareable,
  sendKind,
  shortLabel,
  scoreFile,
  shareAskText,
};
