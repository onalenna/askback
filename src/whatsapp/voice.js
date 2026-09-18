const { toFile } = require('openai');
const { transcribeAudioDetailed } = require('../processor/audio');
const { looksLikeHeardSpeech, interpretVoiceTranscript } = require('../ai/understand');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_SECONDS = 180;

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
  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage?.bind(sock),
    }
  );

  if (!buffer?.length) return '';
  if (buffer.length > MAX_BYTES) {
    console.log('[whatsapp] skipping voice note — file too large for Whisper');
    return '';
  }

  const ext = audioExtension(audio.mimetype);
  const file = await toFile(buffer, `voice-note.${ext}`);
  const prompt = [quoted, chatContext]
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const detailed = await transcribeAudioDetailed(file, { prompt });
  const raw = detailed.text;
  if (!looksLikeHeardSpeech(detailed)) {
    console.log(`[whatsapp] voice note unclear after transcription: ${(raw || '').slice(0, 80)}`);
    return '';
  }

  const understood = await interpretVoiceTranscript(raw, { chatContext, quoted });
  if (!understood) {
    console.log(`[whatsapp] voice note transcribed but not understood: ${raw.slice(0, 80)}`);
    return '';
  }

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
