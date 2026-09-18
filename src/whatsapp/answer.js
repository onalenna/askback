const { getEmbedding } = require('../ai/embeddings');
const { generateAnswer } = require('../ai/generator');
const { searchAll } = require('../ai/search');
const { statements, setQAEmbedding } = require('../db/queries');
const { isShareRequest, pickFilesToShare } = require('./share');
const { botHelpAnswer, greetingAnswer, isChitchat, isAboutChat } = require('./intent');
const { formatChatContext } = require('./history');
const { detectLanguage } = require('../ai/language');

function getBotMode() {
  try {
    const row = statements.getSetting.get('bot_mode');
    if (row?.value) return row.value;
  } catch {
    /* fall through */
  }
  return process.env.BOT_MODE || 'auto';
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

function searchBlob(question, quoted, chatHistory) {
  const recent = (chatHistory || [])
    .slice(-12)
    .map((line) => line.text)
    .filter(Boolean);
  return [question, quoted, ...recent].filter(Boolean).join('\n').slice(0, 2000);
}

/**
 * Resolve a reply for an inbound question from a private chat or a group.
 * Returns null when the bot should stay silent.
 */
async function answerQuestion(
  rawText,
  { chatJid, chatName, isGroup = false, chatHistory = [], quoted = '' } = {}
) {
  if (getBotMode() === 'off') return null;

  let text = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const greet = !isGroup ? greetingAnswer(text) : null;
  if (greet) return { text: greet, source: 'help', files: [] };

  if (isChitchat(text) && !quoted && !isAboutChat(text)) return null;

  const help = botHelpAnswer(text);
  if (help) return { text: help, source: 'help', files: [] };

  const maxLen = parseInt(process.env.MAX_QUESTION_LENGTH || '2000', 10);
  if (text.length > maxLen) text = text.slice(0, maxLen);

  const lang = detectLanguage(text);
  const chatContext = formatChatContext(chatHistory);
  const hasChat = Boolean(chatContext || quoted);
  const hasDocs = knowledgeCount() > 0;

  const wantsShare = isShareRequest(text);
  let embedding = null;
  let repeated = [];
  let knowledge = [];
  if (hasDocs) {
    embedding = await getEmbedding(searchBlob(text, quoted, chatHistory));
    ({ repeated, knowledge } = searchAll(embedding, { loose: !isGroup || hasChat }));
  }
  const files = pickFilesToShare(text, { knowledge, repeated, wantsShare });

  if (wantsShare && files.length) {
    return {
      text: fileCaption(files, lang),
      source: 'share',
      files,
    };
  }

  if (repeated.length && !hasChat && lang === 'en') {
    const best = repeated[0];
    return {
      text: best.answer,
      source: 'repeat',
      score: best.score,
      files,
    };
  }

  const generated = (
    await generateAnswer(text, knowledge, {
      chatContext,
      quoted,
      aboutChat: isAboutChat(text),
    })
  ).trim();
  if (!generated || generated.includes('BOT_NO_ANSWER')) {
    if (files.length) {
      return { text: fileCaption(files, lang), source: 'share', files };
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

  return { text: generated, source: 'generated', files };
}

module.exports = { answerQuestion, getBotMode };
