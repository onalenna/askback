const { statements } = require('../db/queries');
const { getEmbedding, openai } = require('../ai/embeddings');
const { searchAll } = require('../ai/search');
const { polishAnswer } = require('../ai/generator');
const { getAllowedGroupJids, getGroupMeta, isBroadcastGroup, nameFromHistory } = require('./groups');
const { rememberOutbound } = require('./history');
const { getBotMode } = require('./answer');

const TZ = 'Africa/Maputo'; // CAT
const SETTING_ENABLED = 'deadline_reminders';
const SETTING_SENT = 'deadline_reminders_sent';
const LEAD_MS = 30 * 60 * 1000;
const TICK_MS = 30 * 1000;
const REFRESH_MS = 15 * 60 * 1000;
const LOOKAHEAD_MS = 48 * 60 * 60 * 1000;
const DEFAULT_TIME_IF_DATE_ONLY = '17:00'; // CAT end-of-day style deadlines

let tickTimer = null;
let refreshTimer = null;
let refreshing = false;
let ticking = false;
/** @type {{ key: string, title: string, atMs: number, kind: string }[]} */
let upcoming = [];
let lastRefreshAt = 0;

function catDateKey(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function formatCatClock(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

function getDeadlineReminders() {
  try {
    const row = statements.getSetting.get(SETTING_ENABLED);
    if (!row?.value) return 'on';
    return row.value === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

function setDeadlineReminders(enabled) {
  const value = enabled ? 'on' : 'off';
  statements.setSetting.run(SETTING_ENABLED, value);
  return value;
}

function loadSentMap() {
  try {
    const parsed = JSON.parse(statements.getSetting.get(SETTING_SENT)?.value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSentMap(map) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const pruned = {};
  for (const [key, at] of Object.entries(map || {})) {
    if (Number(at) >= cutoff) pruned[key] = Number(at);
  }
  statements.setSetting.run(SETTING_SENT, JSON.stringify(pruned));
}

function markSent(key) {
  const map = loadSentMap();
  map[key] = Date.now();
  saveSentMap(map);
}

function alreadySent(key) {
  return Boolean(loadSentMap()[key]);
}

function eventKey(title, atMs) {
  return `${atMs}|${String(title || '').trim().toLowerCase()}`.slice(0, 220);
}

function parseEventTime(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T${DEFAULT_TIME_IF_DATE_ONLY}:00+02:00`);
    return Number.isFinite(ms) ? ms : null;
  }

  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }

  const local = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (local) {
    const [, date, hh, mm, ss = '00'] = local;
    const ms = Date.parse(
      `${date}T${String(hh).padStart(2, '0')}:${mm}:${String(ss).padStart(2, '0')}+02:00`
    );
    return Number.isFinite(ms) ? ms : null;
  }

  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

async function loadKnowledgeContext() {
  const today = catDateKey();
  const query = `deadlines due dates schedule meeting submission expectation ${today}`;
  try {
    const embedding = await getEmbedding(query);
    const { knowledge } = await searchAll(embedding, {
      loose: true,
      query: `deadline due schedule meeting at ${today}`,
      limit: 14,
    });
    return (knowledge || [])
      .map((c, i) => `Section ${i + 1}:\n${c.content}`)
      .join('\n\n')
      .slice(0, 9000);
  } catch (err) {
    console.warn('[reminders] knowledge search failed:', err.message || err);
    return '';
  }
}

function recentScheduleSnippets() {
  const since = Math.floor((Date.now() - LOOKAHEAD_MS) / 1000);
  const until = Math.floor(Date.now() / 1000) + 60;
  const bits = [];
  for (const jid of getAllowedGroupJids()) {
    try {
      const rows = statements.chatMessagesInRange.all(jid, since, until, 80);
      for (const row of rows) {
        const body = String(row.body || '');
        if (
          !/\b(due|deadline|submit|submission|meeting|call|session|workshop|interview|schedule|scheduled|starts?|beginning)\b/i.test(
            body
          ) &&
          !/\b\d{1,2}:\d{2}\b/.test(body)
        ) {
          continue;
        }
        const who = row.from_me ? 'askBack' : row.sender_name || 'Member';
        bits.push(`${who}: ${body}`);
      }
    } catch {
      /* ignore */
    }
  }
  return bits.slice(0, 60).join('\n').slice(0, 5000);
}

async function extractUpcomingEvents() {
  const now = Date.now();
  const knowledge = await loadKnowledgeContext();
  const chat = recentScheduleSnippets();
  if (!knowledge && !chat) return [];

  const completion = await openai.chat.completions.create({
    model: require('../ai/embeddings').CHAT_MODEL(),
    temperature: 0.1,
    max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Extract upcoming deadlines and scheduled items. Return JSON only. Never invent times. Prefer Africa/Maputo (CAT, UTC+2).',
      },
      {
        role: 'user',
        content: [
          `Now (ISO): ${new Date(now).toISOString()}`,
          `Today in CAT: ${catDateKey(now)}`,
          'Find deadlines, due times, meetings, calls, sessions, or other scheduled items in the next 48 hours.',
          'Return JSON: {"events":[{"title":"short name","when":"ISO-8601 with +02:00 offset","kind":"deadline|meeting|schedule"}]}',
          'Rules:',
          '- Include only items with a usable date.',
          '- If a date has no time, use 17:00+02:00 that day.',
          '- Skip vague items with no date.',
          '- Max 20 events.',
          '',
          'Knowledge material:',
          knowledge || '(none)',
          '',
          'Recent group messages:',
          chat || '(none)',
        ].join('\n'),
      },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content || '{}');
  } catch {
    return [];
  }

  const events = [];
  const seen = new Set();
  for (const item of parsed.events || []) {
    const title = String(item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const atMs = parseEventTime(item?.when);
    if (!title || !atMs) continue;
    if (atMs < now - 5 * 60 * 1000) continue;
    if (atMs > now + LOOKAHEAD_MS) continue;
    const key = eventKey(title, atMs);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      key,
      title,
      atMs,
      kind: String(item?.kind || 'schedule').toLowerCase(),
    });
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}

async function refreshUpcoming() {
  if (refreshing) return;
  if (getDeadlineReminders() === 'off') {
    upcoming = [];
    return;
  }
  refreshing = true;
  try {
    upcoming = await extractUpcomingEvents();
    lastRefreshAt = Date.now();
    console.log(
      `[reminders] tracking ${upcoming.length} upcoming item(s)` +
        (upcoming[0] ? `; next "${upcoming[0].title}" at ${formatCatClock(upcoming[0].atMs)}` : '')
    );
  } catch (err) {
    console.error('[reminders] refresh failed:', err.message || err);
  } finally {
    refreshing = false;
  }
}

function reminderText(event) {
  const when = formatCatClock(event.atMs);
  const kind =
    event.kind === 'deadline'
      ? 'Deadline'
      : event.kind === 'meeting'
        ? 'Meeting'
        : 'Scheduled';
  const raw = [
    'Reminder for everyone (30 minutes)',
    '',
    `${kind}: ${event.title}`,
    `When: ${when} CAT`,
  ].join('\n');
  return polishAnswer(raw);
}

async function broadcastReminder(event) {
  const { getSocket } = require('./client');
  const sock = getSocket();
  if (!sock?.sendMessage) throw new Error('WhatsApp is not connected');

  const text = reminderText(event);
  const groups = getAllowedGroupJids();
  let sent = 0;
  for (const jid of groups) {
    try {
      const meta = await getGroupMeta(sock, jid).catch(() => null);
      if (isBroadcastGroup(meta)) continue;
      const result = await sock.sendMessage(jid, { text });
      rememberOutbound(jid, result, text);
      sent += 1;
      console.log(
        `[reminders] reminded ${(meta?.subject || nameFromHistory(jid) || jid)} about ${event.title}`
      );
    } catch (err) {
      console.error(`[reminders] send failed for ${jid}:`, err.message || err);
    }
  }
  return sent;
}

async function tickReminders() {
  if (ticking) return;
  if (getDeadlineReminders() === 'off') return;
  if (getBotMode() === 'off') return;

  ticking = true;
  try {
    if (!lastRefreshAt || Date.now() - lastRefreshAt > REFRESH_MS) {
      await refreshUpcoming();
    }

    const now = Date.now();
    for (const event of upcoming) {
      const remindAt = event.atMs - LEAD_MS;
      if (now < remindAt) continue;
      if (now >= event.atMs) continue; // too late
      if (alreadySent(event.key)) continue;
      try {
        const n = await broadcastReminder(event);
        markSent(event.key);
        if (!n) {
          console.warn(`[reminders] no groups received reminder for ${event.title}`);
        }
      } catch (err) {
        console.error('[reminders] broadcast failed:', err.message || err);
      }
    }
  } finally {
    ticking = false;
  }
}

function clearReminderTimers() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startDeadlineReminders() {
  clearReminderTimers();
  if (getDeadlineReminders() === 'off') {
    console.log('[reminders] deadline reminders off');
    return;
  }
  console.log('[reminders] watching for deadlines/schedules (30 min before)');
  setTimeout(() => {
    refreshUpcoming().catch((err) =>
      console.error('[reminders] initial refresh failed:', err.message || err)
    );
  }, 20_000);
  tickTimer = setInterval(() => {
    tickReminders().catch((err) => console.error('[reminders] tick failed:', err.message || err));
  }, TICK_MS);
  refreshTimer = setInterval(() => {
    refreshUpcoming().catch((err) =>
      console.error('[reminders] refresh failed:', err.message || err)
    );
  }, REFRESH_MS);
}

function stopDeadlineReminders() {
  clearReminderTimers();
}

function restartDeadlineReminders() {
  startDeadlineReminders();
}

module.exports = {
  startDeadlineReminders,
  stopDeadlineReminders,
  restartDeadlineReminders,
  refreshUpcoming,
  tickReminders,
  getDeadlineReminders,
  setDeadlineReminders,
};
