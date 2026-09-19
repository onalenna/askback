const { unwrapMessageContent } = require('./voice');
const { getContextInfo, rememberSelfFromMessage, noteFromMeId } = require('./mentions');
const { statements } = require('../db/queries');

const MAX_LINES = 400;
const MAX_TEXT = 800;
const FETCH_COUNT = 80;
const FETCH_WAIT_MS = 8000;
const MIN_CONTEXT = 12;
const FETCH_COOLDOWN_MS = 2 * 60 * 1000;
const DEEP_PAGES = 3;

/** chatJid -> { lines, fetchedAt, fetching, waiters, hydrated } */
const chats = new Map();
/** jid -> Set of equivalent jids (lid / pn / group) */
const aliases = new Map();

function isGroupChat(jid) {
  return String(jid || '').endsWith('@g.us');
}

function isIgnoredChat(jid) {
  const id = String(jid || '');
  return !id || id === 'status@broadcast' || id.endsWith('@broadcast') || id.endsWith('@newsletter');
}

function isPrivateChat(jid) {
  return !isIgnoredChat(jid) && !isGroupChat(jid);
}

function shouldTrackChat(chatJid) {
  return !isIgnoredChat(chatJid);
}

function linkJids(...ids) {
  const jids = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (jids.length < 2) return;
  const group = new Set();
  for (const jid of jids) {
    group.add(jid);
    for (const other of aliases.get(jid) || []) group.add(other);
  }
  for (const jid of group) aliases.set(jid, group);
}

function relatedJids(chatJid) {
  const group = aliases.get(chatJid);
  if (group) return [...group];
  return chatJid ? [chatJid] : [];
}

function clip(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

function extractText(msg, { media = false } = {}) {
  const m = unwrapMessageContent(msg?.message);
  if (!m) return '';
  const bits = [
    m.conversation,
    m.extendedTextMessage?.text,
    m.imageMessage?.caption,
    m.videoMessage?.caption,
    m.documentMessage?.caption,
    m.buttonsResponseMessage?.selectedDisplayText,
    m.templateButtonReplyMessage?.selectedDisplayText,
    m.listResponseMessage?.title,
    m.pollCreationMessage?.name,
    m.pollCreationMessageV3?.name,
    m.eventMessage?.name,
    m.locationMessage?.comment,
    m.liveLocationMessage?.caption,
    m.contactMessage?.displayName,
  ].filter(Boolean);
  if (bits.length) return String(bits[0]);
  if (!media) return '';
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.stickerMessage) return '[sticker]';
  if (m.imageMessage) return '[image]';
  if (m.videoMessage) return '[video]';
  if (m.documentMessage) {
    const name = m.documentMessage.fileName || 'document';
    return `[file: ${name}]`;
  }
  return '';
}

function extractQuotedText(msg) {
  const quoted = getContextInfo(msg)?.quotedMessage;
  if (!quoted) return '';
  return extractText({ message: quoted }, { media: true });
}

function foldText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function rememberOutbound(chatJid, sent, text) {
  const id = sent?.key?.id || (typeof sent === 'string' ? sent : '');
  rememberSelfFromMessage({
    key: {
      fromMe: true,
      remoteJid: sent?.key?.remoteJid || chatJid,
      id,
      participant: sent?.key?.participant || sent?.participant,
      participantLid: sent?.key?.participantLid,
      participantPn: sent?.key?.participantPn,
    },
    participant: sent?.participant,
  });
  if (!text) return id;
  rememberMessage(chatJid, {
    id: id || `askback-${Date.now()}`,
    fromMe: true,
    name: 'askBack',
    text,
    ts: Date.now() / 1000,
    raw: sent?.message || null,
  });
  return id;
}

function quotedOurHistory(msg, chatJid) {
  const ctx = getContextInfo(msg);
  if (!ctx) return false;
  const stanzaId = String(ctx.stanzaId || '').trim();
  const lines = recentChatLines(chatJid);
  if (stanzaId && lines.some((line) => line.fromMe && line.id === stanzaId)) return true;
  const quoted = foldText(extractQuotedText(msg));
  if (!quoted) return false;
  return lines.some((line) => {
    if (!line.fromMe) return false;
    const mine = foldText(line.text);
    if (!mine) return false;
    if (mine === quoted) return true;
    if (quoted.length >= 12 && (mine.startsWith(quoted.slice(0, 80)) || quoted.startsWith(mine.slice(0, 80)))) {
      return true;
    }
    return false;
  });
}

function senderName(msg) {
  if (msg?.pushName) return String(msg.pushName).slice(0, 40);
  const p =
    msg?.key?.participantPn ||
    msg?.key?.participant ||
    msg?.key?.participantLid ||
    msg?.participant ||
    '';
  const user = String(p).split('@')[0];
  return user || '';
}

