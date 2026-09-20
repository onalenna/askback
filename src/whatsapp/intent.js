const { listAdmins } = require('./admins');
const { phrase } = require('../ai/language');

const CHITCHAT = new Set([
  'ok',
  'okay',
  'k',
  'kk',
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'thanks',
  'thank you',
  'ty',
  'cool',
  'sure',
  'hold on',
  'wait',
  'hi',
  'hello',
  'hey',
  'gm',
  'good morning',
  'good evening',
  'lol',
  'haha',
  'noted',
  'alright',
  'i am',
  'on this group',
  'oui',
  'non',
  'merci',
  "d'accord",
  'daccord',
  'okey',
  'gracias',
  'vale',
  'sí',
  'si',
  'obrigado',
  'obrigada',
  'grazie',
  'prego',
  'got it',
  'makes sense',
  'sounds good',
  'will do',
  'on it',
  'nice',
  'great',
  'perfect',
  'same',
  'me too',
  'true',
  'exactly',
  'indeed',
  'fair',
  'bet',
  'done',
  'checked',
]);

function isChitchat(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .trim();
  return CHITCHAT.has(t);
}

/** Short acknowledgements / status updates — not questions for the bot. */
function isCasualTalk(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!,…]+$/g, '')
    .trim();
  if (!t || t.includes('?')) return false;
  if (isChitchat(t)) return true;
  if (t.length > 160) return false;
  if (
    /^(will check|i('ll| will) check|checking( it)?( out)?|got it|sounds good|makes sense|fair enough|noted|on it|will do|i('ll| will) (do|look|see|check|try)|looking into|coming|same here|me too|true that|exactly|indeed|bet|done|checked|will look|i see|ah ok|ah okay|right|yep|yup|cool cool|nice one|well said|agree|agreed|same)\b/i.test(
      t
    )
  ) {
    return true;
  }
  // Status / feedback to the group, not an ask for the bot
  if (
    /^(hi|hey|hello|hiya)\b.{0,24}\b(team|guys|all|everyone|folks)\b/i.test(t) &&
    !/\b(who|what|when|where|why|how|which|can you|could you|please|anyone)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function isDocSummaryRequest(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (!/\b(summar(y|ise|ize)|overview|tl;dr|tldr|key points|main points|brief me|recap (the|this) (doc|file|pdf|document))\b/i.test(t)) {
    return false;
  }
  if (/\b(document|file|pdf|doc|paper|report|notes?|attachment|media|this)\b/i.test(t)) return true;
  if (/\b(chat|group|conversation|messages?|thread)\b/i.test(t)) return false;
  return true;
}

function isTranslateRequest(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return /\b(translate|translation|traduis|traduire|traduction|traduce|traducir|traducción|übersetz|ubersetz)\b/i.test(
    t
  );
}

/** Summary, translation, explain, extract — work on a document/file. */
function isDocWorkRequest(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (isDocSummaryRequest(t) || isTranslateRequest(t)) return true;
  if (
    /\b(explain|analyse|analyze|extract|read|what does (this|it|the) (say|mean)|tell me (about|what)|go through)\b/i.test(
      t
    ) &&
    /\b(document|file|pdf|doc|paper|report|attachment|this|it)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function isAboutChat(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t)) return false;
  if (/\b(photo|image|picture|pic|pics|screenshot|this photo|this image|this picture)\b/i.test(t)) {
    return false;
  }
  if (isDocSummaryRequest(t) || isDocWorkRequest(t) || isTranslateRequest(t)) return false;
  return (
    /\b(recap|last message|previous message|in this (group|chat)|on (this|the) group|what has been discussed|what'?s been discussed|whats been discussed|since (the group|we) started|from the (start|beginning)|so far in (the|this) (chat|group))\b/i.test(
      t
    ) ||
    /\b(said|mention(ed)?|talked|discussed|this chat|this group|have we|did we|did anyone|what did we|who asked|already answered|what have we been talking)\b/i.test(
      t
    )
  );
}

function needsBroadKnowledge(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t)) return false;
  if (/\b(anyone|anybody|somebody)\s+(from|in)\b/i.test(t)) return true;
  if (/\bis there anyone\b/i.test(t)) return true;
  if (/\bwho('?s| is)?\s+from\b/i.test(t)) return true;
  if (/\bpeople\s+from\b/i.test(t)) return true;
  if (/\bwho (is|are)\b/i.test(t)) return true;
  if (/\bfrom\s+[A-Z][a-zA-Z]+\b/.test(text || '')) return true;
  // Links / class materials should always search the full knowledge set
  if (
    /\b(links?|urls?|class(es)?|recordings?|materials?|resources?|slides?|forms?|deadlines?|schedules?|zoom|meet|drive|docs?)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(give|send|share|show|get|find|where|what)\b.+\b(link|class|recording|material|resource|form)\b/i.test(t)) {
    return true;
  }
  return false;
}

function looksLikeQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (isChitchat(t) || isCasualTalk(t)) return false;
  if (t.includes('?')) return true;
  if (isAboutChat(t)) return true;
  if (isDocSummaryRequest(t)) return true;
  if (isDocWorkRequest(t)) return true;
  // Media / file asks should wake the bot even without a tag
  if (
    /\b(send|share|attach|give)\b/i.test(t) &&
    /\b(file|files|pdf|photo|photos|image|images|pic|pics|media|document|recording|audio|video|slide|slides)\b/i.test(
      t
    )
  ) {
    return true;
  }
  // Direct requests to someone (often the bot when tagged)
  if (/\b(can you|could you|would you|will you|do you|does anyone|anyone know|has anyone|is there|are there)\b/i.test(t)) {
    return true;
  }
  if (/\b(please)\b/i.test(t) && /\b(send|share|give|tell|explain|remind|recap|summar)/i.test(t)) {
    return true;
  }
  // Interrogative starters only — not bare will/is/are/can (those catch statements like "will check it out")
  if (
    /^(who|what|whats|what's|when|where|why|how|which|please|tell|explain|send|share|give|repeat|recap|remind|summarise|summarize|qui|que|quoi|quand|où|ou|pourquoi|comment|peux-tu|peut-on|est-ce|quién|quien|qué|cuando|cuándo|dónde|donde|por qué|porque|cómo|como|quem|quando|onde|chi|cosa|dove|perché|perche|a o|o ka|ke kopa|naa)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(who|what|when|where|why|how|which)\b/i.test(t) && t.split(/\s+/).length >= 4) {
    return true;
  }
  return false;
}

/**
 * Stricter gate for untagged group messages: only clear asks, not casual chat.
 * Tagged messages still use looksLikeQuestion / full answer path.
 */
function looksLikeClearQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (isChitchat(t) || isCasualTalk(t)) return false;
  // A lone "?" is not enough in groups — too many rhetorical / human-to-human lines
  if (isKnowledgeAsk(t)) return true;
  if (isAboutChat(t) || isDocSummaryRequest(t) || isDocWorkRequest(t) || isTranslateRequest(t)) {
    return true;
  }
  if (
    /\b(can you|could you|would you|will you|do you know|does anyone|anyone know|has anyone)\b/i.test(t) &&
    t.split(/\s+/).length >= 4
  ) {
    return true;
  }
  if (
    /^(who|what|whats|what's|when|where|why|how|which|qui|que|quoi|quand|où|pourquoi|comment|est-ce|quién|qué|cuándo|dónde|como|quando|onde|chi|cosa|dove|perché|a o|ke kopa)\b/i.test(
      t
    ) &&
    t.includes('?')
  ) {
    return true;
  }
  return false;
}

