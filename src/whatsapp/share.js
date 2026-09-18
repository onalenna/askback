const fs = require('fs');
const path = require('path');
const { statements } = require('../db/queries');

const SHARE_RE =
  /\b(send|share|forward|attach|envoie|envoyer|partage|partager|envía|envia|comparte|compartir|manda|invia|condividi)\b|\b(give me|send me|can you send|please send|send us|share the|envoie[- ]moi|envoie nous|partage[- ]moi)\b/i;

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
  'file',
  'files',
  'document',
  'pdf',
  'audio',
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
]);

function isShareRequest(text) {
  return SHARE_RE.test(text || '');
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
  };
  return map[ext] || (type === 'pdf' ? 'application/pdf' : 'application/octet-stream');
}

function words(s) {
  return String(s || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

function displayFileName(doc) {
  const ext = path.extname(doc.filename || '');
  const title = String(doc.title || '').trim();
  if (!title) return doc.filename;
  return path.extname(title) ? title : `${title}${ext}`;
}

function toShareable(doc) {
  if (!doc?.file_path || !fs.existsSync(doc.file_path)) return null;
  return {
    path: doc.file_path,
    fileName: displayFileName(doc),
    mimetype: doc.mime_type || mimeFor(doc.filename, doc.type),
  };
}

function docsFromIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  return unique.map((id) => toShareable(statements.getDoc.get(id))).filter(Boolean);
}

function docMatchesQuery(doc, text) {
  const q = (text || '').toLowerCase();
  if (!q) return false;

  const title = String(doc.title || '').trim().toLowerCase();
  const filename = String(doc.filename || '').toLowerCase();
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');

  if (title.length >= 3 && q.includes(title)) return true;
  if (filename.length >= 3 && q.includes(filename)) return true;
  if (stem.length >= 3 && q.includes(stem)) return true;

  const titleWords = words(title || stem).filter((w) => w.length >= 3 && !STOP.has(w));
  if (!titleWords.length) return false;
  const hits = titleWords.filter((w) => q.includes(w));
  if (titleWords.length <= 2) return hits.length === titleWords.length;
  return hits.length >= Math.ceil(titleWords.length * 0.6);
}

function matchDocsByName(text) {
  return statements.allDocs
    .all()
    .filter((doc) => docMatchesQuery(doc, text))
    .map(toShareable)
    .filter(Boolean);
}

function pickFilesToShare(text, { knowledge = [], repeated = [], wantsShare = false } = {}) {
  const byName = matchDocsByName(text);
  if (byName.length) return byName.slice(0, 3);

  const fromKnowledge = docsFromIds(knowledge.map((k) => k.document_id));
  if (fromKnowledge.length) return fromKnowledge.slice(0, 2);

  if (repeated[0]?.document_id) {
    const fromRepeat = docsFromIds([repeated[0].document_id]);
    if (fromRepeat.length) return fromRepeat;
  }

  if (wantsShare) {
    const all = statements.allDocs.all().map(toShareable).filter(Boolean);
    if (all.length === 1) return all;
  }

  return [];
}

async function sendSharedFiles(sock, chatJid, files, quoted, mentions) {
  for (const file of files || []) {
    const payload = {
      document: { url: file.path },
      mimetype: file.mimetype,
      fileName: file.fileName,
    };
    if (mentions?.length) payload.mentions = mentions;
    await sock.sendMessage(chatJid, payload, quoted ? { quoted } : undefined);
  }
}

module.exports = {
  isShareRequest,
  mimeFor,
  pickFilesToShare,
  sendSharedFiles,
  toShareable,
};
