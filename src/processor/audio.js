const fs = require('fs');
const { getWhisperClient } = require('../ai/embeddings');
const { chunkText } = require('./chunking');

function whisperLanguage() {
  const lang = String(process.env.WHISPER_LANGUAGE || '').toLowerCase();
  if (!lang) return undefined;
  if (lang.startsWith('en')) return 'en';
  return lang.split('-')[0];
}

/**
 * Transcribe audio from a file path or an OpenAI File / stream.
 */
async function transcribeAudio(source, { prompt = '', language } = {}) {
  const detailed = await transcribeAudioDetailed(source, { prompt, language });
  return detailed.text || '';
}

async function transcribeAudioDetailed(source, { prompt = '', language } = {}) {
  const file = typeof source === 'string' ? fs.createReadStream(source) : source;
  const params = {
    file,
    model: 'whisper-1',
    response_format: 'verbose_json',
  };
  const lang = language || whisperLanguage();
  if (lang) params.language = lang;
  if (prompt) params.prompt = String(prompt).slice(0, 800);
  const response = await getWhisperClient().audio.transcriptions.create(params);
  return {
    text: String(response.text || '').trim(),
    language: response.language || '',
    duration: Number(response.duration || 0),
    segments: Array.isArray(response.segments) ? response.segments : [],
  };
}

async function processAudio(filePath) {
  const transcript = await transcribeAudio(filePath);
  return chunkText(transcript);
}

module.exports = { transcribeAudio, transcribeAudioDetailed, processAudio };