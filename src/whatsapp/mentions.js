const { unwrapMessageContent } = require('./voice');

const MAX_TAGS = 5;
const MAX_FROM_ME = 800;

const groupSelfIds = new Map();
const fromMeIds = new Set();

function normalizeJid(jid) {
  if (!jid) return '';
  const raw = String(jid).trim();
  const at = raw.indexOf('@');
  if (at < 1) return '';
  const user = raw.slice(0, at).split(':')[0];
  const server = raw.slice(at + 1);
  if (!user || !server) return '';
  if (server === 'c.us') return `${user}@s.whatsapp.net`;
  return `${user}@${server}`;
}

function userPart(jid) {
  return normalizeJid(jid).split('@')[0] || '';
}

function serverPart(jid) {
  const n = normalizeJid(jid);
  const at = n.indexOf('@');
  return at > 0 ? n.slice(at + 1) : '';
}

function isPersonJid(jid) {
  const n = normalizeJid(jid);
  return n.endsWith('@s.whatsapp.net') || n.endsWith('@lid');
}

function sameId(a, b) {
  const na = normalizeJid(a);
  const nb = normalizeJid(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return userPart(na) === userPart(nb) && serverPart(na) === serverPart(nb);
}

function pushPersonId(ids, value) {
  const n = normalizeJid(value);
  if (isPersonJid(n)) ids.add(n);
}

function collectPersonIds(...values) {
  const ids = new Set();
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) pushPersonId(ids, item);
      continue;
    }
    if (typeof value === 'object') {
      pushPersonId(ids, value.id);
      pushPersonId(ids, value.lid);
      pushPersonId(ids, value.jid);
      pushPersonId(ids, value.phoneNumber);
      pushPersonId(ids, value.pn);
      continue;
    }
    pushPersonId(ids, value);
  }
  return ids;
}

function accountIds(sock) {
  return collectPersonIds(sock?.user, sock?.authState?.creds?.me);
}

function rememberSelfJids(chatJid, values) {
  const incoming = collectPersonIds(...(values || []));
  if (!incoming.size) return;
  const key = String(chatJid || '').endsWith('@g.us') ? chatJid : '__account__';
  const current = new Set(groupSelfIds.get(key) || []);
  for (const id of incoming) current.add(id);
  groupSelfIds.set(key, [...current]);
}

function noteFromMeId(chatJid, id) {
  const msgId = String(id || '').trim();
  if (!msgId) return;
  fromMeIds.add(msgId);
  if (chatJid) fromMeIds.add(`${chatJid}:${msgId}`);
  if (fromMeIds.size <= MAX_FROM_ME * 2) return;
  const first = fromMeIds.values().next().value;
  fromMeIds.delete(first);
}

function rememberSelfFromMessage(msg) {
  const key = msg?.key;
  if (!key?.fromMe) return;
  const chatJid = key.remoteJid;
  noteFromMeId(chatJid, key.id);
  rememberSelfJids(chatJid, [
    key.participant,
    key.participantLid,
    key.participantPn,
    key.senderPn,
    msg.participant,
    msg.participantLid,
    msg.participantPn,
  ]);
}

function selfIds(sock, extra = []) {
  const ids = accountIds(sock);
  for (const value of extra || []) pushPersonId(ids, value);
  for (const extraGroup of groupSelfIds.values()) {
    for (const value of extraGroup) pushPersonId(ids, value);
  }
  return [...ids];
}

function selfIdsFromMeta(sock, meta) {
  if (!meta?.participants?.length) return [];
  const mine = [...accountIds(sock)];
  const extra = new Set();
  for (const person of meta.participants) {
    const ids = [...collectPersonIds(person)];
    const isMe = ids.some((id) => mine.some((m) => sameId(m, id)));
    if (!isMe) continue;
    for (const id of ids) extra.add(id);
  }
  return [...extra];
}

function rememberGroupSelf(sock, meta) {
  if (!meta?.id) return;
  const extra = selfIdsFromMeta(sock, meta);
  if (extra.length) rememberSelfJids(meta.id, extra);
}

function extraSelfFor(sock, chatJid) {
  return [
    ...(groupSelfIds.get(chatJid) || []),
    ...(groupSelfIds.get('__account__') || []),
  ];
}

function isSelf(sock, jid, extra = []) {
  const n = normalizeJid(jid);
  if (!n) return false;
  return selfIds(sock, extra).some((id) => sameId(id, n));
}

