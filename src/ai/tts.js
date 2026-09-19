const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const { detectLanguage, lemonfoxLanguage, resolveReplyLanguage } = require('./language');
const { getLemonfoxVoice, voiceLocale } = require('./voices');
const LEMONFOX_URL = 'https://api.lemonfox.ai/v1/audio/speech';
const MAX_CHARS = 4000;
const TTS_DIR = path.join(__dirname, '..', '..', 'uploads', 'tts');
const SOURCE_FORMAT = (process.env.LEMONFOX_FORMAT || 'mp3').toLowerCase();
const WA_MIME = 'audio/ogg; codecs=opus';

function trimUrlTail(url) {
  return String(url || '')
    .trim()
    .replace(/[.,;:!?]+$/g, '')
    .replace(/[)\]}'"]+$/g, '');
}

function linkDisplayName(url, explicit = '') {
  const named = String(explicit || '').replace(/\s+\n/g, '\n').trim();
  const first = named.split('\n')[0] || '';
  if (named && !/^https?:\/\//i.test(first) && !/^www\./i.test(first)) {
    return named.slice(0, 220);
  }
  try {
    const u = new URL(/^www\./i.test(url) ? `https://${url}` : url);
    const host = u.hostname.replace(/^www\./i, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length) {
      const last = decodeURIComponent(parts[parts.length - 1])
        .replace(/\.[a-z0-9]{1,8}$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (last.length >= 3 && last.length <= 48 && !/^[0-9a-f]{8,}$/i.test(last)) {
        return last.replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }
    return host || 'Link';
  } catch {
    return 'Link';
  }
}

function contextLinesBefore(lines, index) {
  const block = [];
  for (let j = index - 1; j >= 0 && block.length < 2; j--) {
    const t = String(lines[j] || '').trim();
    if (!t) {
      if (block.length) break;
      continue;
    }
    if (/(?:https?:\/\/|www\.)/i.test(t)) break;
    if (t.length > 160) break;
    block.unshift(t);
  }
  return block;
}

/** @returns {{ name: string, url: string }[]} */
function extractLinks(text) {
  const found = [];
  const seen = new Set();
  const add = (raw, name = '') => {
    let url = trimUrlTail(raw);
    if (!url) return;
    if (/^www\./i.test(url)) url = `https://${url}`;
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name: linkDisplayName(url, name), url });
  };

  const src = String(text || '');

  src.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (full, label, url) => {
    add(url, label);
    return full;
  });

  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const sameLine = line.match(/^(.+?)[:\-–—]\s*((?:https?:\/\/|www\.)\S+)\s*$/i);
    if (sameLine && !/(?:https?:\/\/|www\.)/i.test(sameLine[1])) {
      add(sameLine[2], sameLine[1]);
      continue;
    }
    const onlyUrl = line.match(/^((?:https?:\/\/|www\.)\S+)\s*$/i);
    if (onlyUrl) {
      add(onlyUrl[1], contextLinesBefore(lines, i).join('\n'));
    }
  }

  src.replace(/(?:https?:\/\/|www\.)[^\s<>"'\]\)]+/gi, (url) => {
    add(url);
    return '';
  });

  return found;
}

function formatLinksMessage(links) {
  const list = (links || []).map((item) =>
    typeof item === 'string' ? { name: linkDisplayName(item), url: item } : item
  );
  return list
    .filter((item) => item?.url)
    .map((item) => {
      const label = String(item.name || linkDisplayName(item.url)).trim();
      return `${label}\n${item.url}`;
    })
    .join('\n\n');
}

