const OpenAI = require('openai');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 512;

let _openai = null;

function getClient() {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return _openai;
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
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

async function getEmbeddingsBatch(texts) {
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
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
  getEmbedding,
  getEmbeddingsBatch,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
