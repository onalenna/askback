const { resolveReplyLanguage, looksEnglish, languageName } = require('../ai/language');
const { isChitchat } = require('./intent');

const TTL_MS = 8 * 60 * 1000;
const pending = new Map();

function prune(now = Date.now()) {
  for (const [jid, offer] of pending) {
    if (now - offer.at > TTL_MS) pending.delete(jid);
  }
}

function getOffer(chatJid) {
  prune();
  return pending.get(chatJid) || null;
}

function clearOffer(chatJid) {
  pending.delete(chatJid);
}

function setOffer(chatJid, offer) {
  pending.set(chatJid, { ...offer, at: Date.now() });
}

function wordCount(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function detectNonEnglish(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t)) return '';
  if (/^https?:\/\//i.test(t) && wordCount(t) <= 2) return '';
  if (looksEnglish(t)) return '';
  const lang = resolveReplyLanguage(t);
  if (!lang || lang === 'en') return '';
  if (wordCount(t) < 2) return '';
  return lang;
}

function wantsTranslation(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .trim();
  if (!t) return false;
  if (
    /^(yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|alright|right)\b/.test(t)
  ) {
    return true;
  }
  return /\b(translate|translation|english)\b/.test(t) && !/\bno\b/.test(t);
}

function declinesTranslation(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .trim();
  if (!t) return false;
  return /^(no|nope|nah|no thanks|no thank you|don't|dont)\b/.test(t);
}

function offerText(lang) {
  if (lang && lang !== 'und') {
    return `That looks like ${languageName(lang)}. Does anyone want an English translation?`;
  }
  return "That doesn't look like English. Does anyone want me to translate it to English?";
}

module.exports = {
  getOffer,
  setOffer,
  clearOffer,
  detectNonEnglish,
  wantsTranslation,
  declinesTranslation,
  offerText,
};
