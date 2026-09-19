const { getEmbedding } = require('../ai/embeddings');
const { generateAnswer } = require('../ai/generator');
const { searchAll } = require('../ai/search');
const { statements, setQAEmbedding } = require('../db/queries');
const { isShareRequest, pickFilesToShare } = require('./share');
const { botHelpAnswer, greetingAnswer, isChitchat, isAboutChat, isDocSummaryRequest, isFollowUp, needsBroadKnowledge } = require('./intent');
const { formatChatContext } = require('./history');
const { userAskLanguage } = require('../ai/language');

function getBotMode() {
  try {
    const row = statements.getSetting.get('bot_mode');
    if (row?.value) return row.value;
  } catch {
    /* fall through */
  }
  return process.env.BOT_MODE || 'auto';
}

function getPrivateChats() {
  try {
    const row = statements.getSetting.get('private_chats');
    if (row?.value === 'off' || row?.value === 'on') return row.value;
  } catch {
    /* fall through */
  }
  return process.env.PRIVATE_CHATS === 'off' ? 'off' : 'on';
}

function setPrivateChats(enabled) {
  const value = enabled ? 'on' : 'off';
  statements.setSetting.run('private_chats', value);
  process.env.PRIVATE_CHATS = value;
  return value;
}

function privateChatsEnabled() {
  return getPrivateChats() !== 'off';
}

function fileCaption(files, lang = 'en') {
  if (!files.length) return '';
  if (lang === 'fr') {
    if (files.length === 1) return `Voici ${files[0].fileName}`;
    return `Voici les fichiers : ${files.map((f) => f.fileName).join(', ')}`;
  }
  if (lang === 'es') {
    if (files.length === 1) return `Aquí está ${files[0].fileName}`;
    return `Aquí están los archivos: ${files.map((f) => f.fileName).join(', ')}`;
  }
  if (lang === 'pt') {
    if (files.length === 1) return `Aqui está ${files[0].fileName}`;
    return `Aqui estão os arquivos: ${files.map((f) => f.fileName).join(', ')}`;
  }
  if (lang === 'it') {
    if (files.length === 1) return `Ecco ${files[0].fileName}`;
    return `Ecco i file: ${files.map((f) => f.fileName).join(', ')}`;
  }
  if (lang === 'tn') {
    if (files.length === 1) return `Fa ke ${files[0].fileName}`;
    return `Tse ke difaele: ${files.map((f) => f.fileName).join(', ')}`;
  }
  if (files.length === 1) return `Here's ${files[0].fileName}`;
  return `Here are the files: ${files.map((f) => f.fileName).join(', ')}`;
}

function knowledgeCount() {
  try {
    return statements.allDocs.all().length;
  } catch {
    return 0;
  }
}

function recapFallback(chatHistory) {
  const lines = chatHistory || [];
  if (!lines.length) {
    return "I don't have this group's older messages loaded yet, so I can't recap from the start. Ask again after more of the chat comes through, or tell me a specific topic.";
  }
  const bits = lines.slice(-18).map((line) => {
    const who = line.fromMe ? 'askBack' : line.name || 'Someone';
    return `• ${who}: ${String(line.text || '').slice(0, 160)}`;
  });
  return `I don't have every message from when this group started, but here's what I can see recently:\n${bits.join('\n')}`;
}

function searchBlob(question, quoted, chatHistory) {
  const parts = [question, quoted];
  if (isFollowUp(question)) {
    const recent = (chatHistory || [])
      .slice(-6)
      .map((line) => line.text)
      .filter(Boolean);
    parts.push(...recent);
  }
  return parts.filter(Boolean).join('\n').slice(0, 2000);
}

function knowledgeForSummary(text) {
  const docs = statements.allDocs.all().filter((doc) => Number(doc.chunk_count || 0) > 0);
  if (!docs.length) return [];
  const q = String(text || '').toLowerCase();
  const named = docs.find((doc) => {
    const title = String(doc.title || '').trim().toLowerCase();
    const filename = String(doc.filename || '').toLowerCase();
    const stem = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    return (
      (title.length >= 3 && q.includes(title)) ||
      (filename.length >= 3 && q.includes(filename)) ||
      (stem.length >= 3 && q.includes(stem))
    );
  });
  const pick = named || docs[0];
  return statements.chunksByDoc.all(pick.id, 12).map((chunk) => ({
    document_id: chunk.document_id,
    content: chunk.content,
    score: 1,
  }));
}

/**
 * Resolve a reply for an inbound question from a private chat or a group.
 * Returns null when the bot should stay silent.
 */