function rawMessageText(msg) {
  const content = unwrapMessageContent(msg?.message);
  if (!content || typeof content !== 'object') return '';
  return String(
    content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      ''
  );
}

function namedBot(text) {
  return /(^|[^\w])@(askback|askbak)\b/i.test(text || '');
}

function numericAtUsers(text) {
  return new Set([...String(text || '').matchAll(/@(\d{5,})/g)].map((m) => m[1]));
}

function learnSelfFromIncoming(msg, sock, text) {
  const chatJid = msg?.key?.remoteJid;
  const ctx = getContextInfo(msg);
  const mentioned = (ctx?.mentionedJid || []).map(normalizeJid).filter(isPersonJid);
  const asker = normalizeJid(msg?.key?.participant || msg?.key?.participantLid || msg?.key?.participantPn);
  const extra = extraSelfFor(sock, chatJid);
  const unknown = mentioned.filter((jid) => !sameId(jid, asker) && !isSelf(sock, jid, extra));
  const learned = [];

  if (namedBot(text)) {
    const numeric = numericAtUsers(text);
    const nameOnly = unknown.filter((jid) => !numeric.has(userPart(jid)));
    if (nameOnly.length === 1) learned.push(nameOnly[0]);
  }

  if (quotedIsFromMe(msg)) {
    learned.push(ctx?.participant, ctx?.participantLid, ctx?.participantPn);
  }

  rememberSelfJids(chatJid, learned);
}

function quotedIsFromMe(msg) {
  const ctx = getContextInfo(msg);
  const id = String(ctx?.stanzaId || '').trim();
  if (!id) return false;
  const chatJid = msg?.key?.remoteJid;
  return fromMeIds.has(id) || Boolean(chatJid && fromMeIds.has(`${chatJid}:${id}`));
}

function messageMentionsBot(msg, sock, text) {
  const raw = String(text || rawMessageText(msg) || '');
  learnSelfFromIncoming(msg, sock, raw);
  const extra = extraSelfFor(sock, msg?.key?.remoteJid);
  const ctx = getContextInfo(msg);
  if ((ctx?.mentionedJid || []).some((jid) => isSelf(sock, jid, extra))) return true;
  if (namedBot(raw)) return true;
  const me = selfIds(sock, extra).map(userPart).filter(Boolean);
  return me.some((id) => raw.includes(`@${id}`));
}

function messageRepliesToBot(msg, sock) {
  const ctx = getContextInfo(msg);
  if (!ctx) return false;
  if (quotedIsFromMe(msg)) return true;
  const extra = extraSelfFor(sock, msg?.key?.remoteJid);
  return [ctx.participant, ctx.participantLid, ctx.participantPn].some((jid) => isSelf(sock, jid, extra));
}

function messageAddressesBot(msg, sock, text) {
  return messageMentionsBot(msg, sock, text) || messageRepliesToBot(msg, sock);
}

function getContextInfo(msg) {
  const content = unwrapMessageContent(msg?.message);
  if (!content || typeof content !== 'object') return null;
  const nested = [
    content.extendedTextMessage,
    content.imageMessage,
    content.videoMessage,
    content.audioMessage,
    content.documentMessage,
    content.stickerMessage,
    content.buttonsResponseMessage,
    content.templateButtonReplyMessage,
    content.listResponseMessage,
    content.reactionMessage,
    content.locationMessage,
    content.contactMessage,
  ];
  for (const value of nested) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  if (content.contextInfo) return content.contextInfo;
  const plain = typeof content.toJSON === 'function' ? content.toJSON() : content;
  for (const value of Object.values(plain || {})) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return null;
}

function addPerson(people, displayJid, extras, sock, extraSelf = []) {
  const display = normalizeJid(displayJid);
  if (!isPersonJid(display) || isSelf(sock, display, extraSelf)) return;
  const ids = [
    ...new Set(
      [display, ...extras.map(normalizeJid)].filter(
        (jid) => isPersonJid(jid) && !isSelf(sock, jid, extraSelf)
      )
    ),
  ];
  if (!ids.length) return;
  const match = people.find((person) => person.ids.some((id) => ids.some((item) => sameId(item, id))));
  if (match) {
    for (const id of ids) {
      if (!match.ids.some((existing) => sameId(existing, id))) match.ids.push(id);
    }
    return;
  }
  people.push({ display, ids });
}

function dropSelfPeople(people, sock, extraSelf = []) {
  return (people || []).filter(
    (person) =>
      !isSelf(sock, person.display, extraSelf) &&
      !(person.ids || []).some((id) => isSelf(sock, id, extraSelf))
  );
}

