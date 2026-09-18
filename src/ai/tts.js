const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const { detectLanguage, lemonfoxLanguage, lemonfoxVoice } = require('./language');
const LEMONFOX_URL = 'https://api.lemonfox.ai/v1/audio/speech';
const MAX_CHARS = 4000;
const TTS_DIR = path.join(__dirname, '..', '..', 'uploads', 'tts');
const SOURCE_FORMAT = (process.env.LEMONFOX_FORMAT || 'mp3').toLowerCase();
const WA_MIME = 'audio/ogg; codecs=opus';

function speakable(text) {
  return String(text || '')
    .replace(/[*_`#]/g, '')
    .replace(/@\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
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

async function synthesizeSpeech(text) {
  const input = speakable(text);
  const apiKey = lemonfoxKey();
  if (!apiKey || !input) return null;

  const langCode = detectLanguage(input);
  const voice = lemonfoxVoice(langCode);
  const language = lemonfoxLanguage(langCode);
  const responseFormat = SOURCE_FORMAT === 'ogg' ? 'ogg' : SOURCE_FORMAT === 'opus' ? 'opus' : 'mp3';

  const body = {
    input,
    voice,
    response_format: responseFormat,
  };
  if (language) body.language = language;

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

async function synthesizeSpeechFile(text) {
  const buffer = await synthesizeSpeech(text);
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
};
