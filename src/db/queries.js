const db = require('./index');

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const statements = {
  insertQA: db.prepare(`
    INSERT INTO qa_history (group_jid, group_name, question, answer, similarity_score, source, document_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  deleteQA: db.prepare(`DELETE FROM qa_history WHERE id = ?`),
  updateQA: db.prepare(`UPDATE qa_history SET answer = ? WHERE id = ?`),
  getQAById: db.prepare(`SELECT * FROM qa_history WHERE id = ?`),
  allQA: db.prepare(`SELECT * FROM qa_history ORDER BY created_at DESC`),
  qaByGroup: db.prepare(`SELECT * FROM qa_history WHERE group_jid = ? ORDER BY created_at DESC`),
  qaSearch: db.prepare(`
    SELECT * FROM qa_history
    WHERE question LIKE ? OR answer LIKE ?
    ORDER BY created_at DESC
  `),
  recentQA: db.prepare(`SELECT * FROM qa_history ORDER BY created_at DESC LIMIT ?`),

  insertDoc: db.prepare(
    `INSERT INTO documents (filename, type, status, file_path, mime_type, title) VALUES (?, ?, 'processing', ?, ?, ?)`
  ),
  updateDocStatus: db.prepare(`UPDATE documents SET status = ?, error = ? WHERE id = ?`),
  updateDocChunks: db.prepare(`UPDATE documents SET chunk_count = ?, status = 'ready' WHERE id = ?`),
  updateDocFile: db.prepare(`UPDATE documents SET file_path = ?, mime_type = ? WHERE id = ?`),
  updateDocFilename: db.prepare(`UPDATE documents SET filename = ? WHERE id = ?`),
  updateDocTitle: db.prepare(`UPDATE documents SET title = ? WHERE id = ?`),
  updateDocMeta: db.prepare(
    `UPDATE documents SET filename = ?, type = ?, file_path = ?, mime_type = ?, status = ?, error = ?, chunk_count = ? WHERE id = ?`
  ),
  getDoc: db.prepare(`SELECT * FROM documents WHERE id = ?`),
  allDocs: db.prepare(`SELECT * FROM documents ORDER BY created_at DESC`),
  allKnowledgeDocs: db.prepare(
    `SELECT * FROM documents WHERE type != 'sticker' ORDER BY created_at DESC`
  ),
  allStickers: db.prepare(
    `SELECT * FROM documents WHERE type = 'sticker' ORDER BY created_at DESC`
  ),
  // Newest uploaded call/meeting recording that has been processed into chunks.
  // Used by the "what did I miss in the last meeting" answer path.
  newestMeetingDoc: db.prepare(
    `SELECT * FROM documents
     WHERE type IN ('audio', 'video')
       AND chunk_count > 0
     ORDER BY created_at DESC
     LIMIT 1`
  ),
  deleteDoc: db.prepare(`DELETE FROM documents WHERE id = ?`),

  insertChunk: db.prepare(
    `INSERT INTO chunks (document_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)`
  ),
  chunkIdsByDoc: db.prepare(`SELECT id FROM chunks WHERE document_id = ?`),
  deleteChunksByDoc: db.prepare(`DELETE FROM chunks WHERE document_id = ?`),
  deleteQAByDoc: db.prepare(`DELETE FROM qa_history WHERE document_id = ?`),
  allChunks: db.prepare(`SELECT id, document_id, content, embedding FROM chunks`),
  chunksByDoc: db.prepare(
    `SELECT id, document_id, content FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC LIMIT ?`
  ),
  allChunksByDoc: db.prepare(
    `SELECT chunk_index, content FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC`
  ),
  chunkById: db.prepare(`SELECT * FROM chunks WHERE id = ?`),
  deleteChunk: db.prepare(`DELETE FROM chunks WHERE id = ?`),

  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),

  upsertChatMessage: db.prepare(`
    INSERT INTO chat_messages (chat_jid, msg_id, from_me, sender_name, body, quoted, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid, msg_id) DO UPDATE SET
      from_me = excluded.from_me,
      sender_name = CASE
        WHEN excluded.sender_name != '' THEN excluded.sender_name
        ELSE chat_messages.sender_name
      END,
      body = excluded.body,
      quoted = excluded.quoted,
      ts = excluded.ts
  `),
  chatMessagesByChat: db.prepare(`
    SELECT chat_jid, msg_id, from_me, sender_name, body, quoted, ts
    FROM chat_messages
    WHERE chat_jid = ?
    ORDER BY ts DESC
    LIMIT ?
  `),
  chatMessagesInRange: db.prepare(`
    SELECT chat_jid, msg_id, from_me, sender_name, body, quoted, ts
    FROM chat_messages
    WHERE chat_jid = ?
      AND ts >= ?
      AND ts < ?
    ORDER BY ts ASC
    LIMIT ?
  `),
  chatMessageCount: db.prepare(`SELECT COUNT(*) AS c FROM chat_messages WHERE chat_jid = ?`),
  pruneChatMessages: db.prepare(`
    DELETE FROM chat_messages
    WHERE chat_jid = ?
      AND msg_id NOT IN (
        SELECT msg_id FROM chat_messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?
      )
  `),
};

const stats = {
  totalQA: db.prepare(`SELECT COUNT(*) AS c FROM qa_history`).get().c,
  todayQA: db.prepare(
    `SELECT COUNT(*) AS c FROM qa_history WHERE date(created_at) = date('now')`
  ).get().c,
  totalDocs: db.prepare(`SELECT COUNT(*) AS c FROM documents`).get().c,
  totalChunks: db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get().c,
  bySource: db.prepare(`
    SELECT source, COUNT(*) AS c FROM qa_history GROUP BY source
  `).all(),
};

function getQAEmbeddings() {
  return db
    .prepare(`SELECT id, question, answer, embedding, document_id FROM qa_history WHERE embedding IS NOT NULL`)
    .all();
}

function setQAEmbedding(id, embedding) {
  db.prepare(`UPDATE qa_history SET embedding = ? WHERE id = ?`).run(
    JSON.stringify(embedding),
    id
  );
}

function searchSimilarQuestions(queryEmbedding, threshold, limit = 5) {
  const rows = getQAEmbeddings();
  return rows
    .map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      document_id: row.document_id,
      score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)),
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * In-memory cache of parsed chunk embeddings.
 *
 * Without this, every question loaded ALL chunk rows from SQLite and JSON.parsed
 * every embedding — tens of MB of work per query, which is the main thing that
 * made bursts of simultaneous questions slow. We parse once, keep the vectors as
 * plain arrays, and reload only when the chunk set actually changes.
 *
 * Change detection is cheap and does not need every writer to call us: we
 * compare a lightweight signature (row count + max id) against the last load.
 * Inserts bump the count and/or max id; deletes change the count. That covers
 * ingest (add), replace (delete+add), and document delete.
 */
let _chunkCache = { sig: null, rows: [] };

function chunkSignature() {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM chunks`).get();
    return `${row.c}:${row.m}`;
  } catch {
    return null;
  }
}

