const {
  searchSimilarQuestions,
  searchKnowledgeBase,
  searchKnowledgeText,
} = require('../db/queries');
const { kbMatchThreshold, repeatThreshold, topK } = require('./settings');

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
  const repeatThr = repeatThreshold();
  const kbBase = kbMatchThreshold();
  const kbThreshold = loose ? Math.min(0.2, kbBase) : kbBase;
  const configured = topK();
  const topKValue = limit || Math.max(configured || 0, 8);

  const vector = searchKnowledgeBase(queryEmbedding, kbThreshold, topKValue);
  let knowledge = vector;
  if (loose && !knowledge.length) {
    knowledge = searchKnowledgeBase(queryEmbedding, 0, topKValue);
  }
  if (query) {
    knowledge = mergeHits(searchKnowledgeText(query, topKValue), knowledge, topKValue);
  }

  return {
    repeated: searchSimilarQuestions(queryEmbedding, repeatThr),
    knowledge,
  };
}

module.exports = { searchAll };