const SCRIPT = {
  ja: /[\u3040-\u30ff\u31f0-\u31ff]/,
  zh: /[\u4e00-\u9fff]/,
  hi: /[\u0900-\u097F]/,
  ar: /[\u0600-\u06FF]/,
};

const WORD_HINTS = {
  fr: [
    'bonjour',
    'salut',
    'merci',
    'oui',
    'non',
    'quoi',
    'comment',
    'pourquoi',
    'est-ce',
    'avec',
    'pour',
    'dans',
    'cette',
    'vous',
    'je',
    'tu',
    'nous',
    'une',
    'des',
    'les',
    'pas',
    "s'il",
    's’il',
    "c'est",
    'cest',
    'français',
    'francais',
    'parle',
    'peux',
    'peux-tu',
    'connais',
  ],
  es: [
    'hola',
    'gracias',
    'qué',
    'cómo',
    'por qué',
    'está',
    'usted',
    'buenos',
    'días',
    'quiero',
    'dónde',
    'español',
    'espanol',
    'hablas',
    'necesito',
    'resumen',
    'favor',
    'también',
    'tambien',
    'después',
    'despues',
    'entonces',
  ],
  pt: [
    'olá',
    'ola',
    'obrigado',
    'obrigada',
    'você',
    'voce',
    'não',
    'nao',
    'como',
    'para',
    'uma',
    'está',
    'porque',
    'porquê',
    'português',
    'portugues',
    'fala',
  ],
  it: [
    'ciao',
    'grazie',
    'perché',
    'perche',
    'come',
    'cosa',
    'buongiorno',
    'sono',
    'questo',
    'una',
    'italiano',
    'parli',
  ],
  tn: [
    'dumela',
    'dumelang',
    'setswana',
    'tswana',
    'itse',
    'akere',
    'tsala',
    'rra',
    'mma',
    'nna',
    'wena',
    'jang',
    'leng',
    'gape',
    'araba',
    'botsa',
    'potso',
    'tlhoka',
    'tshwanetse',
    'ga ke',
    'ke kopa',
    'le kae',
    'o kae',
    'a o',
    'ke a',
  ],
};

const ENGLISH_HINTS = new Set([
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'you',
  'your',
  'what',
  'how',
  'can',
  'this',
  'that',
  'have',
  'has',
  'had',
  'for',
  'and',
  'with',
  'please',
  'tell',
  'who',
  'where',
  'why',
  'when',
  'hello',
  'hi',
  'thanks',
  'could',
  'would',
  'will',
  'does',
  'did',
  'about',
  'it',
  'its',
  'so',
  'am',
  'i',
  'im',
  "i'm",
  'me',
  'my',
  'we',
  'they',
  'them',
  'not',
  'but',
  'just',
  'like',
  'from',
  'on',
  'in',
  'at',
  'of',
  'if',
  'or',
  'as',
  'do',
  'to',
  'give',
  'summary',
  'summarize',
  'summarise',
  'document',
  'understand',
  'a',
  'an',
  'some',
  'any',
  'all',
  'may',
  'might',
  'should',
  'hold',
  'wait',
  'going',
  'gonna',
  'wanna',
  'dont',
  "don't",
  'cant',
  "can't",
  'wont',
  "won't",
]);

const NAMES = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
  ja: 'Japanese',
  zh: 'Chinese',
  hi: 'Hindi',
  tn: 'Setswana',
  de: 'German',
  ar: 'Arabic',
  sw: 'Swahili',
  nl: 'Dutch',
};

const ALIASES = {
  tsn: 'tn',
  tswana: 'tn',
  setswana: 'tn',
  tn: 'tn',
  fra: 'fr',
  french: 'fr',
  fr: 'fr',
  spa: 'es',
  spanish: 'es',
  es: 'es',
  por: 'pt',
  portuguese: 'pt',
  pt: 'pt',
  ita: 'it',
  italian: 'it',
  it: 'it',
  jpn: 'ja',
  japanese: 'ja',
  ja: 'ja',
  zho: 'zh',
  chinese: 'zh',
  zh: 'zh',
  cmn: 'zh',
  hin: 'hi',
  hindi: 'hi',
  hi: 'hi',
  eng: 'en',
  english: 'en',
  en: 'en',
  deu: 'de',
  german: 'de',
  de: 'de',
  nld: 'nl',
  dutch: 'nl',
  nl: 'nl',
  ara: 'ar',
  arabic: 'ar',
  ar: 'ar',
  swa: 'sw',
  swahili: 'sw',
  sw: 'sw',
};