async function answerQuestion(
  rawText,
  {
    chatJid,
    chatName,
    isGroup = false,
    chatHistory = [],
    quoted = '',
    fromVoice = false,
    fromMedia = false,
    caption = '',
    language = '',
  } = {}
) {
  if (getBotMode() === 'off') return null;

  let text = String(rawText || '').trim();
  if (!fromMedia) text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const lang = userAskLanguage(text, {
    caption: fromMedia ? caption : '',
    hinted: language,
  }) || (fromMedia ? 'en' : '');

  const greet = greetingAnswer(text);
  if (greet && (!isGroup || fromVoice) && !fromMedia) {
    const englishGreet = /I'm askBack/.test(greet);
    if (!englishGreet || !lang || lang === 'en') {
      return { text: greet, source: 'help', files: [], language: lang || 'en' };
    }
  }

  if (isChitchat(text) && !isAboutChat(text) && !fromVoice && !fromMedia) return null;

  const help = botHelpAnswer(text, lang);
  if (help) return { text: help, source: 'help', files: [], language: lang };

  const baseMax = parseInt(process.env.MAX_QUESTION_LENGTH || '2000', 10);
  const maxLen = fromMedia ? Math.max(baseMax, 8000) : baseMax;
  if (text.length > maxLen) text = text.slice(0, maxLen);
  const aboutChat = fromMedia ? false : isAboutChat(text);
  const chatContext = fromMedia
    ? ''
    : formatChatContext((chatHistory || []).slice(aboutChat ? -120 : -40));
  const hasDocs = !fromMedia && knowledgeCount() > 0;

  const wantsShare = isShareRequest(text);
  const wantsDocSummary = isDocSummaryRequest(text);
  let embedding = null;
  let repeated = [];
  let knowledge = [];
  if (wantsDocSummary && hasDocs) {
    knowledge = knowledgeForSummary(text);
    if (!knowledge.length) {
      return {
        text: 'I do not have a document loaded to summarize yet. Add one on Knowledge, then ask again.',
        source: 'help',
        files: [],
        language: lang || 'en',
      };
    }
  } else if (hasDocs) {
    // Always search generously — groups used to use a stricter threshold and
    // missed the same knowledge that private chats found (e.g. class links).
    const broad = needsBroadKnowledge(text);
    embedding = await getEmbedding(searchBlob(text, quoted, chatHistory));
    ({ repeated, knowledge } = searchAll(embedding, {
      loose: true,
      query: text,
      limit: broad ? 18 : undefined,
    }));
    if (!knowledge.length) {
      ({ repeated, knowledge } = searchAll(embedding, {
        loose: true,
        query: searchBlob(text, quoted, chatHistory),
        limit: 18,
      }));
    }
  }
  const files = wantsShare ? pickFilesToShare(text, { knowledge, repeated, wantsShare: true }) : [];

  if (wantsShare && files.length) {
    return {
      text: fileCaption(files, lang),
      source: 'share',
      files,
      language: lang,
    };
  }

  // Reuse a strong prior answer even in busy group chats.
  // Also allow this for link/class questions so a private answer is not lost in-group.
  if (
    repeated.length &&
    !aboutChat &&
    !fromMedia &&
    !isFollowUp(text) &&
    (lang === 'en' || !lang) &&
    Number(repeated[0]?.score || 0) >= (needsBroadKnowledge(text) ? 0.9 : 0.88)
  ) {
    const best = repeated[0];
    return {
      text: best.answer,
      source: 'repeat',
      score: best.score,
      files: [],
      language: lang || 'en',
    };
  }

  console.log(
    `[whatsapp] answering in ${lang || 'the question language'}${fromMedia ? ' (from media)' : wantsDocSummary ? ' (doc summary)' : ''}${isGroup ? ' (group)' : ''}${knowledge.length ? ` kb=${knowledge.length}` : ' kb=0'}`
  );
  // For knowledge questions, keep only a light slice of live chat so group noise
  // does not drown uploaded material (class links, forms, etc.).
  const promptChat =
    wantsDocSummary || fromMedia
      ? ''
      : aboutChat
        ? chatContext
        : knowledge.length
          ? formatChatContext((chatHistory || []).slice(-12))
          : chatContext;
  const generated = (
    await generateAnswer(text, knowledge, {
      chatContext: promptChat,
      quoted,
      aboutChat: wantsDocSummary ? false : aboutChat,
      fromMedia,
      fromVoice,
      summarizeDoc: wantsDocSummary,
      language: lang,
    })
  ).trim();
  if (!generated || generated.includes('BOT_NO_ANSWER')) {
    if (aboutChat) {
      return { text: recapFallback(chatHistory), source: 'generated', files: [], language: lang || 'en' };
    }
    console.log('[whatsapp] did not understand — staying silent');
    return null;
  }

  if (embedding) {
    const score = knowledge[0]?.score;
    const documentId = knowledge[0]?.document_id || null;
    const id = statements.insertQA.run(
      chatJid,
      chatName || '',
      text,
      generated,
      score ?? null,
      'generated',
      documentId
    ).lastInsertRowid;
    setQAEmbedding(id, embedding);
  }

  return { text: generated, source: 'generated', files: [], language: lang };
}

module.exports = { answerQuestion, getBotMode, getPrivateChats, setPrivateChats, privateChatsEnabled };
