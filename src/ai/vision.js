const { openai, CHAT_MODEL } = require('./embeddings');
const { languageName } = require('./language');

const MAX_BYTES = 8 * 1024 * 1024;

function usable(text) {
  return Boolean(text) && !String(text).includes('BOT_NO_ANSWER');
}

async function understandImage(buffer, mimetype, { caption = '', quoted = '', language = '' } = {}) {
  if (!buffer?.length) return '';
  if (buffer.length > MAX_BYTES) {
    console.warn('[whatsapp] image too large for vision');
    return '';
  }

  const mime = String(mimetype || 'image/jpeg').split(';')[0] || 'image/jpeg';
  const langLine = language
    ? `Prefer ${languageName(language)} for the write-up.`
    : 'Write in the same language as the text in the image, or the caption. Use English if neither has a clear language.';

  const parts = [
    'This image was sent on WhatsApp.',
    'Transcribe every readable word exactly.',
    'Then describe what the image shows in 1-3 short sentences.',
    'If the image itself asks a question, write that question clearly.',
    'If people are visible, say so and roughly where they are. If nobody is visible, say that.',
    langLine,
    'Do not answer the question yet. Do not apologise. Plain text only.',
  ];
  if (caption) parts.push('', `Caption / question from the sender: ${caption}`);
  if (quoted) parts.push('', 'They are replying to:', quoted);

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL(),
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You read WhatsApp images. Output transcribed text and a brief description, or BOT_NO_ANSWER if the image is empty or unreadable.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: parts.join('\n') },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` },
          },
        ],
      },
    ],
  });

  const out = (completion.choices[0].message.content || '').trim();
  return usable(out) ? out : '';
}

module.exports = { understandImage };