const PHRASES = {
  noKnowledge: {
    en: "I don't have this in knowledge yet.",
    fr: "Je n'ai pas encore ça dans mes fichiers.",
    es: 'Todavía no tengo eso en los archivos.',
    pt: 'Ainda não tenho isso nos arquivos.',
    it: 'Non ho ancora questo nei file.',
    tn: 'Ga ke ise ke nne le se mo difaeleng.',
  },
  skipZip: {
    en: "I can't open zip files. Send the image, PDF, or document instead.",
    fr: 'Je ne peux pas ouvrir les fichiers zip. Envoie l’image, le PDF ou le document.',
    es: 'No puedo abrir archivos zip. Envía la imagen, el PDF o el documento.',
    pt: 'Não consigo abrir arquivos zip. Envia a imagem, o PDF ou o documento.',
    it: 'Non posso aprire i file zip. Invia l’immagine, il PDF o il documento.',
    tn: 'Ga ke kgone go bula difaele tsa zip. Romela setshwantsho, PDF, kgotsa tokomane.',
  },
  fileSendFailed: {
    en: "I found the file but couldn't send it. Try again.",
    fr: "J'ai trouvé le fichier mais je n'ai pas pu l'envoyer. Réessaie.",
    es: 'Encontré el archivo pero no pude enviarlo. Inténtalo de nuevo.',
    pt: 'Encontrei o arquivo, mas não consegui enviar. Tenta de novo.',
    it: 'Ho trovato il file ma non sono riuscito a inviarlo. Riprova.',
    tn: 'Ke bone faele mme ga ke a kgona go e romela. Leka gape.',
  },
  helpTagging: {
    en: 'In a group, tag me when you want an answer. In a private chat you can just ask. I use the knowledge files and messages already here. If I do not have it, I will call an admin.',
    fr: 'Dans un groupe, mentionne-moi pour que je réponde. En privé, pose ta question directement. Je m’appuie sur les fichiers et ce chat. Si je n’ai pas la réponse, j’appelle un admin.',
    es: 'En un grupo, etiquéteme cuando quieras una respuesta. En un chat privado puedes preguntar directo. Uso los archivos y este chat. Si no lo tengo, llamaré a un admin.',
    pt: 'Num grupo, me marque quando quiser resposta. No privado é só perguntar. Uso os arquivos e este chat. Se eu não tiver, chamo um admin.',
    it: 'In un gruppo, taggami quando vuoi una risposta. In privato puoi chiedere direttamente. Uso i file e questa chat. Se non ho la risposta, chiamo un admin.',
    tn: 'Mo sehlopheng, nkgatise fa o batla karabo. Mo puong e e ikemetseng o ka botsa fela. Ke dirisa difaele le melaetsa e e leng teng. Fa ke se na karabo, ke bitsa admin.',
  },
};

function countHints(text, words) {
  return words.reduce(
    (n, word) => n + (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text) ? 1 : 0),
    0
  );
}

function normalizeLangCode(code) {
  const raw = String(code || '')
    .toLowerCase()
    .trim()
    .split(/[-_]/)[0];
  if (!raw) return '';
  return ALIASES[raw] || (NAMES[raw] ? raw : raw.length <= 3 ? raw : '');
}

/**
 * Rough language of a user message. Returns a short code, or '' if unsure.
 * Non-English is only returned when the signal is clear.
 */
