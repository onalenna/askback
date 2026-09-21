'use strict';
/**
 * Lightweight sentiment classifier for WhatsApp group messages.
 *
 * Runs async after each answer is stored — never blocks the reply path.
 * Uses the mini model (Nova Micro / Haiku) for cost ~$0.001 per 1000 calls.
 *
 * Returns one of: confused | satisfied | frustrated | curious | neutral
 */

const { runAi } = require('./limiter');

const LABELS = ['confused', 'satisfied', 'frustrated', 'curious', 'neutral'];

const PROMPT = `Classify the sentiment of this user question in one word.
Choose exactly one from: confused, satisfied, frustrated, curious, neutral.
Respond with only the single word — no explanation.

Question: `;

async function classifySentiment(question) {
  if (!question || String(question).trim().length < 3) return 'neutral';
  try {
    const { openai, CHAT_MODEL_MINI } = require('./embeddings');
    const model = typeof CHAT_MODEL_MINI === 'function' ? CHAT_MODEL_MINI() : CHAT_MODEL_MINI;
    const result = await runAi(() =>
      openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: PROMPT + String(question).slice(0, 300) }],
        temperature: 0,
      })
    );
    const raw = String(result?.choices?.[0]?.message?.content || '').toLowerCase().trim();
    const match = LABELS.find((l) => raw.includes(l));
    return match || 'neutral';
  } catch {
    return 'neutral';
  }
}

/**
 * Run sentiment analysis asynchronously — does not block the caller.
 * Stores the result directly on the qa_history row.
 */
function classifyAsync(qaId, question) {
  if (!qaId || !question) return;
  setImmediate(async () => {
    try {
      const sentiment = await classifySentiment(question);
      const db = require('../db/index');
      db.prepare(`UPDATE qa_history SET sentiment = ? WHERE id = ?`).run(sentiment, qaId);
    } catch { /* non-critical — ignore */ }
  });
}

module.exports = { classifySentiment, classifyAsync };
