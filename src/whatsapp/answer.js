const { getEmbedding } = require('../ai/embeddings');
const { generateAnswer } = require('../ai/generator');
const { searchAll } = require('../ai/search');
const { statements, setQAEmbedding } = require('../db/queries');
const { isShareRequest, isShareFollowUp, pickFilesToShare, shareAskText } = require('./share');
const {
  botHelpAnswer,
  greetingAnswer,
  isChitchat,
  isCasualTalk,
  isAboutChat,
  isDocSummaryRequest,
  isDocWorkRequest,
  isTranslateRequest,
  isFollowUp,
  needsBroadKnowledge,
  isKnowledgeAsk,
  isMeetingCatchupRequest,
} = require('./intent');
const { formatChatContext } = require('./history');
const { resolveUserAskLanguage } = require('../ai/language');
const { isCatchupRequest, buildCatchup } = require('./catchup');
const { newestMeetingSummary } = require('./meetings');

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

/** @returns {'on'|'off'} whether the "this came up before" nudge is enabled. */
function getRepeatNudge() {
  try {
    const row = statements.getSetting.get('repeat_nudge');
    if (!row?.value) return 'on';
    return row.value === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

/** Turn the repeat nudge on/off. @returns {'on'|'off'} */
function setRepeatNudge(enabled) {
  const value = enabled ? 'on' : 'off';
  statements.setSetting.run('repeat_nudge', value);
  return value;
}

/** @returns {'on'|'off'} whether the "Source: <file>" footer is enabled. */
function getShowSources() {
  try {
    const row = statements.getSetting.get('show_sources');
    if (!row?.value) return 'on';
    return row.value === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

/** Turn source citations on/off. @returns {'on'|'off'} */
function setShowSources(enabled) {
  const value = enabled ? 'on' : 'off';
  statements.setSetting.run('show_sources', value);
  return value;
}

/**
 * A short, human relative date in CAT (Africa/Maputo) for a stored timestamp,
 * used by the repeat nudge and citation footer. Examples: "earlier today",
 * "yesterday", "on Tue 16 Sep".
 * @param {string|number} when a SQLite datetime string or ms/seconds timestamp
 */
function relativeCatDate(when) {
  const TZ = 'Africa/Maputo';
  let ms;
  if (typeof when === 'number') {
    ms = when > 1e12 ? when : when * 1000;
  } else {
    const s = String(when || '').trim();
    if (!s) return '';
    // SQLite datetime('now') stores UTC without a zone marker.
    ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  }
  if (!Number.isFinite(ms)) return '';

  const dayKey = (t) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(t));

  const today = dayKey(Date.now());
  const then = dayKey(ms);
  const oneDay = 24 * 60 * 60 * 1000;
  const yesterday = dayKey(Date.now() - oneDay);

  if (then === today) return 'earlier today';
  if (then === yesterday) return 'yesterday';
  return `on ${new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(ms))}`;
}

/**
 * Append a one-line source citation to a knowledge-based answer, when enabled
 * and a real document backed the answer. Recording docs read "from <title>";
 * everything else reads "Source: <title>". Never mentions "knowledge files".
 * @param {string} text the generated answer
 * @param {number|null} documentId the top knowledge chunk's document id
 */
function withSourceCitation(text, documentId) {
  if (getShowSources() === 'off') return text;
  if (!documentId) return text;
  let doc;
  try {
    doc = statements.getDoc.get(documentId);
  } catch {
    return text;
  }
  if (!doc) return text;
  const title = String(doc.title || doc.filename || '').trim();
  if (!title) return text;
  if (text.includes(title)) return text; // already named it, do not repeat

  const type = String(doc.type || '').toLowerCase();
  const footer =
    type === 'audio' || type === 'video' ? `from ${title}` : `Source: ${title}`;
  return `${text.trim()}\n\n${footer}`;
}

function fileCaption(_files, _lang = 'en') {
  // Attachments speak for themselves — never list long filenames in chat first
  return '';
}

function knowledgeCount() {
  try {
    return statements.allKnowledgeDocs.all().length;
  } catch {
    try {
      return statements.allDocs.all().filter((d) => String(d.type) !== 'sticker').length;
    } catch {
      return 0;
    }
  }
}

function looksUncertainAnswer(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return true;
  return (
    /\b(i('m| am) not sure|not certain|i don't know|i do not know|no idea|cannot find|can't find|i think maybe|might be|possibly|unclear|i('m| am) unsure)\b/i.test(
      t
    ) || /\b(sorry,? i (don't|do not|can't|cannot))\b/i.test(t)
  );
}

/** Bot should never interview people for their identity. */
function looksLikeIdentityProbe(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return (
    /\b(what('?s| is) your name|who are you|may i (know|have) your name|tell me your name|can (i|you) (get|know|share|give) your name|your (full )?name\s*\?|what should i call you|introduce yourself)\b/i.test(
      t
    ) ||
    /\b(comment (tu|vous) t'?appelles|comment vous appelez|quel est ton nom|comment tu t'?appelles)\b/i.test(t) ||
    /\b(cómo te llamas|cuál es tu nombre|como te llamas)\b/i.test(t) ||
    /\b(qual (é|e) (o )?seu nome|como (você|voce) se chama)\b/i.test(t) ||
    /\b(come ti chiami|come ti chiama)\b/i.test(t) ||
    /\b(leina la gago|o mang)\b/i.test(t)
  );
}

function hasConfidentKnowledge(knowledge, { broad = false } = {}) {
  if (!knowledge?.length) return false;
  const top = Number(knowledge[0]?.score);
  if (!Number.isFinite(top)) return true; // lexical-only hit still counts as a hit
  // Untagged groups need a clearer match than private/tagged
  const min = broad ? 0.42 : 0.5;
  return top >= min;
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

function knowledgeForDocWork(text) {
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
  return statements.chunksByDoc.all(pick.id, 36).map((chunk) => ({
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
    requireKnown = false,
  } = {}
) {
  if (getBotMode() === 'off') return null;

  let text = String(rawText || '').trim();
  if (!fromMedia) text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const lang = await resolveUserAskLanguage(text, {
    caption: fromMedia ? caption : '',
    hinted: language,
  });
  if (lang) {
    console.log(`[whatsapp] reply language: ${lang}`);
  }

  const greet = greetingAnswer(text);
  if (greet && (!isGroup || fromVoice) && !fromMedia && !requireKnown) {
    const englishGreet = /I'm askBack/.test(greet);
    if (!englishGreet || !lang || lang === 'en') {
      return { text: greet, source: 'help', files: [], language: lang || 'en' };
    }
  }

  if (isChitchat(text) && !isAboutChat(text) && !fromVoice && !fromMedia) return null;
  if (requireKnown && isCasualTalk(text) && !fromMedia) {
    console.log('[whatsapp] untagged group — casual talk, staying silent');
    return null;
  }

  const help = botHelpAnswer(text, lang);
  if (help && !requireKnown) return { text: help, source: 'help', files: [], language: lang };

  // Feature: "what did I miss in the last meeting/call" — return the newest
  // recording's stored summary instead of a generic chat recap.
  if (!fromMedia && isMeetingCatchupRequest(text)) {
    const meeting = newestMeetingSummary();
    if (meeting) {
      return {
        text: `Here's what I have from ${meeting.title}:\n\n${meeting.text}`,
        source: 'meeting',
        files: [],
        language: lang || 'en',
      };
    }
    if (requireKnown) {
      console.log('[whatsapp] untagged meeting-catchup — no recording, staying silent');
      return null;
    }
    return {
      text: 'I do not have a meeting or call recording loaded yet. Upload one on Knowledge and I will summarize it.',
      source: 'help',
      files: [],
      language: lang || 'en',
    };
  }

  // Feature: time-window catch-up — "catch me up", "what did I miss since Monday".
  if (!fromMedia && isCatchupRequest(text)) {
    const recap = await buildCatchup(chatJid, text, { language: lang || 'en' });
    if (recap) return recap;
    if (requireKnown) return null;
  }

  const baseMax = parseInt(process.env.MAX_QUESTION_LENGTH || '2000', 10);
  const maxLen = fromMedia ? Math.max(baseMax, 35000) : baseMax;
  if (text.length > maxLen) text = text.slice(0, maxLen);
  const aboutChat = fromMedia ? false : isAboutChat(text);
  // Untagged group: skip chat-recap asks — those still need a tag
  if (requireKnown && aboutChat) {
    console.log('[whatsapp] untagged recap ask — staying silent (tag me for chat recaps)');
    return null;
  }

  const askForShare = shareAskText(caption || text) || shareAskText(text) || text;
  const wantsShare =
    isShareRequest(text) ||
    isShareRequest(askForShare) ||
    isShareFollowUp(askForShare, chatHistory, chatJid) ||
    isShareFollowUp(text, chatHistory, chatJid);
  const wantsDocSummary = isDocSummaryRequest(askForShare) || isDocSummaryRequest(text);
  const wantsTranslate = isTranslateRequest(askForShare) || isTranslateRequest(text);
  const wantsDocWork = isDocWorkRequest(askForShare) || isDocWorkRequest(text) || wantsDocSummary || wantsTranslate;

  // File/media asks must search the library even when the user also quoted another attachment
  const hasDocs = knowledgeCount() > 0 && (!fromMedia || wantsShare);

  const chatContext = fromMedia && !wantsShare
    ? ''
    : formatChatContext((chatHistory || []).slice(aboutChat ? -120 : -40));

  // Untagged group: only knowledge / materials asks — do not jump into chat
  if (
    requireKnown &&
    !fromMedia &&
    !wantsShare &&
    !wantsDocWork &&
    !isKnowledgeAsk(text) &&
    !isKnowledgeAsk(askForShare)
  ) {
    console.log('[whatsapp] untagged group — not a knowledge ask, staying silent');
    return null;
  }
  let embedding = null;
  let repeated = [];
  let knowledge = [];
  if (wantsDocWork && hasDocs && !wantsShare) {
    knowledge = knowledgeForDocWork(text);
    if (!knowledge.length) {
      if (requireKnown) {
        console.log('[whatsapp] untagged doc ask — no document, staying silent');
        return null;
      }
      return {
        text: 'I do not have a document loaded yet. Add one on Knowledge, then ask again.',
        source: 'help',
        files: [],
        language: lang || 'en',
      };
    }
  } else if (wantsDocWork && requireKnown && !wantsShare) {
    console.log('[whatsapp] untagged doc ask — no knowledge docs, staying silent');
    return null;
  } else if (hasDocs) {
    // Always search generously — groups used to use a stricter threshold and
    // missed the same knowledge that private chats found (e.g. class links).
    const broad = needsBroadKnowledge(askForShare) || needsBroadKnowledge(text) || wantsShare;
    const searchText = wantsShare ? askForShare : searchBlob(text, quoted, chatHistory);
    embedding = await getEmbedding(searchText);
    ({ repeated, knowledge } = searchAll(embedding, {
      loose: !requireKnown || wantsShare,
      query: wantsShare ? askForShare : text,
      limit: broad ? 18 : undefined,
    }));
    if (!knowledge.length && (!requireKnown || wantsShare)) {
      ({ repeated, knowledge } = searchAll(embedding, {
        loose: true,
        query: wantsShare ? askForShare : searchBlob(text, quoted, chatHistory),
        limit: 18,
      }));
    }
  }
  const files = wantsShare
    ? pickFilesToShare(askForShare || text, {
        knowledge,
        repeated,
        wantsShare: true,
        chatHistory,
        chatJid,
      })
    : [];

  if (wantsShare && files.length) {
    console.log(
      `[whatsapp] sharing file(s): ${files.map((f) => f.fileName).join(', ')}`
    );
    return {
      text: fileCaption(files, lang),
      source: 'share',
      files,
      language: lang,
    };
  }

  if (wantsShare && !files.length) {
    if (requireKnown) {
      console.log('[whatsapp] media ask — no attachable file found, staying silent');
      return null;
    }
    return {
      text: "I couldn't find that file stored for sending. Re-upload it on Knowledge, then ask me to send it again.",
      source: 'help',
      files: [],
      language: lang || 'en',
    };
  }

  // Reuse a strong prior answer even in busy group chats.
  // Also allow this for link/class questions so a private answer is not lost in-group.
  // Never short-circuit media/share asks — those must attach files.
  if (
    repeated.length &&
    !aboutChat &&
    !fromMedia &&
    !wantsShare &&
    !isFollowUp(text) &&
    (lang === 'en' || !lang) &&
    Number(repeated[0]?.score || 0) >= (needsBroadKnowledge(text) ? 0.9 : 0.88)
  ) {
    const best = repeated[0];
    let prefix = '';
    if (getRepeatNudge() === 'on') {
      let when = '';
      try {
        const row = statements.getQAById.get(best.id);
        when = relativeCatDate(row?.created_at);
      } catch {
        /* no timestamp — nudge without a date */
      }
      prefix = when
        ? `This came up before (${when}), here's the answer:\n\n`
        : "This came up before, here's the answer:\n\n";
    }
    return {
      text: `${prefix}${best.answer}`,
      source: 'repeat',
      score: best.score,
      files: [],
      language: lang || 'en',
    };
  }

  const broad = needsBroadKnowledge(text) || wantsShare;
  if (requireKnown && !hasConfidentKnowledge(knowledge, { broad }) && !repeated.length) {
    console.log('[whatsapp] untagged group ask — not sure enough, staying silent');
    return null;
  }

  console.log(
    `[whatsapp] answering in ${lang || 'the question language'}${fromMedia ? ' (from media)' : wantsTranslate ? ' (doc translate)' : wantsDocSummary ? ' (doc summary)' : wantsDocWork ? ' (doc work)' : ''}${isGroup ? ' (group)' : ''}${knowledge.length ? ` kb=${knowledge.length}` : ' kb=0'}${requireKnown ? ' known-only' : ''}`
  );
  // For knowledge questions, keep only a light slice of live chat so group noise
  // does not drown uploaded material (class links, forms, etc.).
  // Untagged known-only: no live chat — avoid guessing from group noise.
  const promptChat =
    wantsDocWork || fromMedia || requireKnown
      ? ''
      : aboutChat
        ? chatContext
        : knowledge.length
          ? formatChatContext((chatHistory || []).slice(-12))
          : chatContext;
  const generated = (
    await generateAnswer(text, knowledge, {
      chatContext: promptChat,
      quoted: requireKnown ? '' : quoted,
      aboutChat: wantsDocWork || requireKnown ? false : aboutChat,
      fromMedia,
      fromVoice,
      summarizeDoc: wantsDocSummary && !wantsTranslate,
      translateDoc: wantsTranslate,
      docWork: wantsDocWork && !wantsDocSummary && !wantsTranslate,
      language: lang,
      requireKnown,
      isGroup,
    })
  ).trim();
  if (
    !generated ||
    generated.includes('BOT_NO_ANSWER') ||
    looksLikeIdentityProbe(generated) ||
    (requireKnown && looksUncertainAnswer(generated))
  ) {
    if (looksLikeIdentityProbe(generated)) {
      console.log('[whatsapp] blocked identity-probe reply — staying silent');
      return null;
    }
    if (aboutChat && !requireKnown) {
      return { text: recapFallback(chatHistory), source: 'generated', files: [], language: lang || 'en' };
    }
    console.log(
      requireKnown
        ? '[whatsapp] untagged group — unsure, staying silent'
        : '[whatsapp] did not understand — staying silent'
    );
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

  // Feature: source citation. Only for answers actually grounded in a document
  // (not chat recaps, doc-work summaries, media reads, or general knowledge).
  const citeDocId =
    !aboutChat && !fromMedia && !wantsDocWork && knowledge.length
      ? knowledge[0]?.document_id || null
      : null;
  const finalText = withSourceCitation(generated, citeDocId);

  return { text: finalText, source: 'generated', files: [], language: lang };
}

module.exports = {
  answerQuestion,
  getBotMode,
  getPrivateChats,
  setPrivateChats,
  privateChatsEnabled,
  getRepeatNudge,
  setRepeatNudge,
  getShowSources,
  setShowSources,
};
