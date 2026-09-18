const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createMessageHandler } = require('./handler');
const { ingestHistoryMessages, getStoredMessage } = require('./history');

const AUTH_DIR = path.join(__dirname, '..', '..', 'auth_info');

let sock = null;
let starting = false;
let reconnectDelay = 3000;

async function loadBaileys() {
  return import('baileys');
}

async function startWhatsApp() {
  if (starting) return;
  starting = true;

  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      Browsers,
    } = await loadBaileys();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: Browsers.macOS('askBack'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => true,
      getMessage: async (key) => getStoredMessage(key),
    });

    const onMessages = createMessageHandler(() => sock);
    sock.ev.on('messages.upsert', onMessages);
    sock.ev.on('messages.update', async (updates) => {
      const messages = [];
      for (const item of updates || []) {
        if (!item?.key || !item.update?.message) continue;
        messages.push({ key: item.key, message: item.update.message });
      }
      if (messages.length) await onMessages({ type: 'notify', messages });
    });
    sock.ev.on('messaging-history.set', ({ messages }) => {
      ingestHistoryMessages(messages);
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\nScan this QR with WhatsApp → Linked Devices:\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        reconnectDelay = 3000;
        const { ttsConfigured } = require('../ai/tts');
        sock.updateProfileName('askBack')
          .then(() => {
            console.log('[whatsapp] connected as askBack');
            console.log(
              ttsConfigured()
                ? '[whatsapp] Lemonfox TTS ready — voice notes get an audio reply'
                : '[whatsapp] Lemonfox TTS missing — voice notes will get text'
            );
          })
          .catch((err) =>
            console.warn('[whatsapp] connected — could not set profile name:', err.message || err)
          );
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.warn('[whatsapp] connection closed', { code, loggedOut });
        sock = null;

        if (!loggedOut) {
          const wait = reconnectDelay;
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          console.log(`[whatsapp] reconnecting in ${Math.round(wait / 1000)}s…`);
          setTimeout(() => {
            startWhatsApp().catch((err) =>
              console.error('[whatsapp] reconnect failed:', err.message || err)
            );
          }, wait);
        } else {
          console.error('[whatsapp] logged out — delete auth_info and restart to re-pair');
        }
      }
    });
  } catch (err) {
    sock = null;
    throw err;
  } finally {
    starting = false;
  }
}

function getSocket() {
  return sock;
}

module.exports = { startWhatsApp, getSocket };
