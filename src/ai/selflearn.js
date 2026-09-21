'use strict';
/**
 * Self-learning loop — lets admins approve or correct bot answers.
 *
 * When an answer is marked 'good' or corrected, the Q+A pair is embedded and
 * stored as a knowledge chunk. Next time a similar question comes in,
 * searchSimilarQuestions() finds the approved answer before the bot generates
 * a new one — giving faster, cheaper, and more consistent replies over time.
 *
 * The learned chunk is tagged with source='learned' and a synthetic document
 * row so the KB can display and manage it from the Knowledge page.
 */

const crypto = require('crypto');
const { getEmbeddingsBatch } = require('./embeddings');
const { invalidateChunkCache } = require('../db/queries');

function getDb() { return require('../db/index'); }

async function learnFromQA(qaId, overrideAnswer) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM qa_history WHERE id = ?`).get(qaId);
  if (!row) throw new Error('QA record not found');
  if (row.learned) return { alreadyLearned: true };

  const question = String(row.question || '').trim();
  const answer   = String(overrideAnswer || row.corrected_answer || row.answer || '').trim();
  if (!question || !answer) throw new Error('Question or answer is empty');

  const content = `Q: ${question}\nA: ${answer}`;
  const title   = `Learned: ${question.slice(0, 60)}${question.length > 60 ? '…' : ''}`;
  const hash    = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

  // Create or reuse a synthetic document for learned answers.
  let docId = db.prepare(
    `SELECT id FROM documents WHERE type = 'learned' AND title = ? LIMIT 1`
  ).get('Learned answers')?.id;

  if (!docId) {
    docId = db.prepare(
      `INSERT INTO documents (filename, type, status, title) VALUES (?, 'learned', 'ready', 'Learned answers')`
    ).run('learned-answers.txt').lastInsertRowid;
  }

  // Embed the Q+A content.
  const [embedding] = await getEmbeddingsBatch([content]);

  // Insert as a knowledge chunk.
  db.prepare(
    `INSERT OR IGNORE INTO chunks (document_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)`
  ).run(docId, Number(hash.slice(0, 8), 16) % 1000000, content, JSON.stringify(embedding));

  // Update the document's chunk_count.
  const chunkCount = db.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?`).get(docId).c;
  db.prepare(`UPDATE documents SET chunk_count = ?, status = 'ready' WHERE id = ?`).run(chunkCount, docId);

  // Mark the QA row as learned.
  db.prepare(
    `UPDATE qa_history SET learned = 1, feedback = COALESCE(feedback,'good'), corrected_answer = ? WHERE id = ?`
  ).run(overrideAnswer || null, qaId);

  invalidateChunkCache();
  return { learned: true, docId, chunkContent: content };
}

module.exports = { learnFromQA };
