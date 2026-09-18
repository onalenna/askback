const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { toFile } = require('openai');
const { transcribeAudioDetailed } = require('../processor/audio');
const { looksLikeHeardSpeech, interpretVoiceTranscript } = require('../ai/understand');

const execFileAsync = promisify(execFile);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_SECONDS = 180;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function unwrapMessageContent(message) {
  let content = message;
  for (let i = 0; i < 5 && content; i++) {
    const inner =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message ||
      content.editedMessage?.message;
    if (!inner) break;
    content = inner;
  }
  return content || null;
}

function getAudioMessage(msg) {
  return unwrapMessageContent(msg.message)?.audioMessage || null;
}

function isVoiceNote(msg) {
  const audio = getAudioMessage(msg);
  if (!audio) return false;
  if (audio.ptt) return true;
  const mime = (audio.mimetype || '').toLowerCase();
  return mime.includes('ogg') || mime.includes('opus');
}

function audioExtension(mimetype) {
  const mime = (mimetype || '').toLowerCase();
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  return 'ogg';
}

function ffmpegBin() {
  try {
    return require('ffmpeg-static');
  } catch {
    return '';
  }
}

async function transcodeForWhisper(buffer, ext) {
  const bin = ffmpegBin();
  if (!bin || !fs.existsSync(bin) || !buffer?.length) return buffer;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askback-vn-'));
  const input = path.join(dir, `in.${ext || 'ogg'}`);
  const output = path.join(dir, 'out.wav');
  fs.writeFileSync(input, buffer);
  try {
    await execFileAsync(bin, [
      '-y',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      output,
    ]);
    return fs.readFileSync(output);
  } catch (err) {
    console.warn('[whatsapp] could not convert voice note for Whisper:', err.message || err);
    return buffer;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function downloadAudioBuffer(sock, msg) {
  const { downloadMediaMessage } = await import('baileys');
  const logger = sock.logger || {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return this;
    },
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage?.bind(sock),
        }
      );
      if (buffer?.length) return buffer;
    } catch (err) {
      lastErr = err;
      console.warn(`[whatsapp] voice download try ${attempt} failed:`, err.message || err);
    }
    if (sock.updateMediaMessage) {
      try {
        await sock.updateMediaMessage(msg);
      } catch (err) {
        console.warn('[whatsapp] media refresh failed:', err.message || err);
      }
    }
    await delay(1200);
  }
  if (lastErr) throw lastErr;
  return null;
}

/**
 * Download a WhatsApp voice note, transcribe it, then check that the words
 * actually make sense. Returns '' when the audio was not understood.
 */
async function transcribeVoiceNote(sock, msg, { chatContext = '', quoted = '' } = {}) {
  const audio = getAudioMessage(msg);
  if (!audio) return '';

  if (audio.seconds && audio.seconds > MAX_SECONDS) {
    console.log(`[whatsapp] skipping voice note (${audio.seconds}s > ${MAX_SECONDS}s)`);
    return '';
  }

  const buffer = await downloadAudioBuffer(sock, msg);
  if (!buffer?.length) {
    console.warn('[whatsapp] voice note had no audio bytes');
    return '';
  }
  if (buffer.length > MAX_BYTES) {
    console.log('[whatsapp] skipping voice note — file too large for Whisper');
    return '';
  }

  const ext = audioExtension(audio.mimetype);
  const whisperBytes = await transcodeForWhisper(buffer, ext);
  const file = await toFile(whisperBytes, 'voice-note.wav');
  const detailed = await transcribeAudioDetailed(file);
  const raw = detailed.text;
  console.log(`[whatsapp] voice note transcript: ${(raw || '').slice(0, 120)}`);
  if (!looksLikeHeardSpeech(detailed) && !raw) return '';

  let understood = '';
  try {
    understood = await interpretVoiceTranscript(raw, { chatContext, quoted });
  } catch (err) {
    console.warn('[whatsapp] voice interpret failed, using transcript:', err.message || err);
  }
  if (!understood && raw) understood = raw;
  if (!understood) return '';

  if (understood.toLowerCase() !== raw.toLowerCase()) {
    console.log(`[whatsapp] voice note understood as: ${understood.slice(0, 80)}`);
  }
  return understood;
}

/**
 * Generate a Lemonfox audio file and send it as a WhatsApp voice note.
 * Returns false if synthesis or send fails.
 */
async function sendVoiceReply(sock, chatJid, text, quoted, mentions) {
  const { ttsConfigured, synthesizeSpeechFile } = require('../ai/tts');
  if (!ttsConfigured()) {
    console.warn('[whatsapp] Lemonfox TTS is not configured — set LEMONFOX_API_KEY');
    return false;
  }

  try {
    await sock.sendPresenceUpdate('recording', chatJid);
  } catch {
    /* presence is optional */
  }

  let file;
  try {
    file = await synthesizeSpeechFile(text);
  } catch (err) {
    console.error('[whatsapp] lemonfox tts failed:', err.message || err);
    return false;
  }
  if (!file?.filePath) {
    console.error('[whatsapp] lemonfox tts returned no audio file');
    return false;
  }

  const payload = {
    audio: file.buffer,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  };
  if (mentions?.length) payload.mentions = mentions;

  try {
    await sock.sendMessage(chatJid, payload, quoted ? { quoted } : undefined);
    console.log('[whatsapp] sent lemonfox voice note (ogg opus)');
    return true;
  } catch (err) {
    console.warn('[whatsapp] voice note send failed, retrying as audio file:', err.message || err);
    try {
      await sock.sendMessage(
        chatJid,
        {
          audio: file.buffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: false,
          fileName: file.fileName,
          mentions: mentions?.length ? mentions : undefined,
        },
        quoted ? { quoted } : undefined
      );
      console.log('[whatsapp] sent lemonfox audio file (ogg opus)');
      return true;
    } catch (err2) {
      console.error('[whatsapp] could not send lemonfox audio:', err2.message || err2);
      return false;
    }
  }
}

module.exports = {
  unwrapMessageContent,
  getAudioMessage,
  isVoiceNote,
  transcribeVoiceNote,
  sendVoiceReply,
};
