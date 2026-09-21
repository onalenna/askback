const { answerQuestion, privateChatsEnabled } = require('./answer');
const { parseAvailabilityQuestion, availabilityAnswer } = require('./availability');
const {
  getAudioMessage,
  isVoiceNote,
  transcribeVoiceNote,
  sendVoiceReply,
} = require('./voice');
const { sendSharedFiles } = require('./share');
const { getGroupMeta, isBroadcastGroup, claimExclusiveGroupReply, isGroupAllowed, isObserverGroup } = require('./groups');
const {
  withMentions,
  messageAddressesBot,
  mentionJidList,
  rememberSelfFromMessage,
} = require('./mentions');
const { getAdminJids } = require('./admins');
const { phrase } = require('../ai/language');
const { isAboutChat, looksLikeQuestion, isKnowledgeAsk, isDocWorkRequest } = require('./intent');
const { isShareRequest } = require('./share');
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
const { resolveTagContext } = require('./thread');
const { startChatPresence } = require('./presence');

function addressedBot(msg, sock, text) {
  // @mention, @askback, or a direct reply to the bot's message
  return messageAddressesBot(msg, sock, text);
}

function cleanQuestion(text) {
  return text
    .replace(/@\d+/g, ' ')
    .replace(/@(askback|askbak)\b/gi, ' ')
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

async function sendLinkText(sock, chatJid, links, { msg, mentions = [], notifyInText = false } = {}) {
  if (!links?.length) return null;
  const { formatLinksMessage } = require('../ai/tts');
  const body = formatLinksMessage(links);
  const sent = await sock.sendMessage(
    chatJid,
    withMentions(body, mentions, sock, chatJid, { notifyInText }),
    {
      quoted: msg,
    }
  );
  rememberSent(chatJid, sent, body);
  console.log(`[whatsapp] sent ${links.length} link(s) as text`);
  return sent;
}

async function sendAnswer(sock, chatJid, text, { msg, mentions = [], asVoice = false, language = '', notifyInText = false } = {}) {
  const live = require('./client').getSocket() || sock;
  if (!live) throw new Error('WhatsApp is not connected');
  sock = live;
  const mentionIds = mentionJidList(mentions, sock, chatJid);
  const presence = startChatPresence(sock, chatJid, asVoice ? 'recording' : 'composing');
  try {
    if (asVoice) {
      const { splitForVoice } = require('../ai/tts');
      const { spoken, links } = splitForVoice(text);
      if (spoken) {
        await presence.setMode('recording');
        const sent = await sendVoiceReply(sock, chatJid, spoken, msg, mentionIds, language);
        if (sent) {
          rememberSent(chatJid, sent, spoken);
          console.log('[whatsapp] replied with lemonfox voice note');
          if (links.length) {
            await presence.setMode('composing');
            await sendLinkText(sock, chatJid, links, { msg, mentions, notifyInText });
          }
          return links.length ? 'voice+links' : 'voice';
        }
        console.warn('[whatsapp] voice reply failed — sending text');
      } else if (links.length) {
        await presence.setMode('composing');
        await sendLinkText(sock, chatJid, links, { msg, mentions, notifyInText });
        return 'text';
      }
    }
    await presence.setMode('composing');
    const sent = await sock.sendMessage(
      chatJid,
      withMentions(text, mentions, sock, chatJid, { notifyInText }),
      { quoted: msg }
    );
    rememberSent(chatJid, sent, text);
    return 'text';
  } finally {
    await presence.stop();
  }
}

async function fulfillTranslation(sock, yesMsg, chatJid, meta, offer) {
  const presence = startChatPresence(sock, chatJid, 'composing');
  try {
    let english = '';
    try {
      english = await translateToEnglish(offer.text);
    } catch (err) {
      console.error('[whatsapp] translation failed:', err.message || err);
      await sendAnswer(sock, chatJid, 'I could not translate that just now. Try again in a moment.', {
        msg: yesMsg,
        mentions: [],
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
      mentions: [],
      language: 'en',
    });
    console.log(`[whatsapp] translated to English${answer ? ' and answered' : ''} in ${meta?.subject || chatJid}`);
  } finally {
    await presence.stop().catch(() => {});
  }
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

  // Observer mode: ingest message into chat history for learning but never reply.
  if (isGroup && isObserverGroup(chatJid)) {
    trackMessage(msg);
    return;
  }

  if (isPrivate && !privateChatsEnabled()) {
    console.log('[whatsapp] skip private — private chats off');
    return;
  }

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
    const preview = cleanQuestion(rawText || '');
    const docMediaAsk =
      hasMedia &&
      (isDocWorkRequest(preview) ||
        isKnowledgeAsk(preview) ||
        isShareRequest(preview) ||
        isKnowledgeAsk(quoted) ||
        isShareRequest(quoted));
    const openAsk =
      !hasAudio &&
      !hasMedia &&
      (isKnowledgeAsk(preview) ||
        isShareRequest(preview) ||
        isKnowledgeAsk(quoted) ||
        isShareRequest(quoted));
    if (!openAsk && !docMediaAsk) {
      if (preview) {
        console.log(`[whatsapp] skip group (tag me, or ask for a file/link/deadline): ${preview.slice(0, 80)}`);
      }
      return;
    }
    console.log(
      `[whatsapp] untagged group knowledge ask — will answer only if known: ${preview.slice(0, 80)}`
    );
  }

  const dedupeKey = `${chatJid}:${msg.key.id}`;
  if (answered.has(dedupeKey) || pending.has(dedupeKey)) return;
  pending.add(dedupeKey);

  // Presence starts only once we know we will work on a reply (avoids typing-then-silence)
  let presence = null;
  const ensurePresence = async (mode = 'composing') => {
    if (!presence) presence = startChatPresence(sock, chatJid, mode);
    else await presence.setMode(mode);
  };

  try {
    let raw = rawText;
    let spokenLang = '';
    let fromMedia = false;
    if (hasAudio && (!raw || voiceIn)) {
      if (isGroup && !taggedEarly) {
        console.log('[whatsapp] skip untagged group voice note');
        return;
      }
      console.log('[whatsapp] voice note received — transcribing');
      await ensurePresence('recording');
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
        await ensurePresence('composing');
        await sendAnswer(
          sock,
          chatJid,
          phrase('noAnswer', spokenLang || 'en'),
          {
            msg,
            mentions: [],
            language: spokenLang || 'en',
          }
        );
        console.log('[whatsapp] did not understand the audio — sent fallback');
        answered.add(dedupeKey);
        return;
      }
    }

    if (hasMedia) {
      const captionAsk = cleanQuestion(rawText || '');
      const shouldReadMedia =
        taggedEarly ||
        isPrivate ||
        isDocWorkRequest(captionAsk) ||
        looksLikeQuestion(captionAsk) ||
        isShareRequest(captionAsk);
      if (!shouldReadMedia) {
        // Group attachment with no ask — stay quiet unless tagged
      } else if (mediaInfo?.archive) {
        const taggedZip = addressedBot(msg, sock, raw);
        if (taggedZip || isPrivate) {
          await ensurePresence('composing');
          await sendAnswer(sock, chatJid, phrase('skipZip', spokenLang || 'en'), {
            msg,
            mentions: [],
            language: spokenLang || 'en',
          });
          answered.add(dedupeKey);
        }
        console.log('[whatsapp] skipped zip attachment');
        return;
      } else {
        await ensurePresence('composing');
        console.log(`[whatsapp] reading ${mediaInfo?.kind || 'media'} attachment`);
        try {
          const seen = await understandMessageMedia(sock, msg, { caption: rawText, quoted });
          if (seen.archive) {
            await sendAnswer(sock, chatJid, phrase('skipZip', spokenLang || 'en'), {
              msg,
              mentions: [],
              language: spokenLang || 'en',
            });
            answered.add(dedupeKey);
            return;
          }
          if (seen.text) {
            fromMedia = true;
            const ask = captionAsk || (seen.kind === 'document' ? 'Please summarize this document.' : 'What is this?');
            raw = [ask, seen.text].filter(Boolean).join('\n\n');
            trackMessage(msg, raw);
            console.log(`[whatsapp] media understood: ${seen.text.slice(0, 80)}`);
          } else if (taggedEarly || isPrivate) {
            await sendAnswer(
              sock,
              chatJid,
              "I couldn't read that document. Try a PDF, Word, Excel, PowerPoint, or plain text file.",
              {
                msg,
                mentions: [],
                language: spokenLang || 'en',
              }
            );
            answered.add(dedupeKey);
            return;
          }
        } catch (err) {
          console.error('[whatsapp] media understand failed:', err.message || err);
          if (taggedEarly || isPrivate) {
            await sendAnswer(
              sock,
              chatJid,
              "I couldn't read that document just now. Try again in a moment.",
              {
                msg,
                mentions: [],
                language: spokenLang || 'en',
              }
            );
            answered.add(dedupeKey);
            return;
          }
        }
      }
    }

    const tagged = addressedBot(msg, sock, rawText);
    let question = fromMedia ? String(raw || '').trim() : cleanQuestion(raw);
    let contextQuoted = quoted;
    if (!question && !tagged) return;
    // Untagged group: only knowledge asks (files/links/deadlines) — otherwise tag the bot
    if (isGroup && !tagged) {
      if (
        !fromMedia &&
        !isKnowledgeAsk(question) &&
        !isShareRequest(question) &&
        !isKnowledgeAsk(contextQuoted) &&
        !isShareRequest(contextQuoted) &&
        !isDocWorkRequest(question)
      ) {
        console.log(
          `[whatsapp] skip group (tag me, or ask for a file/link/deadline): ${String(question || '').slice(0, 80)}`
        );
        return;
      }
    }

    const maybeRecap = !fromMedia && isAboutChat(rawText || question);
    await ensureChatHistory(sock, chatJid, msg, {
      wait: true,
      deep: maybeRecap || (isGroup && tagged && (!question || question.length < 24)),
    });

    if (isGroup && tagged) {
      const resolved = resolveTagContext({
        chatJid,
        msg,
        question,
        quoted: contextQuoted,
        tagged: true,
      });
      if (resolved.fromPrior) {
        console.log(
          `[whatsapp] late tag — using prior context: ${String(resolved.question || '').slice(0, 80)}`
        );
      }
      question = resolved.question;
      contextQuoted = resolved.quoted;
    }

    if (isGroup) {
      if (!claimExclusiveGroupReply(msg, question || 'tag', chatJid, meta)) {
        console.log(`[whatsapp] already answering this question in another group — skip ${chatName || chatJid}`);
        return;
      }
    }

    const recap = !fromMedia && isAboutChat(rawText || question);
    const chatHistory = recentChatLines(chatJid, msg.key.id);
    const requireKnown = isGroup && !tagged;
    const mustReply = isPrivate || tagged;

    console.log(
      `[whatsapp] ${isPrivate ? 'private' : 'group'} message from ${chatName || chatJid}: ${(question || raw || '').slice(0, 80)} (${chatHistory.length} prior msgs, tagged=${tagged}${requireKnown ? ', known-only' : ''})`
    );

    // Check availability calendar first — fast, no AI needed.
    if (question) {
      const intent = parseAvailabilityQuestion(question);
      if (intent) {
        const avail = availabilityAnswer(intent);
        if (avail) {
          await sock.sendMessage(chatJid, { text: withMentions(avail, []) }, { quoted: msg });
          return;
        }
      }
    }

    await ensurePresence(voiceIn ? 'recording' : 'composing');

    const result = question
      ? await answerQuestion(question, {
          chatJid,
          chatName,
          isGroup,
          chatHistory,
          quoted: contextQuoted,
          fromVoice: voiceIn,
          fromMedia,
          caption: rawText,
          language: spokenLang,
          requireKnown,
        })
      : null;

    const replyLang = result?.language || spokenLang;

    if (!result?.text && !result?.files?.length) {
      if (mustReply) {
        const adminJids = tagged && isGroup ? getAdminJids() : [];
        const body = recap
          ? "I don't have this group's older messages loaded yet, so I can't recap from the start. Ask me a specific topic, or try again after more of the chat comes through."
          : tagged && isGroup
            ? phrase('noKnowledge', replyLang)
            : phrase('noAnswer', replyLang);
        await sendAnswer(sock, chatJid, body, {
          msg,
          mentions: tagged && isGroup && !recap ? adminJids : [],
          notifyInText: Boolean(tagged && isGroup && !recap && adminJids.length),
          asVoice: voiceIn,
          language: replyLang || 'en',
        });
        console.log(
          recap
            ? '[whatsapp] recap fallback'
            : tagged && isGroup
              ? '[whatsapp] no knowledge — tagged admins'
              : '[whatsapp] no answer — sent fallback'
        );
        answered.add(dedupeKey);
        return;
      }
      console.log('[whatsapp] no answer — staying silent');
      return;
    }

    // Normal replies: quote the message only. Do not @ the asker or bystanders.
    const mentionPeople = [];
    // Media shares must attach the file — don't only speak a caption as a voice note
    const speakReply = voiceIn && result.source !== 'share';

    if (result.text) {
      await ensurePresence(speakReply ? 'recording' : 'composing');
      await sendAnswer(sock, chatJid, result.text, {
        msg,
        mentions: mentionPeople,
        asVoice: speakReply,
        language: replyLang,
      });
    }

    if (result.files?.length && result.source === 'share') {
      try {
        await ensurePresence('composing');
        const forceResend = /\b(again|resend|re-send|once more|one more|not this|wrong)\b/i.test(
          question || ''
        );
        let sent = await sendSharedFiles(sock, chatJid, result.files, msg, mentionPeople, {
          force: forceResend,
        });
        if (!sent.length) {
          sent = await sendSharedFiles(sock, chatJid, result.files, msg, mentionPeople, {
            force: true,
          });
        }
        console.log(
          `[whatsapp] shared ${sent.length} file(s): ${sent.map((f) => f.fileName).join(', ') || '(none)'}`
        );
        if (!sent.length) {
          await sendAnswer(sock, chatJid, phrase('fileSendFailed', replyLang), {
            msg,
            mentions: [],
            asVoice: false,
            language: replyLang,
          });
        }
      } catch (err) {
        console.error('[whatsapp] failed to share file:', err.message || err);
        if (result.source === 'share') {
          await ensurePresence('composing');
          await sendAnswer(sock, chatJid, phrase('fileSendFailed', replyLang), {
            msg,
            mentions: [],
            asVoice: false,
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
    if (presence) await presence.stop().catch(() => {});
    pending.delete(dedupeKey);
  }
}

module.exports = { createMessageHandler, extractText, cleanQuestion };
