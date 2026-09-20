const { openai, CHAT_MODEL } = require('./embeddings');
const { languageName } = require('./language');

const MODEL = CHAT_MODEL;

function languageRule(question, langCode) {
  const named = langCode
    ? `Write your ENTIRE reply in ${languageName(langCode)} only. If the user asked to respond in ${languageName(langCode)}, obey that even when the question itself is in another language.`
    : 'Reply in the SAME language as the user question. Detect it carefully and match it accurately. Do not switch to English unless the question is clearly in English.';
  return [
    named,
    'One language only. Never mix Spanish with English, or any two languages, in the same reply.',
    'Do not add a translation unless they asked for one.',
    'If an attached document or knowledge file is in another language, still answer in the required reply language.',
    'Keep names, titles, and quotes as they appear, but your own sentences stay in the required reply language.',
  ].join(' ');
}

function buildPrompt(
  question,
  contextChunks,
  {
    chatContext = '',
    quoted = '',
    allowGeneral = false,
    aboutChat = false,
    fromMedia = false,
    summarizeDoc = false,
    translateDoc = false,
    docWork = false,
    fromVoice = false,
    language = '',
    requireKnown = false,
  } = {}
) {
  const sections = (contextChunks || [])
    .map((c, i) => `Section ${i + 1}:\n${c.content}`)
    .join('\n\n');

  const parts = [
    'You are askBack, a WhatsApp assistant.',
    'Personality: relaxed, warm, and lightly playful, like a helpful friend in the group, not a stiff corporate bot.',
    'Keep answers clear and useful. A small joke or casual phrasing is fine when it fits; never force humor.',
    'Stay respectful. Do not be sarcastic about people.',
    'ACCURACY FIRST: Never invent people, names, dates, links, deadlines, facts, or quotes.',
    'Only use names that appear in the Knowledge files or Recent WhatsApp messages you were given. If a name is not there, do not guess it.',
    'Never ask anyone for their name, phone number, email, or other personal details.',
    'Never interview the user. Do not ask follow-up identity questions like "what is your name?" or "who are you?".',
    'If you do not have the answer in the material or chat, say you do not have that, or reply exactly BOT_NO_ANSWER. Do not fill gaps by guessing.',
    'Prefer short natural WhatsApp-style messages over formal essays, unless they asked for a list or detailed recap.',
    'Never use a double hyphen (--), an em dash, or an en dash. Use a comma, period, or the word "and" instead.',
    'Never say "according to knowledge files", "based on knowledge files", or mention knowledge files, uploads, or your sources. Just answer naturally as if you know.',
    'When you share more than one link, put a blank line between each link and format every link like this:',
    '1) a short title that says what it was for (class, form, meeting, recording, etc.)',
    '2) a line starting with Posted: plus when it was shared, and keep what it was for if useful (example: Posted: 12 Sep · for Friday class)',
    '3) the URL alone on the next line',
    'If you do not know when it was posted, omit the Posted line. Never invent a date or purpose.',
    languageRule(question, language),
  ];
  if (fromVoice) {
    parts.push(
      'This answer will be read aloud as a voice note. Use plain text only. Never use emojis, emoticons, or symbol icons.'
    );
  }
  if (translateDoc) {
    const target = language && language !== 'en' ? languageName(language) : 'English';
    parts.push(
      `Translate the document or material below into clear, natural ${target}.`,
      'Preserve meaning, names, numbers, and structure where useful.',
      'Output only the translation. No preface like "Here is the translation".',
      'Do not recap the WhatsApp chat or mention knowledge files.'
    );
  } else if (summarizeDoc) {
    parts.push(
      'Summarize the document or material below in a clear, useful way.',
      'Cover the main points, decisions, and any important names or dates.',
      'Do not recap the WhatsApp chat, tagging instructions, or earlier bot tests.',
      'Write the summary in the required reply language, even if the file uses other words or names.'
    );
  } else if (docWork || fromMedia) {
    parts.push(
      'If the person is replying to a message, treat that quoted message as part of the question.',
      'The Question includes what was read from an attached image or document, or from uploaded material.',
      'Answer the sender’s ask about that document first and directly (summary, translation, explanation, extraction, etc.).',
      'Say clearly whether a person (or the named person) is visible, if they asked that.',
      'Do not recap recent chat, languages, knowledge files, or bot tests unless they asked about those.'
    );
  } else {
    parts.push(
      'If people already said the answer in the chat or knowledge files, use that and say who said it when you know.',
      'If the person is replying to a message, treat that quoted message as part of the question.',
      'Knowledge files include uploaded WhatsApp group chats. Use them to answer who is in the programme, who is from a country, and who someone is.',
      'When they ask if anyone is from a place or who someone is, list every matching person you can find in the knowledge files. Do not skip names that are present. Do not invent names that are not present. You may write more than a short recap for those lists.',
      'Never say nobody is mentioned if a knowledge section names them.',
      'When they ask for class links, recordings, forms, or resources, pull them from the material sections even if the recent live chat does not repeat them. Do not reply BOT_NO_ANSWER just because the live chat is quiet about it.',
      'Recent WhatsApp messages below are only this live conversation, not the full uploaded group history.',
      'Use knowledge files as source material to answer. When they clearly ask you to send, share, or attach a file, photo, or media, do it — the system will attach the file. Do not pretend you already sent it if you cannot.',
      'Never answer a send/share/file request with only the filename. If you cannot attach it, say you could not find the file.'
    );
  }

  if (!fromMedia && !requireKnown && (aboutChat || chatContext)) {
    parts.push(
      'When they ask what was said, discussed, or already answered in this chat or group, recap the WhatsApp messages you were given.',
      'Cover the main topics, decisions, questions, and who said them when you know.',
      'If they ask what has been discussed since the group started, recap everything you can see and say clearly that this is from the messages you have, not a guaranteed full history from day one.',
      'Never reply BOT_NO_ANSWER to a recap or “what was discussed” question. If you have no messages, say you do not have the older history loaded yet.'
    );
  }

  if (requireKnown) {
    parts.push(
      'STRICT: Only answer if the Knowledge files sections clearly contain the answer.',
      'Do not guess, speculate, or fill gaps from general knowledge or weak chat noise.',
      'Never invent names or ask anyone who they are.',
      'If you are not sure, reply exactly BOT_NO_ANSWER.',
      'Do not say you are unsure, maybe, or probably — stay silent via BOT_NO_ANSWER instead.'
    );
  } else if (allowGeneral && !aboutChat) {
    parts.push(
      'If the question does not need the knowledge files or chat, answer it using general knowledge.',
      'Still never invent programme members, classmates, or local group facts.',
      'Never ask for the user\'s name or personal details.',
      'Reply exactly BOT_NO_ANSWER only if the message is not a real question or you cannot tell what they want.',
      'Do not use BOT_NO_ANSWER just because the knowledge files are missing.'
    );
  } else if (!allowGeneral && !aboutChat) {
    parts.push(
      'Answer from the knowledge files and the recent WhatsApp conversation.',
      'Prefer the material sections for facts, links, class resources, and forms. Live chat is only extra context.',
      'If the material sections contain the answer, use them. Only reply exactly BOT_NO_ANSWER if neither the material nor the chat helps.',
      'Never invent names, and never ask the user for their name.'
    );
  }

  if (chatContext && !requireKnown) {
    parts.push('', 'Recent WhatsApp messages (oldest first):', '------------------', chatContext);
  } else if (aboutChat && !requireKnown) {
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
    model: typeof MODEL === 'function' ? MODEL() : MODEL,
    temperature: allowGeneral ? 0.25 : 0.15,
    messages: [
      {
        role: 'system',
        content: extras.translateDoc
          ? `Translate the provided document or material into the required reply language only. Output only the translation. Never mix languages. Never mention knowledge files or sources. Never use -- or dash characters as punctuation.`
          : extras.summarizeDoc
          ? `Summarize the provided material in a clear, relaxed tone. Write the entire summary in the required reply language only. Never invent facts. Never mix languages. Never mention knowledge files or sources. Never use -- or dash characters as punctuation.`
          : extras.docWork || extras.fromMedia
          ? `Answer the question about the attached or provided document. Sound relaxed and friendly. Stay faithful to the document. Never invent people or facts. Never ask for the user's name. Write the entire reply in the required reply language only. Never mix languages. Do not recap unrelated chat. Never mention knowledge files. Never use -- or dash characters as punctuation.`
          : extras.requireKnown
          ? `Answer ONLY if the provided knowledge material clearly contains the answer. If you are unsure or the material is weak/irrelevant, output exactly BOT_NO_ANSWER. Never guess. Never invent names. Never ask anyone for their name. Never use general knowledge. Never hedge. Never mention knowledge files. Never use -- or dash characters as punctuation.`
          : allowGeneral
          ? extras.aboutChat
            ? `Recap the WhatsApp chat from the messages provided. Sound relaxed and a little playful when it fits. Reply in the same language as the Question. Never invent messages that are not there. Never ask for anyone's name. Never output BOT_NO_ANSWER for a recap. Never mention knowledge files. Never use -- or dash characters as punctuation.`
            : `Answer WhatsApp questions helpfully in a relaxed, lightly playful tone. Reply in the same language as the Question — match it accurately; do not default to English. Prefer chat and provided material when relevant, otherwise use general knowledge. Never invent programme members, classmates, or local facts. Never ask for the user's name or personal details. Never say "according to knowledge files" or mention sources. When sharing multiple links, name each one, say when it was posted and what it was for when you know, then the URL, with a blank line between links. Output BOT_NO_ANSWER only if you do not understand the message. Never use -- or dash characters as punctuation.`
          : extras.aboutChat
            ? `Recap the WhatsApp chat from the messages provided. Sound relaxed and a little playful when it fits. Reply in the same language as the Question. Never invent messages that are not there. Never ask for anyone's name. Never output BOT_NO_ANSWER for a recap. Never mention knowledge files. Never use -- or dash characters as punctuation.`
            : `Answer from the provided WhatsApp chat and material only. Sound relaxed and lightly playful when it fits, but stay accurate. Reply in the same language as the Question — match it accurately; do not default to English. Never invent names, people, dates, or links. Never ask for the user's name. Never say "according to knowledge files" or mention knowledge files or sources. When sharing multiple links, name each one, say when it was posted and what it was for when you know (class, form, meeting, etc.), then the URL, with a blank line between links. If they ask about the chat, recap it from the messages given. Never output BOT_NO_ANSWER for a recap request. Never use -- or dash characters as punctuation.`,
      },
      { role: 'user', content: buildPrompt(question, contextChunks, { ...extras, allowGeneral }) },
    ],
  });
  return (completion.choices[0].message.content || '').trim();
}

