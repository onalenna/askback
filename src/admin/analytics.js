const db = require('../db');

/**
 * Admin analytics, computed with SQL aggregates over the tables the bot
 * already fills: qa_history (every answer), chat_messages (per-group traffic),
 * documents / chunks (the knowledge base).
 *
 * Data honesty notes for whoever reads these numbers:
 * - "Members" means people whose messages the bot has SEEN, not the full group
 *   roster (WhatsApp does not hand us the member list here).
 * - Names are WhatsApp display names, which people can change.
 * - chat_messages is capped per chat (see history.js MAX_LINES), so very old
 *   traffic ages out; treat message counts as "recent activity", not all-time.
 */

/** Wrap a query so one bad statement never blanks the whole dashboard. */
function safe(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.warn('[analytics] query failed:', err.message || err);
    return fallback;
  }
}

/** Group a JID into a readable label using the most recent name we stored. */
function groupLabel(jid) {
  const row = db
    .prepare(
      `SELECT group_name FROM qa_history WHERE group_jid = ? AND group_name != '' ORDER BY created_at DESC LIMIT 1`
    )
    .get(jid);
  return row?.group_name || jid;
}

/** High-level totals for the summary cards. */
function totals() {
  return safe(
    () => ({
      totalQuestions: db.prepare(`SELECT COUNT(*) AS c FROM qa_history`).get().c,
      questionsToday: db
        .prepare(`SELECT COUNT(*) AS c FROM qa_history WHERE date(created_at) = date('now')`)
        .get().c,
      questions7d: db
        .prepare(`SELECT COUNT(*) AS c FROM qa_history WHERE created_at >= datetime('now','-7 days')`)
        .get().c,
      documents: db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE type != 'sticker'`).get().c,
      chunks: db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get().c,
      trackedMessages: db.prepare(`SELECT COUNT(*) AS c FROM chat_messages`).get().c,
      activeMembers: db
        .prepare(`SELECT COUNT(DISTINCT sender_name) AS c FROM chat_messages WHERE from_me = 0 AND sender_name != ''`)
        .get().c,
      activeChats: db.prepare(`SELECT COUNT(DISTINCT chat_jid) AS c FROM chat_messages`).get().c,
    }),
    {}
  );
}

/** Where answers came from: generated / reused / help / etc. */
function answerSources() {
  return safe(
    () =>
      db
        .prepare(`SELECT source, COUNT(*) AS count FROM qa_history GROUP BY source ORDER BY count DESC`)
        .all(),
    []
  );
}

/** Questions per day for the last 14 days (for a simple trend bar chart). */
function questionsPerDay() {
  return safe(
    () =>
      db
        .prepare(
          `SELECT date(created_at) AS day, COUNT(*) AS count
           FROM qa_history
           WHERE created_at >= datetime('now','-14 days')
           GROUP BY day ORDER BY day ASC`
        )
        .all(),
    []
  );
}

/** Busiest hours of the day across all tracked messages (0-23, UTC stored). */
function busiestHours() {
  return safe(
    () =>
      db
        .prepare(
          `SELECT CAST(strftime('%H', datetime(ts, 'unixepoch')) AS INTEGER) AS hour,
                  COUNT(*) AS count
           FROM chat_messages
           WHERE ts > 0
           GROUP BY hour ORDER BY hour ASC`
        )
        .all(),
    []
  );
}

/** Most active members by message count (seen participants only). */
function topMembers(limit = 10) {
  return safe(
    () =>
      db
        .prepare(
          `SELECT sender_name AS name, COUNT(*) AS messages
           FROM chat_messages
           WHERE from_me = 0 AND sender_name != ''
           GROUP BY sender_name ORDER BY messages DESC LIMIT ?`
        )
        .all(limit),
    []
  );
}

/** Per-group activity: messages tracked and questions answered. */
function groupActivity(limit = 10) {
  return safe(() => {
    const rows = db
      .prepare(
        `SELECT chat_jid AS jid, COUNT(*) AS messages,
                MAX(ts) AS lastTs
         FROM chat_messages
         GROUP BY chat_jid ORDER BY messages DESC LIMIT ?`
      )
      .all(limit);
    return rows.map((r) => ({
      name: groupLabel(r.jid),
      messages: r.messages,
      questions: db
        .prepare(`SELECT COUNT(*) AS c FROM qa_history WHERE group_jid = ?`)
        .get(r.jid).c,
      lastActive: r.lastTs ? new Date(r.lastTs * 1000).toISOString() : null,
    }));
  }, []);
}

/** Documents referenced most often as an answer source. */
function topDocuments(limit = 10) {
  return safe(
    () =>
      db
        .prepare(
          `SELECT d.title AS title, d.filename AS filename, d.type AS type,
                  COUNT(q.id) AS uses
           FROM documents d
           LEFT JOIN qa_history q ON q.document_id = d.id
           WHERE d.type != 'sticker'
           GROUP BY d.id ORDER BY uses DESC LIMIT ?`
        )
        .all(limit),
    []
  );
}

/**
 * Recent questions the bot answered with LOW confidence — these point at gaps
 * in the knowledge base (topics people ask about but nothing covers well).
 */
function knowledgeGaps(limit = 10) {
  return safe(
    () =>
      db
        .prepare(
          `SELECT question, similarity_score AS score, group_name AS groupName, created_at AS at
           FROM qa_history
           WHERE source = 'generated'
             AND similarity_score IS NOT NULL
             AND similarity_score < 0.5
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(limit),
    []
  );
}

/** Most-reused answers (source='repeat') — the FAQs of the group. */
function topRepeatedQuestions(limit = 10) {
  return safe(
    () =>
      db
        .prepare(
          `SELECT question, COUNT(*) AS timesAnswered
           FROM qa_history
           GROUP BY lower(trim(question))
           HAVING timesAnswered > 1
           ORDER BY timesAnswered DESC LIMIT ?`
        )
        .all(limit),
    []
  );
}

/** Assemble the full analytics payload for the admin dashboard. */
function buildAnalytics() {
  return {
    generatedAt: new Date().toISOString(),
    totals: totals(),
    answerSources: answerSources(),
    questionsPerDay: questionsPerDay(),
    busiestHours: busiestHours(),
    topMembers: topMembers(),
    groupActivity: groupActivity(),
    topDocuments: topDocuments(),
    knowledgeGaps: knowledgeGaps(),
    topRepeatedQuestions: topRepeatedQuestions(),
  };
}

module.exports = { buildAnalytics };
