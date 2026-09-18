const { answerQuestion } = require('./answer');
const {
  getAudioMessage,
  isVoiceNote,
  transcribeVoiceNote,
  sendVoiceReply,
} = require('./voice');
const { sendSharedFiles } = require('./share');
const { getGroupMeta, isBroadcastGroup, claimExclusiveGroupReply, isGroupAllowed } = require('./groups');
const {
  relatedMentionPeople,
  withMentions,
  messageMentionsBot,
  mentionJidList,
  rememberSelfFromMessage,
} = require('./mentions');
const { getAdminJids } = require('./admins');
const { phrase } = require('../ai/language');
const { isAboutChat } = require('./intent');
const { translateToEnglish } = require('../ai/translate');
const { hasUnderstandableMedia, inspectMessageMedia, understandMessageMedia } = require('./media');
const {
  getOffer,
  clearOffer,
  wantsTranslation,
  declinesTranslation,
} = require('./translate-offer');
const {
  extractText,
  extractQuotedText,
  rememberMessage,
  rememberWaMessage,
  rememberOutbound,
  recentChatLines,
  ensureChatHistory,
  formatChatContext,
  isGroupChat,
  isPrivateChat,
  isIgnoredChat,
} = require('./history');

function addressedBot(msg, sock, text) {
  return messageMentionsBot(msg, sock, text);
}

