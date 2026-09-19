const {
  searchSimilarQuestions,
  searchKnowledgeBase,
  searchKnowledgeText,
} = require('../db/queries');

function mergeHits(lexical, vector, limit) {
  const seen = new Set();
  const out = [];
  for (const hit of [...lexical, ...vector]) {
    if (!hit?.id || seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

function searchAll(queryEmbedding, { loose = false, query = '', limit } = {}) {
  const repeatThreshold = parseFloat(process.env.REPEAT_THRESHOLD || '0.82');
  const kbThreshold = loose
    ? Math.min(0.2, parseFloat(process.env.KB_MATCH_THRESHOLD || '0.45'))
    : parseFloat(process.env.KB_MATCH_THRESHOLD || '0.45');
  const configured = parseInt(process.env.TOP_K || '8', 10);
  const topK = limit || Math.max(configured || 0, 8);

  const vector = searchKnowledgeBase(queryEmbedding, kbThreshold, topK);
  let knowledge = vector;
  if (loose && !knowledge.length) {
    knowledge = searchKnowledgeBase(queryEmbedding, 0, topK);
  }
  if (query) {
    knowledge = mergeHits(searchKnowledgeText(query, topK), knowledge, topK);
  }

  return {
    repeated: searchSimilarQuestions(queryEmbedding, repeatThreshold),
    knowledge,
  };
}

module.exports = { searchAll };