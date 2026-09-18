const { openai } = require('./embeddings');
const { languageName } = require('./language');

const MODEL = 'gpt-4o';

function languageRule(question, langCode) {
  const named = langCode
    ? `The user's question is in ${languageName(langCode)}. Write your ENTIRE reply in ${languageName(langCode)} only.`
    : 'Detect the language of the user question (not the attached file) and write your ENTIRE reply in that same language only.';
  return [
    named,
    'One language only. Never mix Spanish with English, or any two languages, in the same reply.',
    'Do not add a translation unless they asked for one.',
    'If an attached document or knowledge file is in another language, still answer in the question language.',
    'Keep names, titles, and quotes as they appear, but your own sentences stay in the question language.',
  ].join(' ');
}

function buildPrompt(
  question,
  contextChunks,
  { chatContext = '', quoted = '', allowGeneral = false, aboutChat = false, fromMedia = false, summarizeDoc = false, language = '' } = {}
) {
  const sections = (contextChunks || [])
    .map((c, i) => `Section ${i + 1}:\n${c.content}`)
    .join('\n\n');

  const parts = [
    'You are askBack, a WhatsApp assistant.',
    'Be concise, friendly, and direct (under 200 words).',
    languageRule(question, language),
  ];
  if (summarizeDoc) {
    parts.push(
      'Summarize the knowledge files below in a clear, useful way.',
      'Cover the main points, decisions, and any important names or dates.',
      'Do not recap the WhatsApp chat, tagging instructions, or earlier bot tests.',
      'Write the summary in the same language as the user question, even if the file uses other words or names.'
    );
  } else if (fromMedia) {
    parts.push(
      'If the person is replying to a message, treat that quoted message as part of the question.',
      'The Question includes what was read from an attached image or document.',
      'Answer the sender’s question about that attachment first and directly.',
      'Say clearly whether a person (or the named person) is visible, if they asked that.',
      'Do not recap recent chat, languages, knowledge files, or bot tests unless they asked about those.'
    );
  } else {
    parts.push(
      'If people already said the answer in the chat, use that and say who said it when you know.',
      'If the person is replying to a message, treat that quoted message as part of the question.',
      'Use knowledge files as source material to answer. Do not offer to send, attach, or forward those files unless they clearly asked you to send a file.'
    );
  }

  if (!fromMedia && (aboutChat || chatContext)) {
    parts.push(
      'When they ask what was said, discussed, or already answered in this chat or group, recap the WhatsApp messages you were given.',
      'Cover the main topics, decisions, questions, and who said them when you know.',
      'If they ask what has been discussed since the group started, recap everything you can see and say clearly that this is from the messages you have — not a guaranteed full history from day one.',
      'Never reply BOT_NO_ANSWER to a recap or “what was discussed” question. If you have no messages, say you do not have the older history loaded yet.'
    );
  }

  if (allowGeneral && !aboutChat) {
    parts.push(
      'If the question does not need the knowledge files or chat, answer it using general knowledge.',
      'Reply exactly BOT_NO_ANSWER only if the message is not a real question or you cannot tell what they want.',
      'Do not use BOT_NO_ANSWER just because the knowledge files are missing.'
    );
  } else if (!allowGeneral && !aboutChat) {
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
        content: extras.summarizeDoc
          ? `Summarize the provided knowledge files. Write the entire summary in the user's language only. Never mix languages.`
          : extras.fromMedia
          ? `Answer the question about the attached WhatsApp image or document. Write the entire reply in the user's language only. Never mix languages. Do not recap unrelated chat.`
          : allowGeneral
          ? extras.aboutChat
            ? `Recap the WhatsApp chat from the messages provided. Match the Question language. Never output BOT_NO_ANSWER for a recap.`
            : `Answer WhatsApp questions helpfully. Match the Question language exactly. Prefer chat and knowledge files when relevant, otherwise use general knowledge. Output BOT_NO_ANSWER only if you do not understand the message.`
          : extras.aboutChat
            ? `Recap the WhatsApp chat from the messages provided. Match the Question language. Never output BOT_NO_ANSWER for a recap.`
            : `Answer from the provided WhatsApp chat and knowledge files. Match the Question language exactly. If they ask about the chat, recap it from the messages given. Never output BOT_NO_ANSWER for a recap request.`,
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
  if (extras.summarizeDoc) {
    const summary = await once(question, contextChunks, { ...extras, aboutChat: false, chatContext: '' }, true);
    if (usable(summary)) return summary;
    return 'BOT_NO_ANSWER';
  }

  if (extras.fromMedia) {
    const media = await once(question, [], { ...extras, aboutChat: false, chatContext: extras.quoted ? extras.chatContext : '' }, true);
    if (usable(media)) return media;
    return 'BOT_NO_ANSWER';
  }

  const hasContext = Boolean(contextChunks?.length || extras.chatContext || extras.quoted);

  if (extras.aboutChat) {
    const recap = await once(question, contextChunks, extras, true);
    if (usable(recap)) return recap;
  }

  if (hasContext && !extras.aboutChat) {
    const grounded = await once(question, contextChunks, extras, false);
    if (usable(grounded)) return grounded;
  }

  const general = await once(question, contextChunks, extras, true);
  if (usable(general)) return general;
  return 'BOT_NO_ANSWER';
}

module.exports = { generateAnswer, MODEL };
