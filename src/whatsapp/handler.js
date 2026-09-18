const { answerQuestion } = require('./answer');
const {
  getAudioMessage,
  isVoiceNote,
  transcribeVoiceNote,
  sendVoiceReply,
} = require('./voice');
const { sendSharedFiles, isShareRequest } = require('./share');
const { getGroupMeta, isBroadcastGroup, claimExclusiveGroupReply, isGroupAllowed } = require('./groups');
const { relatedMentionJids, withMentions, messageMentionsBot } = require('./mentions');
const { getAdminJids } = require('./admins');
const { looksLikeQuestion, isChitchat, isFollowUp, isAboutChat } = require('./intent');
const {
  extractText,
  extractQuotedText,
  rememberMessage,
  rememberWaMessage,
  recentChatLines,
  ensureChatHistory,
  formatChatContext,
  isGroupChat,
  isPrivateChat,
  isIgnoredChat,
} = require('./history');

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

async function sendAnswer(sock, chatJid, text, { msg, mentions = [], asVoice = false } = {}) {
  if (asVoice) {
    const sent = await sendVoiceReply(sock, chatJid, text, msg, mentions);
    if (sent) {
      console.log('[whatsapp] replied with lemonfox voice note');
      return 'voice';
    }
    console.warn('[whatsapp] voice reply failed — sending text');
  }
  await sock.sendMessage(chatJid, withMentions(text, mentions), { quoted: msg });
  return 'text';
}

function createMessageHandler(getSock) {
  const pending = new Set();

  return async function onMessagesUpsert({ type, messages }) {
    const sock = getSock();
    if (!sock) return;

    for (const msg of messages) {
      if (msg?.message) rememberWaMessage(msg);
      if (type !== 'notify') continue;
      try {
        await handleOne(sock, msg, pending);
      } catch (err) {
        console.error('[whatsapp] handler error:', err.message || err);
      }
    }
  };
}

async function handleOne(sock, msg, pending) {
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
  if (!rawText && !hasAudio) return;

  const dedupeKey = `${chatJid}:${msg.key.id}`;
  if (pending.has(dedupeKey)) return;
  pending.add(dedupeKey);

  try {
    let raw = rawText;
    if (!raw && hasAudio) {
      try {
        await sock.sendPresenceUpdate('composing', chatJid);
      } catch {
        /* presence is optional */
      }
      try {
        await ensureChatHistory(sock, chatJid, msg, { wait: true });
        raw = await transcribeVoiceNote(sock, msg, {
          chatContext: formatChatContext(recentChatLines(chatJid, msg.key.id)),
          quoted,
        });
      } catch (err) {
        console.error('[whatsapp] voice note transcription failed:', err.message || err);
        console.log('[whatsapp] did not understand the audio — staying silent');
        return;
      }
      if (raw) {
        trackMessage(msg, raw);
        console.log(`[whatsapp] voice note understood: ${raw.slice(0, 80)}`);
      } else {
        console.log('[whatsapp] did not understand the audio — staying silent');
        return;
      }
    }

    const tagged = messageMentionsBot(msg, sock, raw);
    const question = cleanQuestion(raw);
    if (!question && !tagged) return;
    if (isGroup && question && !tagged) {
      if (voiceIn) {
        if (isChitchat(question) && !quoted) return;
      } else {
        const worthAnswering =
          Boolean(quoted) ||
          looksLikeQuestion(question) ||
          isAboutChat(question) ||
          isFollowUp(question) ||
          isShareRequest(question);
        if (!worthAnswering) return;
        if (isChitchat(question) && !quoted) return;
      }
    }

    let chatName = isPrivate ? 'private' : '';
    if (isGroup) {
      let meta = null;
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
      if (!claimExclusiveGroupReply(msg, question || 'tag', chatJid, meta)) {
        console.log(`[whatsapp] already answering this question in another group — skip ${chatName || chatJid}`);
        return;
      }
    }

    await ensureChatHistory(sock, chatJid, msg, { wait: true });
    const chatHistory = recentChatLines(chatJid, msg.key.id);

    console.log(
      `[whatsapp] ${isPrivate ? 'private' : 'group'} message from ${chatName || chatJid}: ${(question || raw || '').slice(0, 80)} (${chatHistory.length} prior msgs)`
    );

    const result = question
      ? await answerQuestion(question, {
          chatJid,
          chatName,
          isGroup,
          chatHistory,
          quoted,
        })
      : null;

    if (!result?.text && !result?.files?.length) {
      if (tagged && isGroup) {
        const adminJids = getAdminJids();
        if (adminJids.length) {
          await sendAnswer(sock, chatJid, "I don't have this in knowledge yet.", {
            msg,
            mentions: adminJids,
            asVoice: voiceIn,
          });
          console.log('[whatsapp] no knowledge — tagged admins');
          return;
        }
      }
      console.log('[whatsapp] no answer — staying silent');
      return;
    }

    const mentionJids = isGroup ? relatedMentionJids(msg, sock) : [];

    if (result.text) {
      await sendAnswer(sock, chatJid, result.text, {
        msg,
        mentions: mentionJids,
        asVoice: voiceIn,
      });
      trackMessage(
        {
          key: { remoteJid: chatJid, fromMe: true, id: `askback-${Date.now()}` },
          pushName: 'askBack',
          messageTimestamp: Date.now() / 1000,
        },
        result.text
      );
    }

    if (result.files?.length) {
      try {
        await sendSharedFiles(sock, chatJid, result.files, msg, mentionJids);
        console.log(
          `[whatsapp] shared ${result.files.length} file(s): ${result.files.map((f) => f.fileName).join(', ')}`
        );
      } catch (err) {
        console.error('[whatsapp] failed to share file:', err.message || err);
        if (result.source === 'share') {
          await sendAnswer(sock, chatJid, "I found the file but couldn't send it. Try again.", {
            msg,
            mentions: mentionJids,
            asVoice: voiceIn,
          });
        }
      }
    }

    console.log(
      `[whatsapp] replied (${result.source}) only to ${isGroup ? chatName || 'group' : 'private'} chat`
    );
  } finally {
    pending.delete(dedupeKey);
  }
}

module.exports = { createMessageHandler, extractText, cleanQuestion };
