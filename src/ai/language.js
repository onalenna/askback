const SCRIPT = {
  ja: /[\u3040-\u30ff\u31f0-\u31ff]/,
  zh: /[\u4e00-\u9fff]/,
  hi: /[\u0900-\u097F]/,
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
    's\'il',
    's’il',
  ],
  es: [
    'hola',
    'gracias',
    'qué',
    'que',
    'cómo',
    'como',
    'por',
    'para',
    'una',
    'está',
    'usted',
    'buenos',
    'días',
    'quiero',
    'dónde',
    'donde',
  ],
  pt: ['olá', 'ola', 'obrigado', 'você', 'voce', 'não', 'nao', 'como', 'para', 'uma', 'está', 'porque', 'porquê'],
  it: ['ciao', 'grazie', 'perché', 'perche', 'come', 'cosa', 'buongiorno', 'sono', 'questo', 'una'],
  tn: ['dumela', 'gore', 'eng', 'kae', 'akere', 'tsala', 'rra', 'mma', 'ke a', 'le kae'],
};

function countHints(text, words) {
  return words.reduce((n, word) => n + (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text) ? 1 : 0), 0);
}

/**
 * Rough language of a user message. Returns a short code: en, fr, es, pt, it, ja, zh, hi, tn.
 */
function detectLanguage(text) {
  const raw = String(text || '').trim();
  if (!raw) return 'en';
  if (SCRIPT.ja.test(raw)) return 'ja';
  if (SCRIPT.zh.test(raw)) return 'zh';
  if (SCRIPT.hi.test(raw)) return 'hi';

  const t = raw.toLowerCase();
  const scores = {
    fr: countHints(t, WORD_HINTS.fr) + (/[àâçéèêëîïôùûüÿœæ]/.test(t) ? 2 : 0),
    es: countHints(t, WORD_HINTS.es) + (/[ñ¿¡]/.test(t) ? 2 : 0),
    pt: countHints(t, WORD_HINTS.pt) + (/[ãõ]/.test(t) ? 2 : 0),
    it: countHints(t, WORD_HINTS.it),
    tn: countHints(t, WORD_HINTS.tn),
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] >= 2) return ranked[0][0];
  return 'en';
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
  };
  return map[code] || '';
}

function lemonfoxVoice(code) {
  if (code === 'en' || !code) return process.env.LEMONFOX_VOICE || 'sarah';
  const british = process.env.LEMONFOX_VOICE_GB || 'alice';
  if (code === 'en-gb') return british;
  return process.env[`LEMONFOX_VOICE_${String(code).toUpperCase()}`] || process.env.LEMONFOX_VOICE || 'sarah';
}

function languageName(code) {
  return (
    {
      en: 'English',
      fr: 'French',
      es: 'Spanish',
      pt: 'Portuguese',
      it: 'Italian',
      ja: 'Japanese',
      zh: 'Chinese',
      hi: 'Hindi',
      tn: 'Setswana',
    }[code] || 'the same language as the user'
  );
}

module.exports = {
  detectLanguage,
  lemonfoxLanguage,
  lemonfoxVoice,
  languageName,
};
