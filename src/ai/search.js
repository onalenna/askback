const {
  searchSimilarQuestions,
  searchKnowledgeBase,
} = require('../db/queries');

function searchAll(queryEmbedding, { loose = false } = {}) {
  const repeatThreshold = parseFloat(process.env.REPEAT_THRESHOLD || '0.82');
  const kbThreshold = loose
    ? Math.min(0.2, parseFloat(process.env.KB_MATCH_THRESHOLD || '0.45'))
    : parseFloat(process.env.KB_MATCH_THRESHOLD || '0.45');
  const topK = parseInt(process.env.TOP_K || '3', 10);

  let knowledge = searchKnowledgeBase(queryEmbedding, kbThreshold, topK);
  if (loose && !knowledge.length) {
    knowledge = searchKnowledgeBase(queryEmbedding, 0, topK);
  }

  return {
    repeated: searchSimilarQuestions(queryEmbedding, repeatThreshold),
    knowledge,
  };
}

module.exports = { searchAll };