function detectLanguage(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (SCRIPT.ja.test(raw)) return 'ja';
  if (SCRIPT.zh.test(raw)) return 'zh';
  if (SCRIPT.hi.test(raw)) return 'hi';
  if (SCRIPT.ar.test(raw)) return 'ar';

  const t = raw.toLowerCase();
  const englishScore = countHints(
    t,
    [...ENGLISH_HINTS].filter((word) => word.length > 2)
  );
  const scores = {
    fr: countHints(t, WORD_HINTS.fr) + (/[àâçéèêëîïôùûüÿœæ]/.test(t) ? 2 : 0),
    es: countHints(t, WORD_HINTS.es) + (/[ñ¿¡]/.test(t) ? 2 : 0),
    pt: countHints(t, WORD_HINTS.pt) + (/[ãõ]/.test(t) ? 2 : 0),
    it: countHints(t, WORD_HINTS.it),
    tn: countHints(t, WORD_HINTS.tn),
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const second = ranked[1];
  if (looksEnglish(raw) && (!best || best[1] < englishScore + 3 || best[1] < 4)) return 'en';
  // Need a clear winner: strong score, ahead of English, and not tied with another language
  if (
    best &&
    best[1] >= 3 &&
    best[1] >= englishScore + 2 &&
    (!second || best[1] >= second[1] + 2)
  ) {
    return best[0];
  }
  if (looksEnglish(raw)) return 'en';
  return '';
}

function looksEnglish(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const letters = raw.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const ascii = (letters.match(/[A-Za-z]/g) || []).length;
  if (letters.length && ascii / letters.length < 0.7) return false;

  const words = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z']+/g);
  if (!words?.length) return false;

  const weak = new Set(['a', 'an', 'i', 'to', 'on', 'in', 'at', 'of', 'or', 'as', 'am']);
  const strong = words.filter((w) => ENGLISH_HINTS.has(w) && !weak.has(w) && w.length > 1).length;
  const weakHits = words.filter((w) => weak.has(w)).length;
  if (strong >= 2) return true;
  if (strong >= 1 && weakHits >= 1) return true;
  return false;
}

function languageFromLabel(label) {
  const raw = String(label || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const compact = raw.replace(/[\s-]+/g, '');
  if (ALIASES[raw]) return ALIASES[raw];
  if (ALIASES[compact]) return ALIASES[compact];
  for (const [code, name] of Object.entries(NAMES)) {
    const n = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
    if (n === raw || n.replace(/\s+/g, '') === compact) return code;
  }
  return normalizeLangCode(raw) || normalizeLangCode(compact);
}

/**
 * Explicit asks like "respond in French" / "réponds en français".
 */
function requestedReplyLanguage(text) {
  const sample = String(text || '').trim();
  if (!sample) return '';
  const patterns = [
    /\b(?:please\s+)?(?:respond|reply|answer|write|speak|talk)(?:\s+to\s+me)?\s+in\s+([a-z][a-z\s-]{1,24}?)(?:\s+please)?(?=\s*[.!,;:?\n]|$)/i,
    /\b(?:please\s+)?(?:answer|reply|respond)\s+(?:me\s+)?(?:using|with)\s+([a-z][a-z\s-]{1,24}?)(?:\s+please)?(?=\s*[.!,;:?\n]|$)/i,
    /\b(?:responde|responda|réponds|répondez|repondez|rispondi)\s+(?:en|in)\s+([a-zàâäéèêëïîôùûüçñõã]{2,24})/i,
    /\b(?:en|in)\s+(english|french|spanish|portuguese|italian|german|dutch|arabic|swahili|setswana|tswana|hindi|japanese|chinese|français|francais|español|espanol|português|portugues|italiano|deutsch|arabe|kiswahili)\b/i,
  ];
  for (const pattern of patterns) {
    const match = sample.match(pattern);
    if (!match?.[1]) continue;
    const code = languageFromLabel(match[1]);
    if (code) return code;
  }
  return '';
}

/**
 * Language the bot should reply in.
 * Defaults to English when unsure. Only switches when detection is clear
 * or the user explicitly asks for another language.
 */
function resolveReplyLanguage(text, hinted) {
  const sample = String(text || '').trim();
  const requested = requestedReplyLanguage(sample);
  if (requested) return requested;
  if (looksEnglish(sample)) return 'en';
  const fromText = detectLanguage(sample);
  if (fromText) return fromText;

  // Whisper/hint alone is not enough when the text is ambiguous
  const fromHint = normalizeLangCode(hinted);
  if (fromHint && fromHint !== 'en' && sample) {
    // Only trust a non-English hint if the text already leans that way a little
    const lean = detectLanguageConfidence(sample, fromHint);
    if (lean >= 2) return fromHint;
  }
  return 'en';
}

/** Soft score for a single language code against text (for hint confirmation). */
function detectLanguageConfidence(text, code) {
  const t = String(text || '').toLowerCase();
  const lang = normalizeLangCode(code);
  if (!lang || lang === 'en') return 0;
  if (SCRIPT[lang]?.test(text)) return 10;
  const words = WORD_HINTS[lang];
  if (!words) return 0;
  return countHints(t, words);
}

function userAskLanguage(text, { caption = '', hinted = '' } = {}) {
  const clean = (value) =>
    String(value || '')
      .replace(/@\d+/g, ' ')
      .replace(/@(askback|askbak)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const ask = clean(caption);
  const body = clean(text);
  const requested = requestedReplyLanguage(ask) || requestedReplyLanguage(body);
  if (requested) return requested;
  if (ask) return resolveReplyLanguage(ask, hinted) || 'en';
  const first = body.split(/\n/)[0].trim().slice(0, 400);
  return resolveReplyLanguage(first || body, hinted) || 'en';
}

function lemonfoxLanguage(code) {
  const map = {
    en: 'en-us',
    fr: 'fr',
    es: 'es',
    pt: 'pt-br',
    it: 'it',
    ja: 'ja',
    zh: 'zh',
    hi: 'hi',
    de: 'de',
    ar: 'ar',
    nl: 'nl',
  };
  return map[normalizeLangCode(code)] || '';
}

function lemonfoxVoice(code) {
  const normalized = normalizeLangCode(code);
  if (normalized === 'en' || !normalized) return process.env.LEMONFOX_VOICE || 'sarah';
  if (normalized === 'en-gb') return process.env.LEMONFOX_VOICE_GB || 'alice';
  return process.env[`LEMONFOX_VOICE_${String(normalized).toUpperCase()}`] || process.env.LEMONFOX_VOICE || 'sarah';
}

function languageName(code) {
  const normalized = normalizeLangCode(code);
  return NAMES[normalized] || 'the same language as the user';
}

function phrase(key, lang) {
  const table = PHRASES[key];
  if (!table) return '';
  const code = normalizeLangCode(lang) || 'en';
  return table[code] || table.en;
}

module.exports = {
  detectLanguage,
  resolveReplyLanguage,
  requestedReplyLanguage,
  userAskLanguage,
  normalizeLangCode,
  looksEnglish,
  lemonfoxLanguage,
  lemonfoxVoice,
  languageName,
  phrase,
};
