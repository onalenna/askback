const { statements } = require('../db/queries');

const SETTING_KEY = 'lemonfox_voice';

const LEMONFOX_VOICES = [
  { id: 'heart', label: 'Heart', group: 'American English', locale: 'en-us' },
  { id: 'bella', label: 'Bella', group: 'American English', locale: 'en-us' },
  { id: 'sarah', label: 'Sarah', group: 'American English', locale: 'en-us' },
  { id: 'nova', label: 'Nova', group: 'American English', locale: 'en-us' },
  { id: 'sky', label: 'Sky', group: 'American English', locale: 'en-us' },
  { id: 'river', label: 'River', group: 'American English', locale: 'en-us' },
  { id: 'jessica', label: 'Jessica', group: 'American English', locale: 'en-us' },
  { id: 'nicole', label: 'Nicole', group: 'American English', locale: 'en-us' },
  { id: 'kore', label: 'Kore', group: 'American English', locale: 'en-us' },
  { id: 'aoede', label: 'Aoede', group: 'American English', locale: 'en-us' },
  { id: 'michael', label: 'Michael', group: 'American English', locale: 'en-us' },
  { id: 'liam', label: 'Liam', group: 'American English', locale: 'en-us' },
  { id: 'onyx', label: 'Onyx', group: 'American English', locale: 'en-us' },
  { id: 'echo', label: 'Echo', group: 'American English', locale: 'en-us' },
  { id: 'eric', label: 'Eric', group: 'American English', locale: 'en-us' },
  { id: 'fenrir', label: 'Fenrir', group: 'American English', locale: 'en-us' },
  { id: 'puck', label: 'Puck', group: 'American English', locale: 'en-us' },
  { id: 'alloy', label: 'Alloy', group: 'American English', locale: 'en-us' },
  { id: 'adam', label: 'Adam', group: 'American English', locale: 'en-us' },
  { id: 'santa', label: 'Santa', group: 'American English', locale: 'en-us' },
  { id: 'alice', label: 'Alice', group: 'British English', locale: 'en-gb' },
  { id: 'emma', label: 'Emma', group: 'British English', locale: 'en-gb' },
  { id: 'isabella', label: 'Isabella', group: 'British English', locale: 'en-gb' },
  { id: 'lily', label: 'Lily', group: 'British English', locale: 'en-gb' },
  { id: 'daniel', label: 'Daniel', group: 'British English', locale: 'en-gb' },
  { id: 'george', label: 'George', group: 'British English', locale: 'en-gb' },
  { id: 'fable', label: 'Fable', group: 'British English', locale: 'en-gb' },
  { id: 'lewis', label: 'Lewis', group: 'British English', locale: 'en-gb' },
];

const VOICE_BY_ID = new Map(LEMONFOX_VOICES.map((voice) => [voice.id, voice]));

function envDefaultVoice() {
  const raw = String(process.env.LEMONFOX_VOICE || '').trim().toLowerCase();
  if (VOICE_BY_ID.has(raw)) return raw;
  return 'sarah';
}

function normalizeVoice(id) {
  const raw = String(id || '').trim().toLowerCase();
  return VOICE_BY_ID.has(raw) ? raw : '';
}

function listLemonfoxVoices() {
  return LEMONFOX_VOICES.map((voice) => ({ ...voice }));
}

function getLemonfoxVoice() {
  try {
    const saved = normalizeVoice(statements.getSetting.get(SETTING_KEY)?.value);
    if (saved) return saved;
  } catch {
    /* fall through */
  }
  return envDefaultVoice();
}

function setLemonfoxVoice(id) {
  const voice = normalizeVoice(id);
  if (!voice) throw new Error('Pick a voice from the list.');
  statements.setSetting.run(SETTING_KEY, voice);
  process.env.LEMONFOX_VOICE = voice;
  return voice;
}

function voiceLocale(id) {
  return VOICE_BY_ID.get(normalizeVoice(id) || getLemonfoxVoice())?.locale || 'en-us';
}

module.exports = {
  listLemonfoxVoices,
  getLemonfoxVoice,
  setLemonfoxVoice,
  voiceLocale,
  normalizeVoice,
};
