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
]);

function isChitchat(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .trim();
  return CHITCHAT.has(t);
}

function isDocSummaryRequest(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (!/\b(summar(y|ise|ize)|overview|tl;dr|tldr|key points|main points)\b/i.test(t)) return false;
  if (/\b(document|file|pdf|doc|paper|report|notes?|attachment)\b/i.test(t)) return true;
  if (/\b(chat|group|conversation|messages?|thread)\b/i.test(t)) return false;
  return true;
}

function isAboutChat(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t)) return false;
  if (/\b(photo|image|picture|pic|pics|screenshot|this photo|this image|this picture)\b/i.test(t)) {
    return false;
  }
  if (isDocSummaryRequest(t)) return false;
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
  if (isChitchat(t)) return false;
  if (t.includes('?')) return true;
  if (isAboutChat(t)) return true;
  if (
    /^(who|what|whats|when|where|why|how|which|can|could|would|will|is|are|do|does|did|should|please|tell|explain|send|share|give|repeat|recap|remind|summarise|summarize|qui|que|quoi|quand|où|ou|pourquoi|comment|peux|peut|est-ce|quién|quien|qué|cuando|cuándo|dónde|donde|por qué|porque|cómo|como|quem|quando|onde|chi|cosa|dove|perché|perche|a o|o ka|ke kopa|naa)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(who|what|when|where|why|how|which)\b/i.test(t) && t.split(' ').length >= 3) {
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
  looksLikeSameQuestion,
  isChitchat,
  isFollowUp,
  isAboutChat,
  isDocSummaryRequest,
  needsBroadKnowledge,
  botHelpAnswer,
  greetingAnswer,
};