function skipIncomingMention(jid, text, sock, extraSelf) {
  if (isSelf(sock, jid, extraSelf)) return true;
  if (!namedBot(text)) return false;
  return !numericAtUsers(text).has(userPart(jid));
}

/**
 * Asker, plus anyone their message replied to or @mentioned by number.
 * Never includes askBack itself — including its group LID, which is not the account LID.
 */
function relatedMentionPeople(msg, sock, meta) {
  if (!msg?.key) return [];
  if (meta) rememberGroupSelf(sock, meta);
  const text = rawMessageText(msg);
  learnSelfFromIncoming(msg, sock, text);
  const extraSelf = extraSelfFor(sock, msg.key.remoteJid);
  const people = [];
  const key = msg.key;

  addPerson(
    people,
    key.participant || key.participantLid || key.participantPn,
    [key.participant, key.participantLid, key.participantPn, key.senderPn],
    sock,
    extraSelf
  );

  const ctx = getContextInfo(msg);
  if (ctx) {
    const quotedSelf = quotedIsFromMe(msg) || [ctx.participant, ctx.participantLid, ctx.participantPn].some((jid) => isSelf(sock, jid, extraSelf));
    if (!quotedSelf) {
      addPerson(
        people,
        ctx.participant || ctx.participantLid || ctx.participantPn,
        [ctx.participant, ctx.participantLid, ctx.participantPn],
        sock,
        extraSelf
      );
    }
    for (const jid of ctx.mentionedJid || []) {
      if (skipIncomingMention(jid, text, sock, extraSelf)) continue;
      addPerson(people, jid, [], sock, extraSelf);
    }
  }

  return dropSelfPeople(people, sock, extraSelf).slice(0, MAX_TAGS);
}

function relatedMentionJids(msg, sock, meta) {
  return mentionJidList(relatedMentionPeople(msg, sock, meta), sock, msg?.key?.remoteJid);
}

function asPeople(input, sock, extraSelf = []) {
  if (!input?.length) return [];
  if (typeof input[0] === 'object' && Array.isArray(input[0].ids)) {
    return dropSelfPeople(input, sock, extraSelf);
  }
  const people = [];
  for (const jid of input) {
    addPerson(people, jid, [], sock, extraSelf);
  }
  return dropSelfPeople(people, sock, extraSelf);
}

function mentionJidList(input, sock, chatJid) {
  const extraSelf = extraSelfFor(sock, chatJid);
  return asPeople(input, sock, extraSelf)
    .map((person) => normalizeJid(person.display))
    .filter((jid) => isPersonJid(jid) && !isSelf(sock, jid, extraSelf));
}

function mentionTokensForPeople(people) {
  const seen = new Set();
  const tokens = [];
  for (const person of people || []) {
    const token = `@${userPart(person.display)}`;
    if (!token || token === '@' || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSelfTags(text, sock, extraSelf = []) {
  let body = String(text || '');
  const tags = new Set(selfIds(sock, extraSelf).map((id) => `@${userPart(id)}`).filter((tag) => tag.length > 1));
  tags.add('@askback');
  tags.add('@askbak');
  for (const tag of tags) {
    body = body.replace(new RegExp(`(^|\\s)${escapeRegExp(tag)}\\b`, 'gi'), '$1');
  }
  return body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function withMentions(text, jids, sock, chatJid) {
  const extraSelf = extraSelfFor(sock, chatJid);
  const people = asPeople(jids, sock, extraSelf);
  const mentions = mentionJidList(people, sock, chatJid);
  const body = stripSelfTags(text, sock, extraSelf);
  if (!mentions.length) return body ? { text: body } : {};
  if (!body) return { mentions };
  const missing = mentionTokensForPeople(people).filter((tag) => !body.includes(tag));
  return {
    text: missing.length ? `${missing.join(' ')}\n${body}` : body,
    mentions,
  };
}

function attachMentions(content, jids, sock, chatJid) {
  const mentions = mentionJidList(jids, sock, chatJid);
  if (!mentions.length) return content;
  return { ...content, mentions };
}

module.exports = {
  relatedMentionPeople,
  relatedMentionJids,
  mentionJidList,
  withMentions,
  attachMentions,
  messageMentionsBot,
  messageRepliesToBot,
  messageAddressesBot,
  getContextInfo,
  isSelf,
  isPersonJid,
  normalizeJid,
  rememberGroupSelf,
  rememberSelfFromMessage,
  noteFromMeId,
};
