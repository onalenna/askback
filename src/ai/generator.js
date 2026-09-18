const { openai } = require('./embeddings');

const MODEL = 'gpt-4o';

function languageRule() {
  return "Always answer in the same language as the user's message. English gets English, French gets French, and the same for any other language. Do not switch languages unless they asked you to.";
}

function buildPrompt(
  question,
  contextChunks,
  { chatContext = '', quoted = '', allowGeneral = false, aboutChat = false } = {}
) {
  const sections = (contextChunks || [])
    .map((c, i) => `Section ${i + 1}:\n${c.content}`)
    .join('\n\n');

  const parts = [
    'You are askBack, a WhatsApp assistant.',
    'Be concise, friendly, and direct (under 200 words).',
    languageRule(),
    'If people already said the answer in the chat, use that and say who said it when you know.',
    'If the person is replying to a message, treat that quoted message as part of the question.',
  ];

  if (aboutChat || chatContext) {
    parts.push(
      'When they ask what was said, discussed, or already answered in this chat or group, use the recent WhatsApp messages.',
      'Paraphrase the relevant messages. If the recent messages do not mention it, say that in one short sentence — that is a valid answer.'
    );
  }

  if (allowGeneral) {
    parts.push(
      'If the question does not need the knowledge files or chat, answer it using general knowledge.',
      'Reply exactly BOT_NO_ANSWER only if the message is not a real question or you cannot tell what they want.',
      'Do not use BOT_NO_ANSWER just because the knowledge files are missing.'
    );
  } else {
    parts.push(
      'Answer from the knowledge files and the recent WhatsApp conversation.',
      'If those do not contain the answer, reply exactly BOT_NO_ANSWER.'
    );
  }

  if (chatContext) {
    parts.push('', 'Recent WhatsApp messages (oldest first):', '------------------', chatContext);
  } else if (aboutChat) {
    parts.push('', 'Recent WhatsApp messages: none loaded yet.');
  }
  if (quoted) {
    parts.push('', 'They are replying to this message:', quoted);
  }
  if (sections) {
    parts.push('', 'Knowledge files:', '------------------', sections);
  }
  parts.push('', 'Question:', question);
  return parts.join('\n');
}

async function once(question, contextChunks, extras, allowGeneral) {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: allowGeneral ? 0.3 : 0,
    messages: [
      {
        role: 'system',
        content: allowGeneral
          ? `Answer WhatsApp questions helpfully in the user's language. Prefer chat and knowledge files when relevant, otherwise use general knowledge. Output BOT_NO_ANSWER only if you do not understand the message.`
          : `Answer from the provided WhatsApp chat and knowledge files, in the user's language. If they ask about the chat, recap it. Output BOT_NO_ANSWER only if those sources do not help and it is not a chat recap.`,
      },
      { role: 'user', content: buildPrompt(question, contextChunks, { ...extras, allowGeneral }) },
    ],
  });
  return (completion.choices[0].message.content || '').trim();
}

function usable(text) {
  return Boolean(text) && !text.includes('BOT_NO_ANSWER');
}

async function generateAnswer(question, contextChunks, extras = {}) {
  const hasContext = Boolean(contextChunks?.length || extras.chatContext || extras.quoted);

  if (hasContext || extras.aboutChat) {
    const grounded = await once(question, contextChunks, extras, false);
    if (usable(grounded)) return grounded;
  }

  const general = await once(question, contextChunks, extras, true);
  if (usable(general)) return general;
  return 'BOT_NO_ANSWER';
}

module.exports = { generateAnswer, MODEL };
