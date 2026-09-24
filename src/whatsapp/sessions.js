'use strict';
// Proactive session reminders — posts 60-min, 15-min, and live alerts to allowed groups.

const { statements } = require('../db/queries');
const { getBotMode } = require('./answer');

const TZ = 'Africa/Maputo'; // CAT UTC+2, no DST

// Known session links
const WADHWANI_LINK = 'https://teams.microsoft.com/meet/419860837373470?p=jYchWkDZnC4etsclnK';
const WADHWANI_ID   = '419 860 837 373 470';
const WADHWANI_PASS = 'g2Z7gc7Q';
const MIT_LINK      = 'https://teams.microsoft.com/meet/369123389215172?p=E4YbRFyzKjPR5AFYUf';

const DEFAULT_SESSIONS = [
  {
    id: 'wadh-tue',
    name: 'Wadhwani Module Class',
    dayOfWeek: 2, // Tuesday
    catHour: 15, catMinute: 0,
    link: WADHWANI_LINK,
    detail: `Meeting ID: ${WADHWANI_ID} · Passcode: ${WADHWANI_PASS}`,
    enabled: true,
  },
  {
    id: 'wadh-thu',
    name: 'Wadhwani Coaching/Q&A',
    dayOfWeek: 4, // Thursday
    catHour: 15, catMinute: 0,
    link: WADHWANI_LINK,
    detail: `Meeting ID: ${WADHWANI_ID} · Passcode: ${WADHWANI_PASS}`,
    enabled: true,
  },
  {
    id: 'mit-wed',
    name: 'MIT Universal AI Session',
    dayOfWeek: 3, // Wednesday
    catHour: 14, catMinute: 0,
    link: MIT_LINK,
    detail: '',
    enabled: false,
  },
];

function getSessions() {
  try {
    const row = statements.getSetting.get('session_schedule');
    if (row && row.value) return JSON.parse(row.value);
  } catch (_) {}
  return DEFAULT_SESSIONS;
}

function saveSessions(sessions) {
  statements.setSetting.run('session_schedule', JSON.stringify(sessions));
}

function catNow() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return {
    dayOfWeek: dayNames.indexOf(parts.weekday),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function getAllowedJids() {
  try {
    const row = statements.getSetting.get('allowed_groups');
    return JSON.parse(row?.value || '[]');
  } catch (_) {
    return [];
  }
}

function sendToGroups(text) {
  try {
    const { getSocket } = require('./client');
    const { sendGroupText } = require('./groups');
    const socket = getSocket();
    if (!socket) return;
    const jids = getAllowedJids();
    for (const jid of jids) {
      sendGroupText(socket, jid, text).catch(err =>
        console.warn('[sessions] send failed:', jid, err.message || err)
      );
    }
  } catch (err) {
    console.warn('[sessions] sendToGroups error:', err.message || err);
  }
}

function tick() {
  if (getBotMode() === 'off') return;
  const now = catNow();
  const sessions = getSessions().filter(s => s.enabled !== false);

  for (const s of sessions) {
    if (s.dayOfWeek !== now.dayOfWeek) continue;
    const sMin = s.catHour * 60 + s.catMinute;
    const nMin = now.hour * 60 + now.minute;
    const diff = sMin - nMin;

    if (diff === 60) {
      sendToGroups(
        `📅 *Reminder:* ${s.name} starts in 1 hour (${s.catHour}:${String(s.catMinute).padStart(2,'0')} CAT)\n\nJoin: ${s.link}${s.detail ? '\n' + s.detail : ''}`
      );
    } else if (diff === 15) {
      sendToGroups(
        `⏰ *${s.name}* starts in *15 minutes!*\n\nJoin now: ${s.link}`
      );
    } else if (diff === 0) {
      sendToGroups(
        `🔴 *${s.name} is LIVE NOW!*\n\nJoin: ${s.link}`
      );
    }
  }

  // Morning summary at 7:00 AM CAT
  if (now.hour === 7 && now.minute === 0) {
    const todaySessions = sessions.filter(s => s.dayOfWeek === now.dayOfWeek && s.enabled !== false);
    let msg;
    if (todaySessions.length) {
      const lines = todaySessions.map(s =>
        `• ${s.name} at ${s.catHour}:${String(s.catMinute).padStart(2,'0')} CAT — ${s.link}`
      );
      msg = `🌅 *Good morning, cohort!*\n\nHere's what's on today:\n${lines.join('\n')}\n\nHave any questions? Just ask the bot! 🤖`;
    } else {
      msg = `🌅 *Good morning, cohort!*\n\nNo live sessions scheduled for today. Keep working on the MIT Universal AI course and your Wadhwani modules! 💪`;
    }
    sendToGroups(msg);
  }
}

let timer = null;

function startSessionReminders() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 60 * 1000);
  console.log('[sessions] reminder scheduler started');
}

function stopSessionReminders() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { startSessionReminders, stopSessionReminders, getSessions, saveSessions };
