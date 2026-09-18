const path = require('path');
const { unwrapMessageContent } = require('./voice');
const { getContextInfo } = require('./mentions');
const { downloadMediaBuffer } = require('./download');
const { extractDocumentText, looksLikeImage } = require('../processor/office');
const { understandImage } = require('../ai/vision');

const MAX_BYTES = 20 * 1024 * 1024;

function isArchive(filename, mimetype) {
  const name = String(filename || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase();
  if (/\.(docx|xlsx|pptx)$/i.test(name)) return false;
  if (/wordprocessingml|spreadsheetml|presentationml|officedocument/.test(mime)) return false;
  if (/\.(zip|rar|7z|gz|tgz|tar)$/i.test(name)) return true;
  return /^(application\/((x-)?zip(-compressed)?|x-rar(-compressed)?|x-7z-compressed|gzip|x-tar|x-gtar)|multipart\/x-zip)$/.test(
    mime
  );
}

function inspectContent(content) {
  if (!content || typeof content !== 'object') return null;
  if (content.imageMessage) {
    const node = content.imageMessage;
    return {
      kind: 'image',
      node,
      mimetype: node.mimetype || 'image/jpeg',
      fileName: node.fileName || 'image.jpg',
      caption: node.caption || '',
      archive: false,
    };
  }
  if (content.stickerMessage) {
    const node = content.stickerMessage;
    return {
      kind: 'sticker',
      node,
      mimetype: node.mimetype || 'image/webp',
      fileName: 'sticker.webp',
      caption: '',
      archive: false,
    };
  }
  if (content.videoMessage?.gifPlayback) {
    const node = content.videoMessage;
    return {
      kind: 'image',
      node,
      mimetype: node.mimetype || 'image/gif',
      fileName: node.fileName || 'image.gif',
      caption: node.caption || '',
      archive: false,
    };
  }
  if (content.documentMessage) {
    const node = content.documentMessage;
    const fileName = node.fileName || node.title || 'document';
    const mimetype = node.mimetype || '';
    return {
      kind: looksLikeImage(fileName, mimetype) ? 'image' : 'document',
      node,
      mimetype,
      fileName,
      caption: node.caption || '',
      archive: isArchive(fileName, mimetype),
    };
  }
  if (content.videoMessage) {
    return {
      kind: 'video',
      node: content.videoMessage,
      mimetype: content.videoMessage.mimetype || 'video/mp4',
      fileName: content.videoMessage.fileName || 'video.mp4',
      caption: content.videoMessage.caption || '',
      archive: false,
    };
  }
  return null;
}

function inspectMessageMedia(msg) {
  return inspectContent(unwrapMessageContent(msg?.message));
}

function quotedMediaMessage(msg) {
  const ctx = getContextInfo(msg);
  if (!ctx?.quotedMessage) return null;
  const info = inspectContent(unwrapMessageContent(ctx.quotedMessage) || ctx.quotedMessage);
  if (!info) return null;
  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: ctx.stanzaId,
      fromMe: false,
      participant: ctx.participant || ctx.participantLid || ctx.participantPn,
    },
    message: ctx.quotedMessage,
  };
}

function inspectQuotedMedia(msg) {
  const quoted = quotedMediaMessage(msg);
  return quoted ? inspectContent(unwrapMessageContent(quoted.message) || quoted.message) : null;
}

function hasUnderstandableMedia(msg) {
  const info = inspectMessageMedia(msg) || inspectQuotedMedia(msg);
  return Boolean(info && info.kind !== 'video');
}

function asDownloadMsg(msg, info) {
  if (msg?.message) return msg;
  return { key: msg?.key, message: { [info.kind === 'document' ? 'documentMessage' : `${info.kind}Message`]: info.node } };
}

async function readOne(sock, msg, info, extras) {
  if (!info || info.kind === 'video') return { text: '', archive: false, kind: info?.kind || '' };
  if (info.archive) return { text: '', archive: true, kind: 'archive', fileName: info.fileName };

  const buffer = await downloadMediaBuffer(sock, asDownloadMsg(msg, info), { label: info.kind });
  if (!buffer?.length) return { text: '', archive: false, kind: info.kind };
  if (buffer.length > MAX_BYTES) {
    console.warn(`[whatsapp] skip ${info.kind} — too large`);
    return { text: '', archive: false, kind: info.kind };
  }

  if (info.kind === 'image' || info.kind === 'sticker' || looksLikeImage(info.fileName, info.mimetype)) {
    const text = await understandImage(buffer, info.mimetype, extras);
    return { text, archive: false, kind: info.kind || 'image' };
  }

  const text = await extractDocumentText(buffer, info.fileName, info.mimetype);
  if (text) return { text: `Document (${info.fileName}):\n${text}`, archive: false, kind: 'document' };

  if (looksLikeImage(info.fileName, info.mimetype)) {
    const seen = await understandImage(buffer, info.mimetype, extras);
    return { text: seen, archive: false, kind: 'image' };
  }

  return { text: '', archive: false, kind: info.kind };
}

function joinMedia(caption, pieces) {
  const bits = [];
  const cap = String(caption || '').trim();
  if (cap) bits.push(cap);
  for (const piece of pieces) {
    const text = String(piece || '').trim();
    if (text) bits.push(text);
  }
  return bits.join('\n\n');
}

async function understandMessageMedia(sock, msg, { caption = '', quoted = '' } = {}) {
  const own = inspectMessageMedia(msg);
  const quotedInfo = inspectQuotedMedia(msg);
  const extras = { caption, quoted, language: '' };
  const pieces = [];
  let archive = false;

  if (own?.archive) archive = true;
  else if (own && own.kind !== 'video') {
    try {
      const result = await readOne(sock, msg, own, extras);
      if (result.archive) archive = true;
      if (result.text) pieces.push(result.text);
    } catch (err) {
      console.error('[whatsapp] could not read attached media:', err.message || err);
    }
  }

  if (quotedInfo?.archive) {
    archive = archive || false;
  } else if (quotedInfo && quotedInfo.kind !== 'video') {
    try {
      const qmsg = quotedMediaMessage(msg);
      const result = await readOne(sock, qmsg, quotedInfo, extras);
      if (result.text) pieces.push(`Quoted ${quotedInfo.kind}:\n${result.text}`);
    } catch (err) {
      console.error('[whatsapp] could not read quoted media:', err.message || err);
    }
  }

  return {
    text: joinMedia('', pieces),
    archive: Boolean(own?.archive),
    kind: own?.kind || quotedInfo?.kind || '',
    fileName: own?.fileName || quotedInfo?.fileName || '',
  };
}

module.exports = {
  inspectMessageMedia,
  inspectQuotedMedia,
  hasUnderstandableMedia,
  understandMessageMedia,
  isArchive,
};