/** chatJid:msgId -> reply lines */
const replyIndex = new Map();

function rememberReply(chatJid, line) {
  const quotedId = String(line?.quotedId || '').trim();
  if (!chatJid || !quotedId) return;
  const key = `${chatJid}:${quotedId}`;
  const list = replyIndex.get(key) || [];
  if (line.id && list.some((item) => item.id === line.id)) return;
  list.push(line);
  replyIndex.set(key, list);
}

function repliesToId(chatJid, msgId) {
  const id = String(msgId || '').trim();
  if (!id) return [];
  const out = [];
  const seen = new Set();
  for (const jid of relatedJids(chatJid)) {
    for (const line of replyIndex.get(`${jid}:${id}`) || []) {
      const key = line.id || `${line.ts}:${line.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

function bucketFor(chatJid) {
  let bucket = chats.get(chatJid);
  if (!bucket) {
    bucket = { lines: [], fetchedAt: 0, fetching: false, waiters: [], hydrated: false };
    chats.set(chatJid, bucket);
  }
  return bucket;
}

function persistLine(chatJid, line) {
  if (!chatJid || !line?.id || !line?.text) return;
  try {
    statements.upsertChatMessage.run(
      chatJid,
      line.id,
      line.fromMe ? 1 : 0,
      line.name || '',
      line.text,
      line.quoted || '',
      Number(line.ts || 0)
    );
    const count = statements.chatMessageCount.get(chatJid)?.c || 0;
    if (count > MAX_LINES + 50) {
      statements.pruneChatMessages.run(chatJid, chatJid, MAX_LINES);
    }
  } catch (err) {
    console.warn('[whatsapp] could not save chat message:', err.message || err);
  }
}

function rememberMessage(chatJid, line, persist = true) {
  if (!chatJid || !line?.text) return;
  const bucket = bucketFor(chatJid);
  if (line.id && bucket.lines.some((item) => item.id === line.id)) {
    const existing = bucket.lines.find((item) => item.id === line.id);
    if (existing && line.name && !existing.name) existing.name = line.name;
    return;
  }
  const stored = {
    id: line.id || '',
    fromMe: !!line.fromMe,
    name: String(line.name || '').slice(0, 40),
    text: clip(line.text),
    quoted: clip(line.quoted),
    quotedId: String(line.quotedId || ''),
    ts: Number(line.ts || 0),
    raw: line.raw || null,
  };
  bucket.lines.push(stored);
  bucket.lines.sort((a, b) => a.ts - b.ts);
  if (bucket.lines.length > MAX_LINES) {
    bucket.lines.splice(0, bucket.lines.length - MAX_LINES);
  }
  rememberReply(chatJid, stored);
  if (persist) persistLine(chatJid, stored);
}

function rememberWaMessage(msg) {
  if (msg?.key?.fromMe) rememberSelfFromMessage(msg);
  const chatJid = msg?.key?.remoteJid;
  const altJid = msg?.key?.remoteJidAlt;
  if (!shouldTrackChat(chatJid) && !shouldTrackChat(altJid)) return;

  linkJids(chatJid, altJid);

  const text = extractText(msg, { media: true });
  const quoted = extractQuotedText(msg);
  if (!text && !quoted) return;

  const line = {
    id: msg.key?.id,
    fromMe: !!msg.key?.fromMe,
    name: senderName(msg),
    text: text || quoted,
    quoted,
    quotedId: getContextInfo(msg)?.stanzaId || '',
    ts: Number(msg.messageTimestamp || 0),
    raw: msg.message || null,
  };

  for (const jid of relatedJids(chatJid || altJid)) {
    if (shouldTrackChat(jid)) rememberMessage(jid, line);
  }
}

function hydrateChat(chatJid) {
  for (const jid of relatedJids(chatJid)) {
    const bucket = bucketFor(jid);
    if (bucket.hydrated) continue;
    bucket.hydrated = true;
    try {
      const rows = statements.chatMessagesByChat.all(jid, MAX_LINES);
      for (const row of rows.reverse()) {
        rememberMessage(
          jid,
          {
            id: row.msg_id,
            fromMe: !!row.from_me,
            name: row.sender_name,
            text: row.body,
            quoted: row.quoted,
            quotedId: '',
            ts: row.ts,
          },
          false
        );
        if (row.from_me) noteFromMeId(jid, row.msg_id);
      }
    } catch (err) {
      console.warn('[whatsapp] could not load saved messages:', err.message || err);
    }
  }
}

function ingestHistoryMessages(messages) {
  let stored = 0;
  for (const msg of messages || []) {
    const before = chats.get(msg?.key?.remoteJid)?.lines.length || 0;
    rememberWaMessage(msg);
    const after = chats.get(msg?.key?.remoteJid)?.lines.length || 0;
    if (after > before) stored += 1;
  }
  for (const bucket of chats.values()) {
    const waiters = bucket.waiters.splice(0, bucket.waiters.length);
    for (const resolve of waiters) resolve();
  }
  if ((messages || []).length) {
    console.log(
      `[whatsapp] history sync: ${messages.length} incoming, ${stored} new line(s) kept`
    );
  }
}

function recentChatLines(chatJid, excludeId) {
  hydrateChat(chatJid);
  const seen = new Set();
  const lines = [];
  for (const jid of relatedJids(chatJid)) {
    for (const line of chats.get(jid)?.lines || []) {
      if (!line.text) continue;
      if (excludeId && line.id === excludeId) continue;
      const key = line.id || `${line.ts}:${line.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  lines.sort((a, b) => a.ts - b.ts);
  return lines.slice(-MAX_LINES);
}

function formatChatContext(lines) {
  return (lines || [])
    .map((line) => {
      const who = line.fromMe ? 'askBack' : line.name || 'Member';
      const quoted = line.quoted ? ` (replying to: ${line.quoted})` : '';
      return `${who}${quoted}: ${line.text}`;
    })
    .join('\n');
}

function getStoredMessage(key) {
  if (!key?.id) return undefined;
  for (const jid of relatedJids(key.remoteJid)) {
    const match = (chats.get(jid)?.lines || []).find((line) => line.id === key.id);
    if (match?.raw) return match.raw;
  }
  return undefined;
}

function timestampMs(value) {
  const n = Number(value || 0);
  if (!n) return Date.now();
  return n > 1e12 ? n : n * 1000;
}

function waitForHistory(bucket) {
  return new Promise((resolve) => {
    bucket.waiters.push(resolve);
    setTimeout(resolve, FETCH_WAIT_MS);
  });
}

async function requestHistory(sock, msg) {
  if (!sock?.fetchMessageHistory || !msg?.key) return;
  await sock.fetchMessageHistory(FETCH_COUNT, msg.key, timestampMs(msg.messageTimestamp));
}

function historyCursor(chatJid, msg, page) {
  if (!page) return msg;
  const oldest = recentChatLines(chatJid)[0];
  if (!oldest?.id || !oldest.ts) return msg;
  return {
    key: {
      remoteJid: chatJid,
      id: oldest.id,
      fromMe: !!oldest.fromMe,
      participant: undefined,
    },
    messageTimestamp: oldest.ts,
  };
}

async function ensureChatHistory(sock, chatJid, msg, { wait = true, deep = false } = {}) {
  hydrateChat(chatJid);
  const bucket = bucketFor(chatJid);
  const have = recentChatLines(chatJid, msg?.key?.id).length;
  const fresh = bucket.fetchedAt && Date.now() - bucket.fetchedAt < FETCH_COOLDOWN_MS;
  const enough = deep ? have >= 80 : have >= MIN_CONTEXT;
  if (enough && (!deep || fresh)) return;
  if (fresh && !deep) return;
  if (!sock?.fetchMessageHistory || !msg?.key) {
    bucket.fetchedAt = Date.now();
    return;
  }

  const run = async () => {
    const pages = deep ? DEEP_PAGES : 1;
    for (let i = 0; i < pages; i += 1) {
      const pending = waitForHistory(bucket);
      const cursor = historyCursor(chatJid, msg, i);
      try {
        await requestHistory(sock, cursor);
      } catch (err) {
        console.warn('[whatsapp] could not fetch existing messages:', err.message || err);
        break;
      }
      await pending;
    }
    bucket.fetchedAt = Date.now();
    console.log(
      `[whatsapp] loaded ${recentChatLines(chatJid).length} existing message(s) from ${chatJid}`
    );
  };

  if (!wait) {
    if (bucket.fetching) return;
    bucket.fetching = true;
    run().finally(() => {
      bucket.fetching = false;
    });
    return;
  }

  if (bucket.fetching) {
    await waitForHistory(bucket);
    return;
  }

  bucket.fetching = true;
  try {
    await run();
  } finally {
    bucket.fetching = false;
  }
}

module.exports = {
  isGroupChat,
  isPrivateChat,
  isIgnoredChat,
  shouldTrackChat,
  extractText,
  extractQuotedText,
  rememberMessage,
  rememberWaMessage,
  rememberOutbound,
  quotedOurHistory,
  repliesToId,
  ingestHistoryMessages,
  recentChatLines,
  formatChatContext,
  getStoredMessage,
  ensureChatHistory,
};
