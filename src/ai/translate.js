const { openai } = require('./embeddings');
const { MODEL } = require('./generator');

async function translateToEnglish(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'Translate the user message into clear, natural English. Output only the translation. No quotes, labels, or extra commentary. If it is already English, return it unchanged.',
      },
      { role: 'user', content: source },
    ],
  });
  return (completion.choices[0].message.content || '').trim();
}

module.exports = { translateToEnglish };