function cleanQuestion(text) {
  return text
    .replace(/@\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trackMessage(msg, extraText) {
  const chatJid = msg?.key?.remoteJid;
  if (isIgnoredChat(chatJid)) return;
  const text = extraText || extractText(msg);
  const quoted = extractQuotedText(msg);
  if (!text && !quoted) return;
  rememberMessage(chatJid, {
    id: msg.key.id,
    fromMe: !!msg.key.fromMe,
    name: msg.pushName || '',
    text: text || quoted,
    quoted,
    ts: Number(msg.messageTimestamp || Date.now() / 1000),
    raw: msg.message || null,
  });
}

function rememberSent(chatJid, sent, text = '') {
  rememberOutbound(chatJid, sent, text);
}

async function sendAnswer(sock, chatJid, text, { msg, mentions = [], asVoice = false, language = '' } = {}) {
  const mentionIds = mentionJidList(mentions, sock, chatJid);
  if (asVoice) {
    const sent = await sendVoiceReply(sock, chatJid, text, msg, mentionIds, language);
    if (sent) {
      rememberSent(chatJid, sent, text);
      console.log('[whatsapp] replied with lemonfox voice note');
      return 'voice';
    }
    console.warn('[whatsapp] voice reply failed — sending text');
  }
  const sent = await sock.sendMessage(chatJid, withMentions(text, mentions, sock, chatJid), { quoted: msg });
  rememberSent(chatJid, sent, text);
  return 'text';
}

async function fulfillTranslation(sock, yesMsg, chatJid, meta, offer) {
  let english = '';
  try {
    english = await translateToEnglish(offer.text);
  } catch (err) {
    console.error('[whatsapp] translation failed:', err.message || err);
    await sendAnswer(sock, chatJid, 'I could not translate that just now. Try again in a moment.', {
      msg: yesMsg,
      mentions: relatedMentionPeople(yesMsg, sock, meta),
      language: 'en',
    });
    return;
  }
  if (!english) return;

  await ensureChatHistory(sock, chatJid, yesMsg, { wait: true });
  const chatHistory = recentChatLines(chatJid, yesMsg.key.id);
  let answer = '';
  const result = await answerQuestion(english, {
    chatJid,
    chatName: meta?.subject || '',
    isGroup: true,
    chatHistory,
    quoted: offer.text,
    language: 'en',
  });
  if (result?.text) answer = result.text;

  const body = answer
    ? `Translation:\n${english}\n\n${answer}`
    : `Translation:\n${english}`;

  await sendAnswer(sock, chatJid, body, {
    msg: offer.msg || yesMsg,
    mentions: relatedMentionPeople(yesMsg, sock, meta),
    language: 'en',
  });
  console.log(`[whatsapp] translated to English${answer ? ' and answered' : ''} in ${meta?.subject || chatJid}`);
}

function createMessageHandler(getSock) {
  const pending = new Set();
  const answered = new Set();

  return async function onMessagesUpsert({ type, messages }) {
    const sock = getSock();
    if (!sock) return;

    for (const msg of messages) {
      if (msg?.key) rememberSelfFromMessage(msg);
      if (msg?.message) rememberWaMessage(msg);
      if (type !== 'notify') continue;
      try {
        await handleOne(sock, msg, pending, answered);
      } catch (err) {
        console.error('[whatsapp] handler error:', err.message || err);
      }
    }
  };
}

async function handleOne(sock, msg, pending, answered) {
  if (!msg.message || msg.key.fromMe) return;

  const chatJid = msg.key.remoteJid;
  if (isIgnoredChat(chatJid)) return;

  const isGroup = isGroupChat(chatJid);
  const isPrivate = isPrivateChat(chatJid);
  if (!isGroup && !isPrivate) return;
  if (isGroup && !isGroupAllowed(chatJid)) return;

  const rawText = extractText(msg);
  const quoted = extractQuotedText(msg);
  const hasAudio = !!getAudioMessage(msg);
  const voiceIn = isVoiceNote(msg) || (!rawText && hasAudio);
  const mediaInfo = inspectMessageMedia(msg);
  const hasMedia = hasUnderstandableMedia(msg);
  if (!rawText && !hasAudio && !hasMedia) return;

  let chatName = isPrivate ? 'private' : '';
  let meta = null;
  if (isGroup) {
    try {
      meta = await getGroupMeta(sock, chatJid);
      chatName = meta?.subject || '';
    } catch {
      chatName = '';
    }
    if (isBroadcastGroup(meta)) {
      console.log(`[whatsapp] skip community hub ${chatName || chatJid}`);
      return;
    }
  }

  const textForOffer = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (isGroup && textForOffer) {
    const offer = getOffer(chatJid);
    if (offer && declinesTranslation(textForOffer)) {
      clearOffer(chatJid);
      console.log('[whatsapp] translation declined — staying silent');
      return;
    }
    if (offer && wantsTranslation(textForOffer)) {
      clearOffer(chatJid);
      await fulfillTranslation(sock, msg, chatJid, meta, offer);
      return;
    }
  }

  const taggedEarly = addressedBot(msg, sock, rawText);
  if (isGroup && !taggedEarly) {
    const preview = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (preview) console.log(`[whatsapp] skip group, not tagged: ${preview}`);
    return;
  }

  const dedupeKey = `${chatJid}:${msg.key.id}`;
  if (answered.has(dedupeKey) || pending.has(dedupeKey)) return;
  pending.add(dedupeKey);

  try {
    let raw = rawText;
    let spokenLang = '';
    let fromMedia = false;
    if (hasAudio && (!raw || voiceIn)) {
      console.log('[whatsapp] voice note received — transcribing');
      try {
        await sock.sendPresenceUpdate('recording', chatJid);
      } catch {
        /* presence is optional */
      }
      try {
        const heard = await transcribeVoiceNote(sock, msg, {
          chatContext: formatChatContext(recentChatLines(chatJid, msg.key.id)),
          quoted,
        });
        if (heard?.text) {
          raw = heard.text;
          spokenLang = heard.language || '';
        }
      } catch (err) {
        console.error('[whatsapp] voice note transcription failed:', err.message || err);
      }
      if (raw && raw !== rawText) {
        trackMessage(msg, raw);
        console.log(`[whatsapp] voice note understood: ${raw.slice(0, 80)}`);
      } else if (!raw) {
        console.log('[whatsapp] did not understand the audio — staying silent');
        return;
      }
    }

    if (hasMedia && (taggedEarly || isPrivate)) {
      if (mediaInfo?.archive) {
        const taggedZip = addressedBot(msg, sock, raw);
        if (taggedZip || isPrivate) {
          await sendAnswer(sock, chatJid, phrase('skipZip', spokenLang || 'en'), {
            msg,
            mentions: isGroup ? relatedMentionPeople(msg, sock, meta) : [],
            language: spokenLang || 'en',
          });
        }
        console.log('[whatsapp] skipped zip attachment');
        return;
      }
      try {
        await sock.sendPresenceUpdate('composing', chatJid);
      } catch {
        /* presence is optional */
      }
      console.log(`[whatsapp] reading ${mediaInfo?.kind || 'media'} attachment`);
      try {
        const seen = await understandMessageMedia(sock, msg, { caption: rawText, quoted });
        if (seen.archive) {
          await sendAnswer(sock, chatJid, phrase('skipZip', spokenLang || 'en'), {
            msg,
            mentions: isGroup ? relatedMentionPeople(msg, sock, meta) : [],
            language: spokenLang || 'en',
          });
          return;
        }
        if (seen.text) {
          fromMedia = true;
          raw = [raw, seen.text].filter(Boolean).join('\n\n');
          trackMessage(msg, raw);
          console.log(`[whatsapp] media understood: ${seen.text.slice(0, 80)}`);
        }
      } catch (err) {
        console.error('[whatsapp] media understand failed:', err.message || err);
      }
    }

    const tagged = addressedBot(msg, sock, rawText);
    let question = fromMedia ? String(raw || '').trim() : cleanQuestion(raw);
    if (!question && !tagged) return;
    if (isGroup && !tagged) return;

    if (isGroup) {
      if (!claimExclusiveGroupReply(msg, question || 'tag', chatJid, meta)) {
        console.log(`[whatsapp] already answering this question in another group — skip ${chatName || chatJid}`);
        return;
      }
    }

    const recap = !fromMedia && isAboutChat(rawText || question);
    await ensureChatHistory(sock, chatJid, msg, { wait: true, deep: recap });
    const chatHistory = recentChatLines(chatJid, msg.key.id);

    console.log(
      `[whatsapp] ${isPrivate ? 'private' : 'group'} message from ${chatName || chatJid}: ${(question || raw || '').slice(0, 80)} (${chatHistory.length} prior msgs, tagged=${tagged})`
    );

    const result = question
      ? await answerQuestion(question, {
          chatJid,
          chatName,
          isGroup,
          chatHistory,
          quoted,
          fromVoice: voiceIn,
          fromMedia,
          caption: rawText,
          language: spokenLang,
        })
      : null;

    const replyLang = result?.language || spokenLang;

    if (!result?.text && !result?.files?.length) {
      if (tagged && isGroup) {
        const adminJids = getAdminJids();
        const body = recap
          ? "I don't have this group's older messages loaded yet, so I can't recap from the start. Ask me a specific topic, or try again after more of the chat comes through."
          : phrase('noKnowledge', replyLang);
        await sendAnswer(sock, chatJid, body, {
          msg,
          mentions: recap ? relatedMentionPeople(msg, sock, meta) : adminJids,
          asVoice: voiceIn,
          language: replyLang || 'en',
        });
        console.log(recap ? '[whatsapp] recap fallback' : '[whatsapp] no knowledge — tagged admins');
        return;
      }
      console.log('[whatsapp] no answer — staying silent');
      return;
    }

    const mentionPeople = isGroup ? relatedMentionPeople(msg, sock, meta) : [];

    if (result.text) {
      await sendAnswer(sock, chatJid, result.text, {
        msg,
        mentions: mentionPeople,
        asVoice: voiceIn,
        language: replyLang,
      });
    }

    if (result.files?.length && result.source === 'share') {
      try {
        await sendSharedFiles(sock, chatJid, result.files, msg, mentionPeople);
        console.log(
          `[whatsapp] shared ${result.files.length} file(s): ${result.files.map((f) => f.fileName).join(', ')}`
        );
      } catch (err) {
        console.error('[whatsapp] failed to share file:', err.message || err);
        if (result.source === 'share') {
          await sendAnswer(sock, chatJid, phrase('fileSendFailed', replyLang), {
            msg,
            mentions: mentionPeople,
            asVoice: voiceIn,
            language: replyLang,
          });
        }
      }
    }

    console.log(
      `[whatsapp] replied (${result.source}) only to ${isGroup ? chatName || 'group' : 'private'} chat`
    );
    answered.add(dedupeKey);
  } finally {
    pending.delete(dedupeKey);
  }
}

module.exports = { createMessageHandler, extractText, cleanQuestion };
