const fs = require('fs');
const path = require('path');
const { statements } = require('../db/queries');
const { mentionJidList } = require('./mentions');

const SHARE_VERB =
  /\b(send|share|forward|attach|envoie|envoyer|partage|partager|envía|envia|comparte|compartir|manda|mandar|invia|condividi)\b/i;

const SHARE_PHRASE =
  /\b((send|share|give)\s+(me|us|the)|can you send|please send|envoie[- ]moi|partage[- ]moi)\b/i;

const FILE_NOUN =
  /\b(file|files|pdf|document|documents|doc|docs|image|images|photo|photos|picture|pictures|audio|recording|mp3|attachment|attachments|fichier|fichiers|archivo|archivos|documento|documentos|ficheiro|difaele|tokomane)\b|\.(pdf|mp3|wav|m4a|ogg|webm|docx?|xlsx?|pptx?|jpe?g|png|webp|gif)\b/i;

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
  const t = String(text || '');
  if (!SHARE_VERB.test(t) && !SHARE_PHRASE.test(t)) return false;
  return FILE_NOUN.test(t);
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
  if (isKnowledgeOnly(doc)) return null;
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
  if (!wantsShare) return [];

  const byName = matchDocsByName(text);
  if (byName.length) return byName.slice(0, 3);

  const fromKnowledge = docsFromIds(knowledge.map((k) => k.document_id));
  if (fromKnowledge.length) return fromKnowledge.slice(0, 2);

  if (repeated[0]?.document_id) {
    const fromRepeat = docsFromIds([repeated[0].document_id]);
    if (fromRepeat.length) return fromRepeat;
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
    const mentionIds = mentionJidList(mentions, sock, chatJid);
    if (mentionIds.length) payload.mentions = mentionIds;
    await sock.sendMessage(chatJid, payload, quoted ? { quoted } : undefined);
  }
}

module.exports = {
  isShareRequest,
  isKnowledgeOnly,
  mimeFor,
  pickFilesToShare,
  sendSharedFiles,
  toShareable,
};
