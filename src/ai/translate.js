const { openai, CHAT_MODEL } = require('./embeddings');
const { languageName, normalizeLangCode } = require('./language');

async function translateToEnglish(text) {
  return translateTo(text, 'en');
}

async function translateTo(text, targetLang = 'en') {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const code = normalizeLangCode(targetLang) || 'en';
  const target = languageName(code);

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL(),
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `Translate the user message into clear, natural ${target}. Output only the translation. No quotes, labels, or extra commentary. If it is already in ${target}, return it unchanged.`,
      },
      { role: 'user', content: source },
    ],
  });
  return (completion.choices[0].message.content || '').trim();
}

module.exports = { translateToEnglish, translateTo };
