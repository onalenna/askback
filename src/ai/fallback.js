/**
 * Chat completions with key fallback.
 *
 * Tries the environment provider first, then every active key added on the
 * dashboard (settings.ai_keys), moving on only when a key is out of credit or
 * rate-limited. Used by the dashboard chat test and by WhatsApp answers,
 * digests and reminders so both paths behave the same.
 */
const db = require('../db');

const PROVIDER_DEFAULTS = {
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
  openai:     { baseURL: null,                             defaultModel: 'gpt-4o-mini' },
  gemini:     { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-1.5-flash' },
};

function getAIKeys() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key='ai_keys'`).get();
    return JSON.parse(row?.value || '[]');
  } catch { return []; }
}

function saveAIKeys(keys) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_keys', ?)`).run(JSON.stringify(keys));
}

function makeClientForKey(cfg) {
  const OpenAILib = require('openai');
  const Ctor = OpenAILib.default || OpenAILib.OpenAI || OpenAILib;
  const opts = { apiKey: cfg.key };
  const def = PROVIDER_DEFAULTS[cfg.provider] || PROVIDER_DEFAULTS.openrouter;
  const baseURL = cfg.baseURL || def.baseURL;
  if (baseURL) opts.baseURL = baseURL;
  return { client: new Ctor(opts), model: cfg.model || def.defaultModel };
}

function isCreditError(err) {
  const status = err?.status || err?.response?.status;
  const msg = String(err?.message || '');
  return status === 402 || status === 429 || /credits|quota|rate.?limit|exhausted/i.test(msg);
}

async function callWithFallback(payload) {
  const { openai, CHAT_MODEL } = require('./embeddings');
  const allKeys = [
    { id: '_env', active: true, _useEnv: true },
    ...getAIKeys().filter((k) => k.active),
  ];
  let lastErr;
  for (const cfg of allKeys) {
    try {
      if (cfg._useEnv) {
        return await openai.chat.completions.create({ ...payload, model: payload.model || CHAT_MODEL() });
      }
      const { client, model } = makeClientForKey(cfg);
      // A dashboard key uses its own model; the env model name may not exist
      // on that provider (e.g. openai/gpt-4o on Gemini).
      return await client.chat.completions.create({ ...payload, model });
    } catch (err) {
      if (isCreditError(err)) {
        console.warn(`[ai] key ${cfg.id} out of credit, trying next: ${String(err.message || err).slice(0, 120)}`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All AI keys exhausted');
}

module.exports = { PROVIDER_DEFAULTS, getAIKeys, saveAIKeys, makeClientForKey, callWithFallback };
