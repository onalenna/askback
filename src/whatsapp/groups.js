const { statements } = require('../db/queries');

const SETTING_KEY = 'allowed_groups';
const META_TTL_MS = 10 * 60 * 1000;
const CLAIM_MS = 2 * 60 * 1000;

const metaCache = new Map();
const recentClaims = new Map();

function getAllowedGroupJids() {
  try {
    const parsed = JSON.parse(statements.getSetting.get(SETTING_KEY)?.value || '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((jid) => String(jid || '').trim()).filter((jid) => jid.endsWith('@g.us')))];
  } catch {
    return [];
  }
}

function setAllowedGroupJids(jids) {
  const unique = [
    ...new Set((jids || []).map((jid) => String(jid || '').trim()).filter((jid) => jid.endsWith('@g.us'))),
  ];
  statements.setSetting.run(SETTING_KEY, JSON.stringify(unique));
  return unique;
}

function isGroupAllowed(jid) {
  return getAllowedGroupJids().includes(jid);
}

function setGroupAllowed(jid, enabled) {
  const id = String(jid || '').trim();
  if (!id.endsWith('@g.us')) {
    throw new Error('That is not a WhatsApp group.');
  }
  if (enabled && isBroadcastGroup(metaCache.get(id)?.meta)) {
    throw new Error('askBack cannot answer in a community hub. Turn on the specific group instead.');
  }
  const allowed = new Set(getAllowedGroupJids());
  if (enabled) allowed.add(id);
  else allowed.delete(id);
  return setAllowedGroupJids([...allowed]);
}

function nameFromHistory(jid) {
  const row = statements.qaByGroup.all(jid)[0];
  return row?.group_name || '';
}

function isBroadcastGroup(meta) {
  return Boolean(meta?.isCommunity || meta?.isCommunityAnnounce);
}

async function getGroupMeta(sock, jid) {
  const hit = metaCache.get(jid);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.meta;
  if (!sock?.groupMetadata) return null;
  const meta = await sock.groupMetadata(jid);
  metaCache.set(jid, { meta, at: Date.now() });
  return meta;
}

function pruneClaims(now) {
  for (const [key, value] of recentClaims) {
    if (now - value.at > CLAIM_MS) recentClaims.delete(key);
  }
}

/**
 * A group question may also land in linked community groups.
 * Only the first group that sees it is allowed to get the reply.
 */
function claimExclusiveGroupReply(msg, question, chatJid, meta) {
  const now = Date.now();
  pruneClaims(now);
  const participant =
    msg.key.participant || msg.key.participantPn || msg.key.participantLid || '';
  const keys = [];
  if (msg.key.id) keys.push(`id:${msg.key.id}`);
  if (meta?.linkedParent) {
    keys.push(`c:${meta.linkedParent}:${participant}:${String(question || '').toLowerCase()}`);
  }
  for (const key of keys) {
    const prev = recentClaims.get(key);
    if (prev && prev.chatJid !== chatJid) return false;
  }
  for (const key of keys) {
    recentClaims.set(key, { chatJid, at: now });
  }
  return true;
}

function groupRecord(jid, meta, enabled) {
  const broadcast = isBroadcastGroup(meta);
  return {
    jid,
    name: meta?.subject || nameFromHistory(jid) || jid,
    enabled: enabled && !broadcast,
    broadcast,
  };
}

async function listGroups(sock) {
  const allowed = new Set(getAllowedGroupJids());
  const byJid = new Map();

  if (sock?.groupFetchAllParticipating) {
    try {
      const participating = await sock.groupFetchAllParticipating();
      let stripped = false;
      for (const [jid, meta] of Object.entries(participating || {})) {
        metaCache.set(jid, { meta, at: Date.now() });
        if (isBroadcastGroup(meta) && allowed.has(jid)) {
          allowed.delete(jid);
          stripped = true;
        }
        byJid.set(jid, groupRecord(jid, meta, allowed.has(jid)));
      }
      if (stripped) setAllowedGroupJids([...allowed]);
    } catch (err) {
      console.warn('[whatsapp] could not list groups:', err.message || err);
    }
  }

  for (const jid of allowed) {
    if (!byJid.has(jid)) {
      byJid.set(jid, groupRecord(jid, null, true));
    }
  }

  return [...byJid.values()].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
}

module.exports = {
  getAllowedGroupJids,
  setGroupAllowed,
  isGroupAllowed,
  isBroadcastGroup,
  getGroupMeta,
  claimExclusiveGroupReply,
  listGroups,
};
