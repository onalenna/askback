const { openai } = require('./embeddings');
const { languageName } = require('./language');

const MODEL = 'gpt-4o';
const HALLUCINATIONS = [
  'thank you for watching',
  'thanks for watching',
  'thanks for listening',
  'subscribe',
  'please subscribe',
  'you',
  'bye',
  'the end',
  'music',
  '[music]',
  '(music)',
];

function usable(text) {
  return Boolean(text) && !String(text).includes('BOT_NO_ANSWER');
}

function looksLikeHeardSpeech(detailed) {
  const text = String(detailed?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (text.length < 2) return false;
  if (/^[\s.?,!…-]+$/.test(text)) return false;
  if (/(.)\1{10,}/.test(text)) return false;

  const lower = text.toLowerCase().replace(/[.!,]+$/g, '');
  if (HALLUCINATIONS.includes(lower)) return false;
  return true;
}

async function interpretVoiceTranscript(transcript, { chatContext = '', quoted = '', language = '' } = {}) {
  const heard = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!heard) return '';

  const langLine = language
    ? `The speech was detected as ${languageName(language)}. Keep the request in ${languageName(language)}.`
    : 'Keep the request in the same language the speaker used.';

  const parts = [
    'This is a WhatsApp voice note, transcribed automatically.',
    'Write the speaker\'s request as a clear question or instruction in the same language they used.',
    'Fix obvious transcription mistakes using the chat if that helps.',
    langLine,
    'Do not translate into English unless they spoke English.',
    'If the transcript is real speech, rewrite it clearly. If it is empty or only noise, reply exactly BOT_NO_ANSWER.',
    'Do not answer the request. Do not apologise.',
    '',
    `Transcript: ${heard}`,
  ];
  if (quoted) {
    parts.push('', 'They are replying to this message:', quoted);
  }
  if (chatContext) {
    parts.push('', 'Recent chat:', chatContext.slice(-1500));
  }

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You check that a voice-note transcript was understood. Output only the cleaned request in the speaker\'s language, never a translation, or BOT_NO_ANSWER.',
      },
      { role: 'user', content: parts.join('\n') },
    ],
  });

  const out = (completion.choices[0].message.content || '').trim();
  return usable(out) ? out.replace(/^["']|["']$/g, '').trim() : '';
}

module.exports = { looksLikeHeardSpeech, interpretVoiceTranscript };