/**
 * Untagged group: only answer if this is clearly a knowledge / materials ask.
 * People chatting (even with "?" or "why/when" in a sentence) should not wake the bot.
 */
function isKnowledgeAsk(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t) || isCasualTalk(t)) return false;
  if (isDocWorkRequest(t) || isDocSummaryRequest(t) || isTranslateRequest(t)) return true;

  const wantsFile =
    /\b(send|share|attach|give|envoie|envoy[ée]s?|envoyer|manda|env[ií]a|passe[- ]moi|envoie[- ]moi|m[' ]envoyer|peux|pouvez)\b/i.test(
      t
    ) &&
    /\b(file|files|pdf|photo|photos|image|images|pic|pics|media|document|recording|audio|video|slide|slides|link|links|guide|guidelines?|fichier|fichiers|documento|archivos?)\b/i.test(
      t
    );
  if (wantsFile) return true;

  const topic =
    /\b(deadline|deadlines|due date|due dates|schedule|schedules|timetable|zoom|meet(ing)?s?|class(es)?|recording|recordings|slides?|materials?|resources?|form(s)?|assignment(s)?|homework|hackathon|link|links|url|urls|drive|docs?)\b/i.test(
      t
    );
  if (!topic) return false;

  // Must look like an ask about those materials — not a status update that happens to mention them
  if (t.includes('?')) return true;
  if (
    /\b(where (is|are|can)|what('?s| is) the|is there|are there|do we have|do i (need|have)|can you|could you|please (send|share|give)|how (do|can|to)|when (is|are|do)|which)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /^(where|what|whats|what's|when|is there|are there|how|which|can you|could you|please|envoie|send|share)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function looksLikeSameQuestion(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (
    /^(same( one| here| question| doubt| thing)?|same$|me too|me 2|me2|\+1|also me|ditto|seconded|following this|this too|also wondering|anyone else|waiting for this|moi aussi|pareil|igual|yo también|yo tambien|eu também|eu tambem|anch'?io|le nna|nna le nna)$/i.test(
      t
    )
  ) {
    return true;
  }
  return /^(i (was )?about to ask|i wanted to ask|i have the same|i was thinking the same|i also (want to )?know|same question|same here)\b/i.test(
    t
  );
}

/**
 * "What did I miss in the last call/meeting" — asks for the newest recording's
 * summary rather than a chat recap. Checked before the generic catch-up so a
 * meeting-specific ask is routed to the meeting summary.
 */
function isMeetingCatchupRequest(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t) return false;
  const meetingWord = /\b(meeting|call|recording|session|webinar|standup|stand-up)\b/;
  if (!meetingWord.test(t)) return false;
  if (/\bwhat (did i|have i) miss(ed)?\b/.test(t)) return true;
  if (/\b(summar(y|ise|ize)|recap|catch me up on|brief me on|what happened in)\b/.test(t)) return true;
  if (/\b(last|latest|recent|the)\b.*\b(meeting|call|recording|session)\b/.test(t) && /\?$/.test(text || '')) {
    return true;
  }
  return false;
}

function isFollowUp(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t)) return false;
  if (/^(so|and|also|then|but|or)\b/i.test(t)) return true;
  if (
    /\b(that|this|it|they|we|he|she|them|those|these|earlier|above|said|mentioned|chat|message|before)\b/i.test(
      t
    ) &&
    t.split(' ').length >= 3
  ) {
    return true;
  }
  return false;
}

