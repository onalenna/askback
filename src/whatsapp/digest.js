const { statements } = require('../db/queries');
const { getEmbedding } = require('../ai/embeddings');
const { openai } = require('../ai/embeddings');
const { searchAll } = require('../ai/search');
const { polishAnswer } = require('../ai/generator');
const { getAllowedGroupJids, getGroupMeta, isBroadcastGroup, nameFromHistory } = require('./groups');
const { formatChatContext, rememberOutbound } = require('./history');
const { getBotMode } = require('./answer');

const TZ = 'Africa/Maputo'; // CAT (UTC+2, no DST)
const SETTING_ENABLED = 'daily_digest';
const SETTING_LAST = 'daily_digest_last';
const MAX_YESTERDAY_LINES = 120;
const MAX_KNOWLEDGE = 10;

let timer = null;
let running = false;

function catDateKey(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function catHourMinute(ms = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

function catMidnightUnix(dateKey) {
  return Math.floor(new Date(`${dateKey}T00:00:00+02:00`).getTime() / 1000);
}

function shiftDateKey(dateKey, days) {
  const base = new Date(`${dateKey}T12:00:00+02:00`).getTime();
  return catDateKey(base + days * 24 * 60 * 60 * 1000);
}

function formatCatLabel(dateKey) {
  const dt = new Date(`${dateKey}T12:00:00+02:00`);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(dt);
}

function nextFiveAmCatMs(fromMs = Date.now()) {
  const todayKey = catDateKey(fromMs);
  let runAt = new Date(`${todayKey}T05:00:00+02:00`).getTime();
  if (fromMs >= runAt) {
    runAt = new Date(`${shiftDateKey(todayKey, 1)}T05:00:00+02:00`).getTime();
  }
  return runAt;
}

function getDailyDigest() {
  try {
    const row = statements.getSetting.get(SETTING_ENABLED);
    if (!row?.value) return 'on';
    return row.value === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

function setDailyDigest(enabled) {
  const value = enabled ? 'on' : 'off';
  statements.setSetting.run(SETTING_ENABLED, value);
  return value;
}

function getLastDigestDay() {
  try {
    return String(statements.getSetting.get(SETTING_LAST)?.value || '').trim();
  } catch {
    return '';
  }
}

function setLastDigestDay(dateKey) {
  statements.setSetting.run(SETTING_LAST, dateKey);
}

function yesterdayMessages(chatJid, yesterdayKey) {
  const start = catMidnightUnix(yesterdayKey);
  const end = catMidnightUnix(shiftDateKey(yesterdayKey, 1));
  try {
    const rows = statements.chatMessagesInRange.all(chatJid, start, end, MAX_YESTERDAY_LINES);
    return rows.map((row) => ({
      id: row.msg_id,
      fromMe: !!row.from_me,
      name: row.sender_name,
      text: row.body,
      quoted: row.quoted,
      ts: row.ts,
    }));
  } catch (err) {
    console.warn('[digest] could not load yesterday messages:', err.message || err);
    return [];
  }
}

async function todayKnowledge(todayLabel, todayKey) {
  const query = [
    `deadlines expectations due today ${todayLabel} ${todayKey}`,
    'schedule tasks assignments submissions due date expectations',
  ].join(' ');
  try {
    const embedding = await getEmbedding(query);
    const { knowledge } = await searchAll(embedding, {
      loose: true,
      query: `deadline due ${todayKey} ${todayLabel} expectation schedule`,
      limit: MAX_KNOWLEDGE,
    });
    return knowledge || [];
  } catch (err) {
    console.warn('[digest] knowledge search failed:', err.message || err);
    return [];
  }
}

async function composeDigest({
  groupName,
  yesterdayLabel,
  todayLabel,
  yesterdayLines,
  knowledge,
}) {
  const chatBlock = yesterdayLines.length
    ? formatChatContext(yesterdayLines).slice(0, 6000)
    : '(no messages saved for yesterday)';
  const knowledgeBlock = knowledge.length
    ? knowledge.map((c, i) => `Section ${i + 1}:\n${c.content}`).join('\n\n').slice(0, 7000)
    : '(nothing found about deadlines or expectations)';

  const completion = await openai.chat.completions.create({
    model: require('../ai/embeddings').CHAT_MODEL(),
    temperature: 0.35,
    messages: [
      {
        role: 'system',
        content:
          'You write a very brief WhatsApp morning briefing. Two short sections only. No fluff. Never mention knowledge files or sources. Never use -- or dash characters as punctuation.',
      },
      {
        role: 'user',
        content: [
          `Group: ${groupName || 'WhatsApp group'}`,
          `Write a short morning briefing for ${todayLabel}.`,
          '',
          'Format exactly:',
          `Yesterday (${yesterdayLabel})`,
          '<2 to 4 short bullets or one tight paragraph. Only what mattered. If quiet, say it was quiet.>',
          '',
          `Today (${todayLabel})`,
          '<Deadlines and expectations for today, short and direct. If none are clear, say no deadlines noted.>',
          '',
          'Rules:',
          '- Keep the whole message under 120 words.',
          '- Be clear and to the point.',
          '- Do not invent deadlines.',
          '- Do not say according to knowledge files.',
          '',
          'Messages from yesterday:',
          chatBlock,
          '',
          'Material for today deadlines and expectations:',
          knowledgeBlock,
        ].join('\n'),
      },
    ],
  });

  const raw = (completion.choices[0].message.content || '').trim();
  if (!raw || raw.includes('BOT_NO_ANSWER')) {
    return [
      `Yesterday (${yesterdayLabel})`,
      yesterdayLines.length ? 'A few messages landed, nothing big to flag.' : 'Quiet day.',
      '',
      `Today (${todayLabel})`,
      'No deadlines noted.',
    ].join('\n');
  }
  return polishAnswer(raw);
}

async function sendDigestToGroup(sock, jid, text) {
  if (!sock?.sendMessage) throw new Error('WhatsApp is not connected');
  const sent = await sock.sendMessage(jid, { text });
  rememberOutbound(jid, sent, text);
  return sent;
}

async function runDailyDigest({ force = false } = {}) {
  if (running) return { ok: false, error: 'Digest already running' };
  if (!force && getDailyDigest() === 'off') {
    return { ok: false, error: 'Daily digest is off' };
  }
  if (getBotMode() === 'off') {
    return { ok: false, error: 'Bot is off' };
  }

  const { getSocket } = require('./client');
  const sock = getSocket();
  if (!sock) return { ok: false, error: 'WhatsApp is not connected' };

  const todayKey = catDateKey();
  if (!force && getLastDigestDay() === todayKey) {
    return { ok: true, skipped: true, day: todayKey };
  }

  running = true;
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const yesterdayLabel = formatCatLabel(yesterdayKey);
  const todayLabel = formatCatLabel(todayKey);
  const groups = getAllowedGroupJids();
  const results = [];

  try {
    const knowledge = await todayKnowledge(todayLabel, todayKey);

    for (const jid of groups) {
      try {
        const meta = await getGroupMeta(sock, jid).catch(() => null);
        if (isBroadcastGroup(meta)) {
          results.push({ jid, skipped: true, reason: 'community hub' });
          continue;
        }
        const groupName = meta?.subject || nameFromHistory(jid) || jid;
        const yesterdayLines = yesterdayMessages(jid, yesterdayKey);
        const text = await composeDigest({
          groupName,
          yesterdayLabel,
          todayLabel,
          yesterdayLines,
          knowledge,
        });
        await sendDigestToGroup(sock, jid, text);
        console.log(`[digest] sent morning briefing to ${groupName}`);
        results.push({ jid, name: groupName, ok: true });
      } catch (err) {
        console.error(`[digest] failed for ${jid}:`, err.message || err);
        results.push({ jid, ok: false, error: err.message || 'send failed' });
      }
    }

    if (!force || results.some((r) => r.ok)) {
      setLastDigestDay(todayKey);
    }

    return { ok: true, day: todayKey, sent: results.filter((r) => r.ok).length, results };
  } finally {
    running = false;
  }
}

function clearDigestTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNextDigest() {
  clearDigestTimer();
  if (getDailyDigest() === 'off') {
    console.log('[digest] daily briefing off');
    return;
  }
  const delay = Math.max(5_000, nextFiveAmCatMs() - Date.now());
  timer = setTimeout(async () => {
    try {
      await runDailyDigest();
    } catch (err) {
      console.error('[digest] scheduled run failed:', err.message || err);
    } finally {
      scheduleNextDigest();
    }
  }, delay);
  const mins = Math.round(delay / 60_000);
  console.log(`[digest] next morning briefing in ~${mins} min (05:00 CAT)`);
}

async function maybeCatchUpDigest() {
  if (getDailyDigest() === 'off') return;
  if (getBotMode() === 'off') return;
  const { hour } = catHourMinute();
  if (hour < 5) return;
  const todayKey = catDateKey();
  const last = getLastDigestDay();
  if (!last) return; // first enable: wait for the next 05:00 CAT
  if (last === todayKey) return;
  console.log('[digest] catching up missed 05:00 CAT briefing');
  try {
    await runDailyDigest();
  } catch (err) {
    console.error('[digest] catch-up failed:', err.message || err);
  }
}

function startDailyDigest() {
  scheduleNextDigest();
  setTimeout(() => {
    maybeCatchUpDigest().catch((err) =>
      console.error('[digest] catch-up error:', err.message || err)
    );
  }, 15_000);
}

function stopDailyDigest() {
  clearDigestTimer();
}

module.exports = {
  startDailyDigest,
  stopDailyDigest,
  scheduleNextDigest,
  runDailyDigest,
  getDailyDigest,
  setDailyDigest,
  catDateKey,
};
