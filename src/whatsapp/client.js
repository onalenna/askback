const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { createMessageHandler } = require('./handler');
const { ingestHistoryMessages, getStoredMessage } = require('./history');
const { normalizeJid } = require('./mentions');

const AUTH_DIR = path.join(__dirname, '..', '..', 'auth_info');
const LOCK_FILE = path.join(AUTH_DIR, '.instance.lock');

let sock = null;
let starting = false;
let repairing = false;
let reconnectDelay = 3000;
let reconnectTimer = null;
let stableTimer = null;
let latestQr = null;
let waConnected = false;
let namedBot = false;
let replacedAt = [];

async function loadBaileys() {
  return import('baileys');
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readLockPid() {
  try {
    return Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim());
  } catch {
    return 0;
  }
}

function claimInstance() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const other = readLockPid();
  if (other && other !== process.pid && pidAlive(other)) {
    console.error(`[whatsapp] already running as pid ${other} — not starting a second client`);
    return false;
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseInstance() {
  try {
    if (readLockPid() === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

process.on('exit', releaseInstance);

function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}

function clearAuthDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const name of fs.readdirSync(AUTH_DIR)) {
    if (name === '.instance.lock') continue;
    fs.rmSync(path.join(AUTH_DIR, name), { recursive: true, force: true });
  }
}

function endSocket() {
  const current = sock;
  sock = null;
  waConnected = false;
  if (!current) return;
  try {
    current.ev.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    current.ws?.close();
  } catch {
    /* ignore */
  }
  try {
    current.end?.(undefined);
  } catch {
    /* ignore */
  }
}

function scheduleReconnect(waitMs) {
  if (reconnectTimer || starting) return;
  const wait = Math.max(waitMs, reconnectDelay);
  reconnectDelay = Math.min(Math.max(wait, 3000) * 2, 30000);
  console.log(`[whatsapp] reconnecting in ${Math.round(wait / 1000)}s…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch((err) =>
      console.error('[whatsapp] reconnect failed:', err.message || err)
    );
  }, wait);
}

async function startWhatsApp() {
  if (starting) return;
  if (!claimInstance()) return;
  starting = true;
  clearTimers();
  endSocket();

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
        latestQr = qr;
        waConnected = false;
        console.log('\nScan this QR with WhatsApp → Linked Devices:');
        console.log('Open http://127.0.0.1:3000/#status for a scannable code.\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        latestQr = null;
        waConnected = true;
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          reconnectDelay = 3000;
          replacedAt = [];
        }, 12000);
        const { ttsConfigured } = require('../ai/tts');
        console.log('[whatsapp] connected as askBack');
        console.log(
          ttsConfigured()
            ? '[whatsapp] Lemonfox TTS ready — voice notes get an audio reply'
            : '[whatsapp] Lemonfox TTS missing — voice notes will get text'
        );
        try {
          const { startDailyDigest } = require('./digest');
          startDailyDigest();
        } catch (err) {
          console.warn('[digest] could not start scheduler:', err.message || err);
        }
        try {
          const { startDeadlineReminders } = require('./reminders');
          startDeadlineReminders();
        } catch (err) {
          console.warn('[reminders] could not start:', err.message || err);
        }
        if (!namedBot) {
          namedBot = true;
          sock.updateProfileName('askBack').catch((err) =>
            console.warn('[whatsapp] could not set profile name:', err.message || err)
          );
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        const replaced = code === DisconnectReason.connectionReplaced || code === 440;
        console.warn('[whatsapp] connection closed', { code, loggedOut, replaced });
        sock = null;
        waConnected = false;
        if (repairing) return;
        if (stableTimer) {
          clearTimeout(stableTimer);
          stableTimer = null;
        }
        if (loggedOut) {
          latestQr = null;
          releaseInstance();
          console.error('[whatsapp] logged out — delete auth_info and restart to re-pair');
          return;
        }
        latestQr = null;
        let wait = reconnectDelay;
        if (replaced) {
          const now = Date.now();
          replacedAt = replacedAt.filter((at) => now - at < 30000);
          replacedAt.push(now);
          wait = replacedAt.length >= 3 ? 20000 : Math.max(wait, 8000);
        }
        scheduleReconnect(wait);
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

function phoneFromId(value) {
  const jid = normalizeJid(value);
  if (jid.endsWith('@s.whatsapp.net')) {
    const digits = jid.split('@')[0];
    if (/^\d{8,15}$/.test(digits)) return digits;
  }
  return '';
}

function connectedPhone(socket) {
  const user = socket?.user || socket?.authState?.creds?.me || {};
  return (
    phoneFromId(user.phoneNumber) ||
    phoneFromId(user.pn) ||
    phoneFromId(user.id) ||
    phoneFromId(user.jid) ||
    ''
  );
}

function getPairingState() {
  return {
    connected: waConnected,
    hasQr: Boolean(latestQr),
    qr: latestQr,
    phone: waConnected ? connectedPhone(sock) : '',
    pairing: repairing || (starting && !waConnected && !latestQr),
  };
}

async function rePairWhatsApp() {
  if (repairing) return getPairingState();
  repairing = true;
  console.log('[whatsapp] starting new pairing — current number will disconnect');
  try {
    clearTimers();
    namedBot = false;
    latestQr = null;
    waConnected = false;
    reconnectDelay = 3000;
    replacedAt = [];
    const current = sock;
    sock = null;
    if (current) {
      try {
        current.ev.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        await Promise.race([
          current.logout(),
          new Promise((resolve) => setTimeout(resolve, 4000)),
        ]);
      } catch {
        /* ignore */
      }
      try {
        current.ws?.close();
      } catch {
        /* ignore */
      }
      try {
        current.end?.(undefined);
      } catch {
        /* ignore */
      }
    }
    clearAuthDir();
    releaseInstance();
  } finally {
    repairing = false;
  }
  await startWhatsApp();
  return getPairingState();
}

module.exports = { startWhatsApp, getSocket, getPairingState, rePairWhatsApp };
