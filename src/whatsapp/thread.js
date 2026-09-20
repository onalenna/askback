const { looksLikeQuestion, looksLikeSameQuestion, isChitchat, isFollowUp } = require('./intent');
const { repliesToId, recentChatLines } = require('./history');

const HUMAN_WAIT_MS = 12000;
const NEARBY_SECS = 90;
const TAG_LOOKBACK_SECS = 20 * 60;
const ANY_QUESTION_SECS = 3 * 60;

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
  if (q.length >= 12 && (quoted.startsWith(q.slice(0, 80)) || q.startsWith(quoted.slice(0, 80)))) {
    return true;
  }
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
    if (!line.quoted && looksLikeHumanAnswer(line.text, questionText) && wordCount(line.text) >= 4) {
      return true;
    }
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

/** Bare "@askBack" / "please" / "this" after someone already asked in the group. */
function isThinTagAsk(text) {
  const t = String(text || '')
    .replace(/@\d+/g, ' ')
    .replace(/@(askback|askbak)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return true;
  if (looksLikeSameQuestion(t)) return true;
  if (/^(please|pls|plz|help|thanks|thank you|here|this|that|ok|okay|now|again|\?+)$/i.test(t)) {
    return true;
  }
  if (wordCount(t) <= 2 && !looksLikeQuestion(t)) return true;
  return false;
}

function sameSender(line, msg) {
  if (!line || !msg) return false;
  const myName = fold(msg.pushName || '');
  if (myName && fold(line.name || '') === myName) return true;
  const mine =
    msg.key?.participantPn ||
    msg.key?.participant ||
    msg.key?.participantLid ||
    msg.participant ||
    '';
  const theirs = String(line.participant || '');
  if (!mine || !theirs) return false;
  const a = String(mine).split('@')[0].split(':')[0];
  const b = String(theirs).split('@')[0].split(':')[0];
  return Boolean(a && b && a === b);
}

function usefulPriorText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t)) return false;
  if (looksLikeQuestion(t)) return true;
  return wordCount(t) >= 4;
}

/**
 * When someone asks in the group without tagging, then later tags askBack,
 * recover the earlier ask (or the message they replied to).
 */
function findPriorAsk(chatJid, msg, excludeId) {
  const now = Number(msg.messageTimestamp || Date.now() / 1000);
  const lines = recentChatLines(chatJid, excludeId)
    .filter((line) => !line.fromMe)
    .slice()
    .reverse();

  let sameSenderAsk = null;
  let recentOpenAsk = null;

  for (const line of lines) {
    const age = now - Number(line.ts || 0);
    if (age < 0 || age > TAG_LOOKBACK_SECS) continue;
    if (!usefulPriorText(line.text)) continue;

    if (sameSender(line, msg) && !sameSenderAsk) {
      sameSenderAsk = line;
    }
    if (!recentOpenAsk && looksLikeQuestion(line.text) && age <= ANY_QUESTION_SECS) {
      recentOpenAsk = line;
    }
    if (sameSenderAsk && recentOpenAsk) break;
  }

  return sameSenderAsk || recentOpenAsk || null;
}

function needsPriorContext(question, quoted) {
  const q = String(question || '').trim();
  const quote = String(quoted || '').trim();
  if (quote && usefulPriorText(quote) && isThinTagAsk(q)) return false;
  if (isThinTagAsk(q)) return true;
  if (isFollowUp(q) || looksLikeSameQuestion(q)) return true;
  if (/^(send|share|give|show|get|find|repeat|check|remind)\b/i.test(q) && wordCount(q) <= 6) {
    return true;
  }
  return false;
}

/**
 * Expand a late @askBack tag using the quoted message or a recent prior ask.
 */
function resolveTagContext({ chatJid, msg, question = '', quoted = '', tagged = false } = {}) {
  let nextQuestion = String(question || '').trim();
  let nextQuoted = String(quoted || '').trim();
  if (!tagged) return { question: nextQuestion, quoted: nextQuoted, fromPrior: false };

  if (nextQuoted && usefulPriorText(nextQuoted) && isThinTagAsk(nextQuestion)) {
    return { question: nextQuoted, quoted: '', fromPrior: true };
  }

  if (!needsPriorContext(nextQuestion, nextQuoted)) {
    return { question: nextQuestion, quoted: nextQuoted, fromPrior: false };
  }

  const prior = findPriorAsk(chatJid, msg, msg?.key?.id);
  if (!prior?.text) {
    if (nextQuoted && usefulPriorText(nextQuoted) && isThinTagAsk(nextQuestion)) {
      return { question: nextQuoted, quoted: '', fromPrior: true };
    }
    return { question: nextQuestion, quoted: nextQuoted, fromPrior: false };
  }

  if (isThinTagAsk(nextQuestion)) {
    return {
      question: String(prior.text).trim(),
      quoted: nextQuoted && nextQuoted !== prior.text ? nextQuoted : String(prior.quoted || '').trim(),
      fromPrior: true,
    };
  }

  return {
    question: nextQuestion,
    quoted: nextQuoted || String(prior.text).trim(),
    fromPrior: true,
  };
}

module.exports = {
  HUMAN_WAIT_MS,
  looksLikeHumanAnswer,
  humanAnsweredQuestion,
  classifyGroupTurn,
  isThinTagAsk,
  findPriorAsk,
  resolveTagContext,
};
