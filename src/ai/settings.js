const { statements } = require('../db/queries');

/**
 * Live answer-tuning knobs, stored in the settings table so a developer can
 * change them from the dashboard Control tab WITHOUT editing .env or
 * restarting. Each getter falls back to the env var, then a safe default, so
 * existing deployments keep working until an admin overrides a value.
 *
 * Keys and their meaning:
 *   kb_match_threshold  minimum similarity for a knowledge chunk to count (0-1)
 *   repeat_threshold    minimum similarity to reuse a past answer (0-1)
 *   top_k               how many chunks to feed the model
 *   max_question_length longest question (chars) before it is truncated
 */

const DEFS = {
  kb_match_threshold: { env: 'KB_MATCH_THRESHOLD', def: 0.45, min: 0, max: 1 },
  repeat_threshold: { env: 'REPEAT_THRESHOLD', def: 0.82, min: 0, max: 1 },
  top_k: { env: 'TOP_K', def: 3, min: 1, max: 20, int: true },
  max_question_length: { env: 'MAX_QUESTION_LENGTH', def: 2000, min: 200, max: 20000, int: true },
};

function readNumber(key) {
  const spec = DEFS[key];
  if (!spec) return null;
  // 1. DB setting wins.
  try {
    const row = statements.getSetting.get(key);
    if (row?.value != null && row.value !== '') {
      const n = spec.int ? parseInt(row.value, 10) : parseFloat(row.value);
      if (Number.isFinite(n)) return clamp(n, spec);
    }
  } catch {
    /* fall through to env */
  }
  // 2. Env var.
  const envVal = process.env[spec.env];
  if (envVal != null && envVal !== '') {
    const n = spec.int ? parseInt(envVal, 10) : parseFloat(envVal);
    if (Number.isFinite(n)) return clamp(n, spec);
  }
  // 3. Default.
  return spec.def;
}

function clamp(n, spec) {
  return Math.min(spec.max, Math.max(spec.min, n));
}

/** Persist a tuning value (validated + clamped). Returns the stored number. */
function setTuning(key, value) {
  const spec = DEFS[key];
  if (!spec) throw new Error(`Unknown setting: ${key}`);
  const n = spec.int ? parseInt(value, 10) : parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}`);
  const clamped = clamp(n, spec);
  statements.setSetting.run(key, String(clamped));
  return clamped;
}

/** All current tuning values plus their bounds, for the dashboard. */
function getTuning() {
  const out = {};
  for (const key of Object.keys(DEFS)) {
    out[key] = { value: readNumber(key), min: DEFS[key].min, max: DEFS[key].max };
  }
  return out;
}

// ── Text/persona settings stored in the same settings table ──────────────────

function readText(key, fallback = '') {
  try {
    const row = statements.getSetting.get(key);
    if (row?.value != null && row.value !== '') return String(row.value);
  } catch { /* ignore */ }
  return fallback;
}

function setText(key, value) {
  statements.setSetting.run(key, String(value ?? '').trim());
}

/** Persona profile: 'funny' | 'serious' | 'friendly' | 'professional' */
function getPersona() { return readText('persona', 'friendly'); }
/** What this bot is for, injected into the system prompt. */
function getProgramContext() { return readText('program_context', ''); }
/** Emoji density: 'none' | 'light' | 'expressive' */
function getEmojiMode() { return readText('emoji_mode', 'light'); }
/** Whether to detect and deflect off-topic questions. */
function getOffTopicMode() { return readText('off_topic_mode', 'deflect'); }

module.exports = {
  readNumber,
  setTuning,
  getTuning,
  kbMatchThreshold: () => readNumber('kb_match_threshold'),
  repeatThreshold:  () => readNumber('repeat_threshold'),
  topK:             () => readNumber('top_k'),
  maxQuestionLength:() => readNumber('max_question_length'),
  TUNING_KEYS: Object.keys(DEFS),
  readText,
  setText,
  getPersona,
  getProgramContext,
  getEmojiMode,
  getOffTopicMode,
};
