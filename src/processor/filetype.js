const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.mp4'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic'];
const DOC_EXTS = ['.docx', '.xlsx', '.pptx', '.doc', '.rtf', '.csv'];

function decodeOriginalName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  try {
    const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
    if (utf8 && utf8 !== raw && !utf8.includes('\uFFFD')) return utf8;
  } catch {
    /* keep raw */
  }
  return raw;
}

function extOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function looksLikeTxtName(filename) {
  const name = String(filename || '').toLowerCase();
  return (
    name.endsWith('.txt') ||
    name.endsWith('.text') ||
    name.endsWith('_chat.txt') ||
    /(^|\/|\\)whatsapp chat.*\.txt$/.test(name)
  );
}

function detectType(filename, mimetype) {
  const name = String(filename || '');
  const ext = extOf(name);
  const mime = String(mimetype || '')
    .toLowerCase()
    .split(';')[0]
    .trim();

  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (
    DOC_EXTS.includes(ext) ||
    /wordprocessingml|spreadsheetml|presentationml|msword|ms-excel|ms-powerpoint|officedocument/.test(mime)
  ) {
    return 'document';
  }
  if (IMAGE_EXTS.includes(ext) || mime.startsWith('image/')) return 'image';
  if (
    looksLikeTxtName(name) ||
    ext === '.txt' ||
    ext === '.text' ||
    mime === 'text/plain' ||
    mime === 'text/txt' ||
    mime === 'application/txt' ||
    mime === 'text/x-log' ||
    mime === 'text/markdown' ||
    (mime.startsWith('text/') && ext !== '.csv')
  ) {
    return 'text';
  }
  if (ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed' || mime === 'multipart/x-zip') {
    return 'zip';
  }
  if (AUDIO_EXTS.includes(ext) || mime.startsWith('audio/')) return 'audio';
  return null;
}

function looksLikeUtf16(buf) {
  if (!buf || buf.length < 8) return false;
  const evenNull = buf[0] === 0xff && buf[1] === 0xfe;
  const oddNull = buf[0] === 0xfe && buf[1] === 0xff;
  if (evenNull || oddNull) return true;
  let zeros = 0;
  const n = Math.min(buf.length, 200);
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0 || buf[i + 1] === 0) zeros += 1;
  }
  return zeros / (n / 2) > 0.7;
}

function looksLikeTextBuffer(buf) {
  if (!buf?.length) return false;
  if (looksLikeUtf16(buf)) return true;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 1200));
  let weird = 0;
  for (const byte of sample) {
    if (byte === 0) {
      weird += 3;
      continue;
    }
    if (byte < 9 || (byte > 13 && byte < 32)) weird += 1;
  }
  return weird / sample.length < 0.12;
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true;
  }
  return false;
}

function sniffType(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (sniffImage(buf)) return 'image';
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (looksLikeTextBuffer(buf)) return 'text';
  return null;
}

function resolveUploadType(file) {
  const original =
    path.basename(decodeOriginalName(file?.originalname || '')) ||
    String(file?.originalname || '').trim() ||
    'upload.txt';
  let type = detectType(original, file?.mimetype);
  if (!type) type = sniffType(file?.path);
  if (!type && looksLikeTxtName(original)) type = 'text';
  return { original, type };
}

module.exports = { detectType, resolveUploadType, decodeOriginalName, sniffType, IMAGE_EXTS, DOC_EXTS };
