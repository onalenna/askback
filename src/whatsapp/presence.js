/**
 * Keep WhatsApp "typing…" / "recording…" visible while the bot works.
 * Presence updates expire after ~10–25s, so we refresh on an interval.
 */

const REFRESH_MS = 7000;

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatJid
 * @param {'composing'|'recording'} kind
 */
function startChatPresence(sock, chatJid, kind = 'composing') {
  let mode = kind === 'recording' ? 'recording' : 'composing';
  let stopped = false;
  let timer = null;

  const push = async () => {
    if (stopped || !sock?.sendPresenceUpdate || !chatJid) return;
    try {
      await sock.sendPresenceUpdate(mode, chatJid);
    } catch {
      /* presence is best-effort */
    }
  };

  push();
  timer = setInterval(push, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    setMode(next) {
      mode = next === 'recording' ? 'recording' : 'composing';
      return push();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        if (sock?.sendPresenceUpdate && chatJid) {
          await sock.sendPresenceUpdate('paused', chatJid);
        }
      } catch {
        /* optional */
      }
    },
  };
}

/** Run an async job while showing composing or recording. */
async function withChatPresence(sock, chatJid, kind, fn) {
  const presence = startChatPresence(sock, chatJid, kind);
  try {
    return await fn(presence);
  } finally {
    await presence.stop();
  }
}

module.exports = { startChatPresence, withChatPresence };
