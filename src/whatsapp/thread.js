const { looksLikeQuestion, looksLikeSameQuestion, isChitchat } = require('./intent');
const { repliesToId, recentChatLines } = require('./history');

const HUMAN_WAIT_MS = 12000;
const NEARBY_SECS = 90;

function fold(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function wordCount(text) {
  return fold(text).split(/\s+/).filter(Boolean).length;
}

function isYesNo(text) {
  return /^(yes|yeah|yep|yup|no|nope|nah|oui|non|sí|si|nao|não)\b/i.test(fold(text));
}

function quotesQuestion(line, questionText) {
  const q = fold(questionText);
  if (!q || !line) return false;
  const quoted = fold(line.quoted);
  if (!quoted) return false;
  if (quoted === q) return true;
  if (q.length >= 12 && (quoted.startsWith(q.slice(0, 80)) || q.startsWith(quoted.slice(0, 80)))) return true;
  return false;
}

function looksLikeHumanAnswer(text, quotedQuestion) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (looksLikeSameQuestion(t)) return false;
  if (looksLikeQuestion(t)) return false;
  if (isChitchat(t) && !isYesNo(t)) return false;
  if (isYesNo(t) && looksLikeQuestion(quotedQuestion || '')) return true;
  if (looksLikeQuestion(quotedQuestion || '') && wordCount(t) >= 2) return true;
  return wordCount(t) >= 4;
}

function relatedReplies(chatJid, questionId, questionText) {
  const seen = new Set();
  const out = [];
  for (const line of [...repliesToId(chatJid, questionId), ...recentChatLines(chatJid)]) {
    const key = line.id || `${line.ts}:${line.text}`;
    if (seen.has(key)) continue;
    if (questionId && line.id === questionId) continue;
    const replyToId = line.quotedId && questionId && line.quotedId === questionId;
    const replyToText = quotesQuestion(line, questionText);
    if (!replyToId && !replyToText) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function nearbyAfter(chatJid, questionLine) {
  const start = Number(questionLine?.ts || 0);
  if (!start) return [];
  return recentChatLines(chatJid).filter((line) => {
    if (questionLine.id && line.id === questionLine.id) return false;
    if (line.fromMe) return false;
    const ts = Number(line.ts || 0);
    return ts >= start && ts <= start + NEARBY_SECS;
  });
}

function humanAnsweredQuestion(chatJid, { questionId, questionText, askerName = '', questionTs = 0 }) {
  const questionLine = {
    id: questionId,
    text: questionText,
    ts: questionTs || recentChatLines(chatJid).find((line) => line.id === questionId)?.ts || 0,
    name: askerName,
  };

  for (const line of relatedReplies(chatJid, questionId, questionText)) {
    if (line.fromMe) return true;
    if (looksLikeHumanAnswer(line.text, questionText)) return true;
  }

  for (const line of nearbyAfter(chatJid, questionLine)) {
    if (askerName && line.name && line.name === askerName) continue;
    if (line.quoted && !quotesQuestion(line, questionText)) continue;
    if (looksLikeSameQuestion(line.text) || looksLikeQuestion(line.text)) continue;
    if (quotesQuestion(line, questionText) && looksLikeHumanAnswer(line.text, questionText)) return true;
    if (!line.quoted && looksLikeHumanAnswer(line.text, questionText) && wordCount(line.text) >= 4) return true;
  }
  return false;
}

function classifyGroupTurn({ text, quoted, tagged, fromMedia }) {
  if (tagged) return 'ask-bot';
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (fromMedia && looksLikeQuestion(body)) return 'open-question';
  if (!body) return 'skip';
  if (looksLikeSameQuestion(body)) return 'same-question';
  if (quoted && looksLikeQuestion(quoted) && !looksLikeQuestion(body) && !looksLikeSameQuestion(body)) {
    if (isChitchat(body) && !isYesNo(body)) return 'skip';
    return 'human-answer';
  }
  if (looksLikeQuestion(body)) return 'open-question';
  return 'skip';
}

module.exports = {
  HUMAN_WAIT_MS,
  looksLikeHumanAnswer,
  humanAnsweredQuestion,
  classifyGroupTurn,
};
