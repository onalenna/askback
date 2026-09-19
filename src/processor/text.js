const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CHUNK_SIZE = 1200;

function readChatText(filePath) {
  const buf = fs.readFileSync(filePath);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - (buf.length % 2));
    for (let i = 0; i + 1 < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    text = swapped.toString('utf16le');
  } else {
    text = buf.toString('utf8');
    const nul = (text.match(/\0/g) || []).length;
    if (nul > text.length / 4) {
      text = buf.toString('utf16le');
    }
  }
  return text.replace(/^\uFEFF/, '').replace(/\u200e|\u200f/g, '').replace(/\r\n/g, '\n');
}

function listTxtFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...listTxtFiles(full));
    else if (name.toLowerCase().endsWith('.txt')) out.push(full);
  }
  return out;
}

function pickChatTxt(files) {
  if (!files.length) return '';
  return (
    files.find((file) => path.basename(file).toLowerCase() === '_chat.txt') ||
    files.find((file) => /whatsapp chat/i.test(path.basename(file))) ||
    files[0]
  );
}

function unzipTo(dir, zipPath) {
  try {
    execFileSync('unzip', ['-o', '-qq', zipPath, '-d', dir], { timeout: 30000, stdio: 'ignore' });
    return;
  } catch {
    /* fall through to python */
  }
  execFileSync(
    'python3',
    ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, dir],
    { timeout: 30000, stdio: 'ignore' }
  );
}

function openChatExport(filePath, filename) {
  const ext = path.extname(filename || filePath || '').toLowerCase();
  if (ext !== '.zip') return { path: filePath, cleanup: '', media: [] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askback-chat-'));
  try {
    unzipTo(dir, filePath);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Could not open that zip. Unzip it and upload _chat.txt.');
  }

  const chat = pickChatTxt(listTxtFiles(dir));
  if (!chat) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('No chat .txt in that zip. Export the chat and upload _chat.txt, or include it in the zip.');
  }
  return { path: chat, cleanup: dir, media: listExportMedia(dir, chat) };
}

const MEDIA_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.doc',
  '.rtf',
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.opus',
]);

function listExportMedia(dir, chatPath) {
  const out = [];
  const chatAbs = path.resolve(chatPath || '');
  function walk(folder) {
    for (const name of fs.readdirSync(folder)) {
      if (name.startsWith('.')) continue;
      const full = path.join(folder, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (path.resolve(full) === chatAbs) continue;
      const ext = path.extname(name).toLowerCase();
      if (!MEDIA_EXTS.has(ext)) continue;
      if (st.size < 32 || st.size > 40 * 1024 * 1024) continue;
      out.push(full);
    }
  }
  walk(dir);
  out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return out.slice(0, 40);
}

function processText(filePath) {
  const raw = readChatText(filePath);
  let text = raw.replace(/^[\s\S]{0,800}?end-to-end encrypted[^\n]*\n?/i, '');
  text = text.trim() || raw.trim();
  if (!text) return [];

  const lines = text.split('\n');
  const chunks = [];
  let buf = '';
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > CHUNK_SIZE && buf) {
      chunks.push(buf.trim());
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

const IOS_LINE =
  /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]\s+(.*)$/;
const ANDROID_LINE =
  /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\s+-\s+(.*)$/;

function splitSender(rest) {
  const body = String(rest || '').replace(/^\s*-\s+/, '');
  const idx = body.indexOf(': ');
  if (idx > 0 && idx < 80 && !/^https?:\/\//i.test(body.slice(0, idx))) {
    return {
      sender: body.slice(0, idx).replace(/\s+/g, ' ').trim(),
      text: body.slice(idx + 2),
      system: false,
    };
  }
  return { sender: '', text: body.trim(), system: true };
}

function parseChatTranscript(raw) {
  const text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\u200e|\u200f/g, '')
    .replace(/\r\n/g, '\n');
  if (!text.trim()) return [];

  const messages = [];
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\s+$/, '');
    const match = trimmed.match(IOS_LINE) || trimmed.match(ANDROID_LINE);
    if (match) {
      const { sender, text: body, system } = splitSender(match[3]);
      messages.push({
        time: `${match[1]} ${match[2]}`.trim(),
        sender,
        text: body,
        system,
      });
      continue;
    }
    if (!messages.length) continue;
    const last = messages[messages.length - 1];
    last.text = last.text ? `${last.text}\n${trimmed}` : trimmed;
  }

  return messages.filter((msg) => String(msg.text || '').trim());
}

function looksLikeChat(filename, title, messages) {
  const name = `${filename || ''} ${title || ''}`.toLowerCase();
  if (name.includes('_chat.txt') || name.includes('whatsapp chat')) return messages.length > 0;
  return messages.length >= 2;
}

module.exports = { processText, openChatExport, readChatText, parseChatTranscript, looksLikeChat, listExportMedia };
