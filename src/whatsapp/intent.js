const { listAdmins } = require('./admins');

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

function isAboutChat(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || isChitchat(t)) return false;
  return /\b(said|say|mention|mentioned|talked|talk|discussed|chat|group|earlier|before|already|last message|previous|anyone|somebody|someone|who asked|recap|summar(y|ise|ize)|have we|did we|did anyone|in this (group|chat)|on (this|the) group|what did)\b/i.test(
    t
  );
}

function looksLikeQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (isChitchat(t)) return false;
  if (t.includes('?')) return true;
  if (isAboutChat(t)) return true;
  if (
    /^(who|what|whats|when|where|why|how|which|can|could|would|will|is|are|do|does|did|should|please|tell|explain|send|share|give|repeat|recap|remind|summarise|summarize|qui|que|quoi|quand|où|ou|pourquoi|comment|peux|peut|est-ce|quién|quien|qué|cuando|cuándo|dónde|donde|por qué|porque|cómo|como|quem|quando|onde|chi|cosa|dove|perché|perche)\b/i.test(
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
    return "Hi, I'm askBack. Send me a question here and I'll answer from the knowledge files and this chat.";
  }
  return null;
}

function botHelpAnswer(text) {
  const q = String(text || '').toLowerCase();
  if (!q) return null;

  const asksAboutTagging =
    /\b(tag|mention|@)\b/.test(q) &&
    /\b(bot|askbak|askback|you|do i have to|need to|have to)\b/.test(q);
  if (asksAboutTagging) {
    return "No need to tag me. Ask in this chat and I'll use the knowledge files and messages already here. Tag me only if I don't have it — then I'll call an admin.";
  }

  const asksAdmins = /\b(who|which|list|name)\b/.test(q) && /\badmins?\b/.test(q);
  if (asksAdmins) {
    const admins = listAdmins();
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
  isChitchat,
  isFollowUp,
  isAboutChat,
  botHelpAnswer,
  greetingAnswer,
};
