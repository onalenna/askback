const { statements } = require('../db/queries');
const { openai, CHAT_MODEL } = require('../ai/embeddings');
const { polishAnswer } = require('../ai/generator');
const { formatChatContext } = require('./history');

/**
 * Time-window catch-up.
 *
 * Lets a member who was away ask "catch me up", "what did I miss since Monday",
 * "what happened in the last 2 days" and get a short recap of the group chat
 * over that window. This is different from the daily digest (which is a
 * scheduled 05:00 briefing to every group) and from the generic chat recap
 * (which has no time boundary): here the member picks the window.
 *
 * All time math is done in Africa/Maputo (CAT, UTC+2, no DST), matching
 * digest.js and reminders.js so the whole bot agrees on "today".
 */

const TZ = 'Africa/Maputo';
const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // never look back more than 2 weeks
const MAX_LINES = 200;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/** YYYY-MM-DD for a moment, in CAT. */
function catDateKey(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Unix seconds for CAT midnight at the start of a YYYY-MM-DD key. */
function catMidnightUnix(dateKey) {
  return Math.floor(new Date(`${dateKey}T00:00:00+02:00`).getTime() / 1000);
}

/** Shift a CAT date key by whole days. */
function shiftDateKey(dateKey, days) {
  const base = new Date(`${dateKey}T12:00:00+02:00`).getTime();
  return catDateKey(base + days * 24 * 60 * 60 * 1000);
}

/** 0 (Sun) .. 6 (Sat) weekday index of a CAT date key. */
function catWeekday(dateKey) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' })
    .format(new Date(`${dateKey}T12:00:00+02:00`))
    .toLowerCase();
  return Math.max(0, WEEKDAYS.indexOf(name));
}

/**
 * Detect a catch-up request. Kept deliberately specific so ordinary "what did
 * X say" questions do not trigger a full recap.
 */
function isCatchupRequest(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t) return false;
  if (/\b(catch me up|catch up|bring me up to speed|get me up to speed)\b/.test(t)) return true;
  if (/\bwhat (did i|have i) miss(ed)?\b/.test(t)) return true;
  if (/\bwhat('?s| has| have)? (been )?happen(ed|ing)?\b/.test(t) && /\b(since|last|today|yesterday|this week|while)\b/.test(t)) {
    return true;
  }
  if (/\b(summar(y|ise|ize)|recap|update me)\b/.test(t) && /\b(since|last \d|today|yesterday|this week|past)\b/.test(t)) {
    return true;
  }
  if (/\bsince (yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this morning|last night)\b/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Work out the start moment (unix seconds) for the window described in the
 * text, relative to now (CAT). Falls back to the last 24 hours when nothing
 * specific is named. Returns { startSec, label } for use in the summary.
 */
function resolveWindow(text, now = Date.now()) {
  const t = String(text || '').toLowerCase();
  const todayKey = catDateKey(now);

  // "last N hours" / "past N hours"
  const hours = t.match(/\b(?:last|past)\s+(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\b/);
  if (hours) {
    const n = Math.min(Number(hours[1]) || 0, 24 * 14);
    if (n > 0) {
      return { startSec: Math.floor((now - n * 60 * 60 * 1000) / 1000), label: `the last ${n} hours` };
    }
  }

  // "last N days" / "past N days"
  const days = t.match(/\b(?:last|past)\s+(\d{1,2})\s*(?:d|day|days)\b/);
  if (days) {
    const n = Math.min(Number(days[1]) || 0, 14);
    if (n > 0) {
      const key = shiftDateKey(todayKey, -(n - 1));
      return { startSec: catMidnightUnix(key), label: `the last ${n} days` };
    }
  }

  if (/\btoday|this morning\b/.test(t)) {
    return { startSec: catMidnightUnix(todayKey), label: 'today' };
  }
  if (/\byesterday|last night\b/.test(t)) {
    const key = shiftDateKey(todayKey, -1);
    return { startSec: catMidnightUnix(key), label: 'yesterday' };
  }
  if (/\bthis week\b/.test(t)) {
    // Week starts Monday.
    const wd = catWeekday(todayKey); // 0=Sun..6=Sat
    const backToMonday = wd === 0 ? 6 : wd - 1;
    const key = shiftDateKey(todayKey, -backToMonday);
    return { startSec: catMidnightUnix(key), label: 'this week' };
  }

  // "since <weekday>"
  const wdMatch = t.match(/\bsince\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wdMatch) {
    const target = WEEKDAYS.indexOf(wdMatch[1]);
    const todayWd = catWeekday(todayKey);
    let back = (todayWd - target + 7) % 7;
    if (back === 0) back = 7; // "since Monday" on a Monday means a week ago
    const key = shiftDateKey(todayKey, -back);
    const nice = wdMatch[1].charAt(0).toUpperCase() + wdMatch[1].slice(1);
    return { startSec: catMidnightUnix(key), label: `since ${nice}` };
  }

  // Default: last 24 hours.
  return { startSec: Math.floor((now - 24 * 60 * 60 * 1000) / 1000), label: 'the last day' };
}

/**
 * Produce a short WhatsApp-style recap for the requested window in one chat.
 * Returns null when the bot should stay silent (no messages / model gave up).
 * @param {string} chatJid the chat to recap
 * @param {string} text the member's request (used to parse the window)
 * @param {string} language reply language hint
 */
async function buildCatchup(chatJid, text, { language = 'en' } = {}) {
  if (!chatJid) return null;
  const now = Date.now();
  const { startSec, label } = resolveWindow(text, now);
  const safeStart = Math.max(startSec, Math.floor((now - MAX_WINDOW_MS) / 1000));
  const endSec = Math.floor(now / 1000) + 60;

  let rows = [];
  try {
    rows = statements.chatMessagesInRange.all(chatJid, safeStart, endSec, MAX_LINES);
  } catch (err) {
    console.warn('[catchup] could not load messages:', err.message || err);
    return null;
  }

  if (!rows.length) {
    return {
      text: `I don't have any saved messages for ${label} in this chat, so there is nothing to catch up on yet.`,
      source: 'catchup',
      files: [],
      language: language || 'en',
    };
  }

  const lines = rows.map((row) => ({
    fromMe: !!row.from_me,
    name: row.sender_name,
    text: row.body,
    quoted: row.quoted,
    ts: row.ts,
  }));
  const chatBlock = formatChatContext(lines).slice(0, 8000);

  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL(),
      temperature: 0.35,
      messages: [
        {
          role: 'system',
          content:
            'You catch someone up on a WhatsApp group they missed. Be brief and clear, relaxed tone. Only use the messages given. Never invent things. Never mention knowledge files or sources. Never use -- or dash characters as punctuation.',
        },
        {
          role: 'user',
          content: [
            `Catch me up on what I missed (${label}).`,
            'Cover the main topics, any decisions, and questions still open. Say who said key things when it is clear.',
            'Keep it under 150 words. If it was quiet, just say so.',
            '',
            'Messages (oldest first):',
            chatBlock,
          ].join('\n'),
        },
      ],
    });
    const raw = (completion.choices[0].message.content || '').trim();
    if (!raw || raw.includes('BOT_NO_ANSWER')) {
      return {
        text: `It was quiet in this chat over ${label}, nothing big to flag.`,
        source: 'catchup',
        files: [],
        language: language || 'en',
      };
    }
    return { text: polishAnswer(raw), source: 'catchup', files: [], language: language || 'en' };
  } catch (err) {
    console.warn('[catchup] summary failed:', err.message || err);
    return null;
  }
}

module.exports = {
  isCatchupRequest,
  resolveWindow,
  buildCatchup,
};