/** Keep readable words; drop URLs so TTS does not read them aloud. */
function withoutLinks(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, '$1')
    .replace(/\[\]\((https?:\/\/[^)\s]+)\)/gi, ' ')
    .replace(/https?:\/\/[^\s<>"'\]\)]+/gi, ' ')
    .replace(/\bwww\.[^\s<>"'\]\)]+/gi, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop emojis/symbols so TTS speaks plain words only (no "smiling face"). */
function stripEmojis(text) {
  return String(text || '')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\uFE0F/g, '')
    .replace(/\u200D/g, '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ') // flag letters if left behind
    .replace(/:[a-z0-9_+-]{2,32}:/gi, ' '); // :smile: style shortcodes
}

function speakable(text) {
  return stripEmojis(withoutLinks(text))
    .replace(/[*_`#~>]/g, '')
    .replace(/@\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

/** Spoken body for TTS + named links to send as a separate text message. */
function splitForVoice(text) {
  return { spoken: speakable(text), links: extractLinks(text) };
}

function readDotEnvKey(name) {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    const text = fs.readFileSync(envPath, 'utf8');
    const match = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (!match) return '';
    return match[1].trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

function lemonfoxKey() {
  return String(process.env.LEMONFOX_API_KEY || '').trim() || readDotEnvKey('LEMONFOX_API_KEY');
}

function ttsConfigured() {
  return Boolean(lemonfoxKey());
}

function ffmpegBin() {
  try {
    return require('ffmpeg-static');
  } catch {
    return '';
  }
}

function isOggOpus(buffer) {
  if (!buffer || buffer.length < 36) return false;
  if (buffer.slice(0, 4).toString('ascii') !== 'OggS') return false;
  return buffer.includes(Buffer.from('OpusHead'));
}

function pruneOldFiles() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(TTS_DIR)) {
      const full = path.join(TTS_DIR, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {
    /* ignore */
  }
}

async function synthesizeSpeech(text, { language: hinted } = {}) {
  const input = speakable(text);
  const apiKey = lemonfoxKey();
  if (!apiKey || !input) return null;

  const langCode = resolveReplyLanguage(input, hinted) || detectLanguage(input) || 'en';
  const voice = getLemonfoxVoice();
  const mappedLang = lemonfoxLanguage(langCode);
  const language = mappedLang && mappedLang !== 'en-us' ? mappedLang : voiceLocale(voice);
  const responseFormat = SOURCE_FORMAT === 'ogg' ? 'ogg' : SOURCE_FORMAT === 'opus' ? 'opus' : 'mp3';

  const body = {
    input,
    voice,
    response_format: responseFormat,
  };
  if (language) body.language = language;
  console.log(`[whatsapp] lemonfox tts voice=${voice} language=${language || 'default'}`);

  const response = await fetch(LEMONFOX_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Lemonfox TTS ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) return null;
  return buffer;
}

async function convertToOggOpus(inputPath, outputPath) {
  const bin = ffmpegBin();
  if (!bin || !fs.existsSync(bin)) {
    throw new Error('ffmpeg-static is missing — cannot convert TTS to a WhatsApp voice note');
  }
  await execFileAsync(bin, [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-map_metadata',
    '-1',
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
    '-ar',
    '48000',
    '-ac',
    '1',
    '-application',
    'voip',
    outputPath,
  ]);
  const out = fs.readFileSync(outputPath);
  if (!isOggOpus(out)) {
    throw new Error('ffmpeg did not produce OGG Opus audio');
  }
  return out;
}

async function synthesizeSpeechFile(text, opts = {}) {
  const buffer = await synthesizeSpeech(text, opts);
  if (!buffer) return null;

  fs.mkdirSync(TTS_DIR, { recursive: true });
  pruneOldFiles();

  const stamp = Date.now();
  const oggPath = path.join(TTS_DIR, `askback-${stamp}.ogg`);

  let opus = buffer;
  if (!isOggOpus(buffer)) {
    const srcExt = SOURCE_FORMAT === 'wav' ? 'wav' : SOURCE_FORMAT === 'aac' ? 'aac' : 'mp3';
    const srcPath = path.join(TTS_DIR, `askback-${stamp}.${srcExt}`);
    fs.writeFileSync(srcPath, buffer);
    opus = await convertToOggOpus(srcPath, oggPath);
    try {
      fs.unlinkSync(srcPath);
    } catch {
      /* ignore */
    }
  } else {
    fs.writeFileSync(oggPath, opus);
  }

  return {
    filePath: oggPath,
    buffer: opus,
    mimetype: WA_MIME,
    fileName: 'askBack.ogg',
    ptt: true,
  };
}

module.exports = {
  ttsConfigured,
  synthesizeSpeech,
  synthesizeSpeechFile,
  speakable,
  stripEmojis,
  extractLinks,
  withoutLinks,
  splitForVoice,
  formatLinksMessage,
  linkDisplayName,
};