/** Return chunks as { id, document_id, content, vec:number[] }, cached. */
function getChunkVectors() {
  const sig = chunkSignature();
  if (sig !== null && sig === _chunkCache.sig) return _chunkCache.rows;

  const raw = db
    .prepare(`SELECT id, document_id, content, embedding FROM chunks WHERE embedding IS NOT NULL`)
    .all();
  const rows = [];
  for (const r of raw) {
    let vec;
    try {
      vec = JSON.parse(r.embedding);
    } catch {
      continue; // skip a corrupt row rather than fail the whole search
    }
    rows.push({ id: r.id, document_id: r.document_id, content: r.content, vec });
  }
  _chunkCache = { sig, rows };
  return rows;
}

/** Force a cache reload on the next search (e.g. after a bulk change). */
function invalidateChunkCache() {
  _chunkCache = { sig: null, rows: [] };
}

function searchKnowledgeBase(queryEmbedding, threshold, limit = 5) {
  return getChunkVectors()
    .map((row) => ({
      id: row.id,
      document_id: row.document_id,
      content: row.content,
      score: cosineSimilarity(queryEmbedding, row.vec),
    }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const SEARCH_STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'from', 'anyone', 'anybody', 'someone', 'somebody', 'there', 'who', 'what',
  'when', 'where', 'why', 'how', 'which', 'does', 'did', 'can', 'could',
  'would', 'will', 'this', 'that', 'these', 'those', 'have', 'has', 'had',
  'about', 'with', 'for', 'and', 'or', 'of', 'in', 'on', 'to', 'do', 'i',
  'me', 'we', 'you', 'they', 'them', 'please', 'tell', 'know', 'any',
  'there', 'here', 'just', 'also', 'into', 'our', 'your', 'their',
]);

function queryTerms(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z0-9']+/g) || [];
  return [...new Set(words.filter((w) => w.length >= 3 && !SEARCH_STOP.has(w)))];
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchKnowledgeText(question, limit = 16) {
  const terms = queryTerms(question);
  if (!terms.length) return [];
  const phrase = String(question || '')
    .toLowerCase()
    .replace(/[?!.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const termRes = terms.map((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'));
  const rows = getChunkVectors();
  return rows
    .map((row) => {
      const content = String(row.content || '');
      const lower = content.toLowerCase();
      let hits = 0;
      for (let i = 0; i < terms.length; i += 1) {
        if (termRes[i].test(content)) hits += 1;
        if (lower.includes(`from ${terms[i]}`)) hits += 2;
      }
      if (!hits) return null;
      if (phrase.length >= 8 && lower.includes(phrase)) hits += 3;
      if (/\b(my name is|i am|i'm|i’m)\b/i.test(content)) hits += 1;
      return {
        id: row.id,
        document_id: row.document_id,
        content: row.content,
        score: 0.55 + Math.min(hits, 8) * 0.08,
        hits,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.hits - a.hits || b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  statements,
  stats,
  cosineSimilarity,
  searchSimilarQuestions,
  searchKnowledgeBase,
  searchKnowledgeText,
  setQAEmbedding,
  invalidateChunkCache,
};