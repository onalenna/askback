const { unwrapMessageContent } = require('./voice');

const MAX_TAGS = 5;

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

function isPersonJid(jid) {
  const n = normalizeJid(jid);
  return n.endsWith('@s.whatsapp.net') || n.endsWith('@lid');
}

function selfIds(sock) {
  const me = sock?.user || {};
  return [me.id, me.lid, me.jid].map(normalizeJid).filter(Boolean);
}

function isSelf(sock, jid) {
  const n = normalizeJid(jid);
  if (!n) return false;
  const user = userPart(n);
  return selfIds(sock).some((id) => id === n || userPart(id) === user);
}

function messageMentionsBot(msg, sock, text) {
  const ctx = getContextInfo(msg);
  if ((ctx?.mentionedJid || []).some((jid) => isSelf(sock, jid))) return true;

  const raw = String(text || '');
  if (/\baskback\b/i.test(raw) || /\baskbak\b/i.test(raw)) return true;

  const me = selfIds(sock).map(userPart).filter(Boolean);
  return me.some((id) => raw.includes(`@${id}`));
}

function getContextInfo(msg) {
  const content = unwrapMessageContent(msg?.message);
  if (!content || typeof content !== 'object') return null;
  for (const value of Object.values(content)) {
    if (value && typeof value === 'object' && value.contextInfo) {
      return value.contextInfo;
    }
  }
  return null;
}

function addPerson(people, displayJid, extras, sock) {
  const display = normalizeJid(displayJid);
  if (!isPersonJid(display) || isSelf(sock, display)) return;
  const ids = [
    ...new Set(
      [display, ...extras.map(normalizeJid)].filter((jid) => isPersonJid(jid) && !isSelf(sock, jid))
    ),
  ];
  const match = people.find((person) => person.ids.some((id) => ids.includes(id)));
  if (match) {
    for (const id of ids) {
      if (!match.ids.includes(id)) match.ids.push(id);
    }
    return;
  }
  people.push({ display, ids });
}

/**
 * Asker, plus anyone their message replied to or @mentioned.
 */
function relatedMentionJids(msg, sock) {
  if (!msg?.key) return [];
  const people = [];
  const key = msg.key;

  addPerson(
    people,
    key.participant || key.participantLid || key.participantPn,
    [key.participant, key.participantLid, key.participantPn, key.senderPn],
    sock
  );

  const ctx = getContextInfo(msg);
  if (ctx) {
    addPerson(
      people,
      ctx.participant || ctx.participantLid || ctx.participantPn,
      [ctx.participant, ctx.participantLid, ctx.participantPn],
      sock
    );
    for (const jid of ctx.mentionedJid || []) {
      addPerson(people, jid, [], sock);
    }
  }

  return people.slice(0, MAX_TAGS).flatMap((person) => person.ids);
}

function mentionTokens(jids) {
  const seen = new Set();
  const tokens = [];
  for (const jid of jids || []) {
    const token = `@${userPart(jid)}`;
    if (!token || token === '@' || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function withMentions(text, jids) {
  const mentions = [...new Set((jids || []).map(normalizeJid).filter(isPersonJid))];
  if (!mentions.length) return text ? { text } : {};
  const body = String(text || '').trim();
  if (!body) return { mentions };
  const tags = mentionTokens(mentions);
  const already = tags.length && tags.every((tag) => body.includes(tag));
  return {
    text: already ? body : `${tags.join(' ')}\n${body}`,
    mentions,
  };
}

function attachMentions(content, jids) {
  const mentions = [...new Set((jids || []).map(normalizeJid).filter(isPersonJid))];
  if (!mentions.length) return content;
  return { ...content, mentions };
}

module.exports = {
  relatedMentionJids,
  withMentions,
  attachMentions,
  messageMentionsBot,
  getContextInfo,
  isSelf,
  isPersonJid,
  normalizeJid,
};