function stripDoubleHyphens(text) {
  return String(text || '')
    .replace(/\u2014|\u2013/g, ', ')
    .replace(/\s*--+\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,\s+/g, ', ')
    .trim();
}

function stripKnowledgeAttribution(text) {
  return String(text || '')
    .replace(
      /\b(?:according to|based on|from|in|per)\s+(?:the\s+)?knowledge\s+(?:base|files?)\b[,:.\s]*/gi,
      ''
    )
    .replace(
      /\bas\s+(?:found|stated|mentioned|noted)\s+in\s+(?:the\s+)?knowledge\s+(?:base|files?)\b[,:.\s]*/gi,
      ''
    )
    .replace(/\b(?:the\s+)?knowledge\s+files?\s+(?:say|show|mention|indicate|suggest)\s+that\b[,:.\s]*/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*[,\s]+/gm, '')
    .trim();
}

function formatReplyLinks(text) {
  const { extractLinks, linkDisplayName } = require('./tts');
  let out = String(text || '');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_, name, url) => {
    return `${String(name).trim()}\n${url}`;
  });
  out = out.replace(/^(.+?)[:\-–—]\s*((?:https?:\/\/|www\.)\S+)\s*$/gim, (_, name, url) => {
    const clean = /^www\./i.test(url) ? `https://${url}` : url;
    return `${String(name).trim()}\n${clean}`;
  });
  out = out.replace(/((?:https?:\/\/|www\.)\S+)\s*\n(?=(?:https?:\/\/|www\.)\S+)/gi, '$1\n\n');

  const links = extractLinks(out);
  if (links.length >= 2) {
    const lines = out.split(/\r?\n/);
    const rebuilt = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const onlyUrl = trimmed.match(/^((?:https?:\/\/|www\.)\S+)$/i);
      if (onlyUrl) {
        const prev = (rebuilt[rebuilt.length - 1] || '').trim();
        const prev2 = (rebuilt[rebuilt.length - 2] || '').trim();
        const url = /^www\./i.test(onlyUrl[1]) ? `https://${onlyUrl[1]}` : onlyUrl[1];
        const prevIsMeta = /^posted\s*:/i.test(prev);
        const looksNamed =
          prev &&
          !/(?:https?:\/\/|www\.)/i.test(prev) &&
          prev.length <= 160 &&
          (!/[.!?]$/.test(prev) || prevIsMeta);
        const hasBlock = looksNamed || (prevIsMeta && prev2 && !/(?:https?:\/\/|www\.)/i.test(prev2));
        if (!hasBlock) {
          if (rebuilt.length && rebuilt[rebuilt.length - 1] !== '') rebuilt.push('');
          rebuilt.push(linkDisplayName(url));
        }
        rebuilt.push(url);
        continue;
      }
      rebuilt.push(line);
    }
    out = rebuilt.join('\n');
    out = out.replace(
      /((?:https?:\/\/|www\.)\S+)\s*\n+(?=(?!https?:\/\/|www\.)[^\n]{1,160}\n(?:https?:\/\/|www\.)\S+)/gi,
      '$1\n\n'
    );
  }

  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function polishAnswer(text) {
  return formatReplyLinks(stripKnowledgeAttribution(stripDoubleHyphens(text)));
}

