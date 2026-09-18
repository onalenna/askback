const { openai } = require('./embeddings');

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

  const segs = detailed.segments || [];
  if (segs.length) {
    const avgNoSpeech =
      segs.reduce((sum, seg) => sum + Number(seg.no_speech_prob || 0), 0) / segs.length;
    const avgLog =
      segs.reduce((sum, seg) => sum + Number(seg.avg_logprob || 0), 0) / segs.length;
    if (avgNoSpeech > 0.7) return false;
    if (avgLog < -1.35) return false;
  }
  return true;
}

async function interpretVoiceTranscript(transcript, { chatContext = '', quoted = '' } = {}) {
  const heard = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!heard) return '';

  const parts = [
    'This is a WhatsApp voice note, transcribed automatically.',
    'Write the speaker\'s request as a clear question or instruction in the same language they used.',
    'Fix obvious transcription mistakes using the chat if that helps.',
    'Do not translate into English unless they spoke English.',
    'If you are not sure what they said or wanted, reply exactly BOT_NO_ANSWER.',
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
          'You check that a voice-note transcript was understood. Output only the cleaned request in the speaker\'s language, or BOT_NO_ANSWER.',
      },
      { role: 'user', content: parts.join('\n') },
    ],
  });

  const out = (completion.choices[0].message.content || '').trim();
  return usable(out) ? out.replace(/^["']|["']$/g, '').trim() : '';
}

module.exports = { looksLikeHeardSpeech, interpretVoiceTranscript };
