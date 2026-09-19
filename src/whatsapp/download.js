const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function downloadMediaBuffer(sock, msg, { label = 'media' } = {}) {
  if (!msg?.message) return null;
  const { downloadMediaMessage } = await import('baileys');
  const logger = sock.logger || {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return this;
    },
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage?.bind(sock),
        }
      );
      if (buffer?.length) return buffer;
    } catch (err) {
      lastErr = err;
      console.warn(`[whatsapp] ${label} download try ${attempt} failed:`, err.message || err);
    }
    if (sock.updateMediaMessage) {
      try {
        await sock.updateMediaMessage(msg);
      } catch (err) {
        console.warn('[whatsapp] media refresh failed:', err.message || err);
      }
    }
    await delay(1200);
  }
  if (lastErr) throw lastErr;
  return null;
}

module.exports = { downloadMediaBuffer, delay };
