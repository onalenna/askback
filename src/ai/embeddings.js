const OpenAI = require('openai');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

let _openai = null;
let _whisper = null;

function usingOpenRouter() {
  return Boolean(String(process.env.OPENROUTER_API_KEY || '').trim());
}

/** Map short OpenAI model ids to OpenRouter slugs when needed. */
function resolveModel(shortName) {
  const name = String(shortName || '').trim();
  if (!name) return name;
  if (!usingOpenRouter()) return name;
  if (name.includes('/')) return name;
  return `openai/${name}`;
}

const CHAT_MODEL = () =>
  resolveModel(process.env.OPENROUTER_CHAT_MODEL || process.env.CHAT_MODEL || 'gpt-4o');
const CHAT_MODEL_MINI = () =>
  resolveModel(process.env.OPENROUTER_MINI_MODEL || process.env.CHAT_MODEL_MINI || 'gpt-4o-mini');
const EMBEDDING_MODEL = () =>
  resolveModel(process.env.EMBEDDING_MODEL || 'text-embedding-3-small');
const EMBEDDING_DIMENSIONS = 512;

function getClient() {
  if (!_openai) {
    if (usingOpenRouter()) {
      _openai = new OpenAI({
        apiKey: String(process.env.OPENROUTER_API_KEY).trim(),
        baseURL: OPENROUTER_BASE,
        defaultHeaders: {
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://127.0.0.1:3000',
          'X-Title': process.env.OPENROUTER_APP_NAME || 'askBack',
        },
      });
      console.log('[ai] using OpenRouter for chat + embeddings');
    } else {
      _openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      console.log('[ai] using OpenAI API');
    }
  }
  return _openai;
}

/** Whisper transcription stays on OpenAI when a key is available. */
function getWhisperClient() {
  const openAiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (openAiKey) {
    if (!_whisper) {
      _whisper = new OpenAI({ apiKey: openAiKey });
    }
    return _whisper;
  }
  return getClient();
}

// Back-compat for modules that import `{ openai }`
const openai = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = getClient();
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
  }
);

async function getEmbedding(text) {
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL(),
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

async function getEmbeddingsBatch(texts) {
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL(),
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  const map = {};
  response.data.forEach((item) => {
    map[item.index] = item.embedding;
  });
  return texts.map((_, i) => map[i]);
}

module.exports = {
  openai,
  getClient,
  getWhisperClient,
  getEmbedding,
  getEmbeddingsBatch,
  usingOpenRouter,
  resolveModel,
  CHAT_MODEL,
  CHAT_MODEL_MINI,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