function greetingAnswer(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .trim();
  if (!t) return null;
  if (/^(bonjour|salut|coucou|bonsoir)\b/.test(t)) {
    return "Salut, je suis askBack. Pose-moi une question et je répondrai à partir des fichiers et de cette conversation.";
  }
  if (/^(hola|buenas|buenos días|buenas tardes|buenas noches)\b/.test(t)) {
    return 'Hola, soy askBack. Envíame una pregunta y responderé con los archivos y este chat.';
  }
  if (/^(olá|ola|oi|bom dia|boa tarde|boa noite)\b/.test(t)) {
    return 'Olá, sou o askBack. Envie uma pergunta e eu respondo com os arquivos e este chat.';
  }
  if (/^(ciao|buongiorno|salve|buonasera)\b/.test(t)) {
    return 'Ciao, sono askBack. Mandami una domanda e risponderò dai file e da questa chat.';
  }
  if (/^(dumela)\b/.test(t)) {
    return 'Dumela, ke askBack. Mpotse potso, ke tla araba go tswa mo difaeleng le mo puong e.';
  }
  if (
    /^(hi|hii|hello|hey|hola|howdy|good morning|good afternoon|good evening|gm|evening|morning)\b/.test(
      t
    )
  ) {
    return "Hey, I'm askBack. Ask me anything from what's been discussed and I'll help.";
  }
  return null;
}

function botHelpAnswer(text, lang) {
  const q = String(text || '')
    .toLowerCase()
    .replace(/@\d+/g, ' ')
    .replace(/@(askback|askbak)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return null;
  if (isDocSummaryRequest(q)) return null;

  const asksAboutTagging =
    /\b(do i (have to|need to)|must i|should i|how (do i|to)|when (do i|to)|have to)\b.{0,40}\b(tag|mention)\b/i.test(
      q
    ) || /\b(tag|mention)\b.{0,24}\b(you|the bot|askback|askbak)\b.{0,24}\b(to (get |ask )?|for (an? )?answer)\b/i.test(q);
  if (asksAboutTagging) {
    return phrase('helpTagging', lang || 'en');
  }

  const asksAdmins = /\b(who|which|list|name|qui|quién|quem|chi)\b/.test(q) && /\badmins?\b/.test(q);
  if (asksAdmins) {
    const admins = listAdmins();
    if (lang && lang !== 'en') return null;
    if (!admins.length) {
      return 'No askBack admins are set yet. Add them on the Knowledge page.';
    }
    if (admins.length === 1) {
      return `${admins[0].name} is an askBack admin. Tag me if I don't know something and I'll call them.`;
    }
    return `askBack admins: ${admins.map((admin) => admin.name).join(', ')}. Tag me if I don't know something and I'll call them.`;
  }

  return null;
}

module.exports = {
  looksLikeQuestion,
  looksLikeClearQuestion,
  isKnowledgeAsk,
  looksLikeSameQuestion,
  isChitchat,
  isCasualTalk,
  isFollowUp,
  isAboutChat,
  isDocSummaryRequest,
  isTranslateRequest,
  isDocWorkRequest,
  isMeetingCatchupRequest,
  needsBroadKnowledge,
  botHelpAnswer,
  greetingAnswer,
};