function usable(text) {
  return Boolean(text) && !text.includes('BOT_NO_ANSWER');
}

async function generateAnswer(question, contextChunks, extras = {}) {
  if (extras.translateDoc || extras.summarizeDoc || extras.docWork) {
    const worked = await once(
      question,
      contextChunks,
      { ...extras, aboutChat: false, chatContext: '' },
      true
    );
    if (usable(worked)) return polishAnswer(worked);
    return 'BOT_NO_ANSWER';
  }

  if (extras.fromMedia) {
    const media = await once(
      question,
      contextChunks?.length ? contextChunks : [],
      { ...extras, aboutChat: false, chatContext: extras.quoted ? extras.chatContext : '' },
      true
    );
    if (usable(media)) return polishAnswer(media);
    return 'BOT_NO_ANSWER';
  }

  const hasContext = Boolean(
    contextChunks?.length || (!extras.requireKnown && (extras.chatContext || extras.quoted))
  );

  if (extras.aboutChat && !extras.requireKnown) {
    const recap = await once(question, contextChunks, extras, true);
    if (usable(recap)) return polishAnswer(recap);
  }

  if (hasContext && !extras.aboutChat) {
    const grounded = await once(question, contextChunks, extras, false);
    if (usable(grounded)) return polishAnswer(grounded);
  }

  // Untagged group replies must come from known material, not general guessing
  if (extras.requireKnown) return 'BOT_NO_ANSWER';

  // In groups, do not invent local/people answers from general knowledge
  if (extras.isGroup && looksLikeLocalOrPeopleAsk(question)) {
    return 'BOT_NO_ANSWER';
  }

  const general = await once(question, contextChunks, extras, true);
  if (usable(general)) return polishAnswer(general);
  return 'BOT_NO_ANSWER';
}

function looksLikeLocalOrPeopleAsk(question) {
  const t = String(question || '').toLowerCase();
  // Only block inventing *people* from general knowledge — not materials/deadlines/links
  return /\b(who (is|are)|anyone|anybody|somebody|whose name|full name|member(s)? (from|in)|student(s)? (from|in)|classmate(s)?|people from|who'?s from)\b/i.test(
    t
  );
}

module.exports = { generateAnswer, polishAnswer, MODEL: () => (typeof MODEL === 'function' ? MODEL() : MODEL) };
