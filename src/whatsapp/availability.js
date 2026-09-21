'use strict';
/**
 * Availability calendar helpers.
 * The bot answers "Is Person A available today/tomorrow/on Monday?" by
 * checking the schedule stored in the availability table.
 */

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const SHORT = ['sun','mon','tue','wed','thu','fri','sat'];

function getDb() { return require('../db/index'); }

function getSchedule() {
  return getDb().prepare(`SELECT * FROM availability ORDER BY name, dow, start_h`).all();
}

/** Parse a question for availability intent. Returns { name, dow } or null. */
function parseAvailabilityQuestion(text) {
  const s = String(text || '').toLowerCase();
  if (!/available|free|schedule|when.*meet|meet.*when|book|availability/.test(s)) return null;

  // Detect day reference
  let dow = null;
  const now = new Date();
  if (/today/.test(s)) dow = now.getDay();
  else if (/tomorrow/.test(s)) dow = (now.getDay() + 1) % 7;
  else {
    for (let i = 0; i < SHORT.length; i++) {
      if (s.includes(SHORT[i])) { dow = i; break; }
    }
  }

  // Detect person name (look for capitalised words after "is" / "when is")
  const nameMatch = text.match(/(?:is|when is|when will|when can|book)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s/);
  const name = nameMatch?.[1] || null;

  return name || dow !== null ? { name, dow } : null;
}

/** Build a natural-language availability answer. */
function availabilityAnswer(intent) {
  const rows = getSchedule();
  if (!rows.length) return null;

  // Filter by name if specified
  const people = intent.name
    ? rows.filter((r) => r.name.toLowerCase().includes(intent.name.toLowerCase()))
    : rows;

  if (!people.length) return null;

  const byPerson = new Map();
  for (const r of people) {
    if (!byPerson.has(r.name)) byPerson.set(r.name, []);
    byPerson.get(r.name).push(r);
  }

  const lines = [];
  for (const [person, slots] of byPerson) {
    if (intent.dow !== null) {
      const daySlots = slots.filter((s) => s.dow === intent.dow);
      if (!daySlots.length) {
        lines.push(`${person} is *not available* on ${DAYS[intent.dow]}.`);
      } else {
        const times = daySlots.map((s) => `${fmt(s.start_h)}–${fmt(s.end_h)}${s.label ? ` (${s.label})` : ''}`).join(', ');
        lines.push(`${person} is available on ${DAYS[intent.dow]}: ${times}.`);
      }
    } else {
      // Show full weekly schedule
      const byDay = slots.reduce((acc, s) => {
        if (!acc[s.dow]) acc[s.dow] = [];
        acc[s.dow].push(s);
        return acc;
      }, {});
      const schedule = Object.entries(byDay)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([dow, ss]) => `${DAYS[Number(dow)]}: ${ss.map((s) => `${fmt(s.start_h)}–${fmt(s.end_h)}`).join(', ')}`)
        .join('; ');
      lines.push(`*${person}* — ${schedule}.`);
    }
  }

  return lines.join('\n');
}

function fmt(h) {
  const hour = h % 24;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}:00 ${ampm}`;
}

module.exports = { parseAvailabilityQuestion, availabilityAnswer, getSchedule };
