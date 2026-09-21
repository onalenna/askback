'use strict';
/**
 * Personality & tone injection for the AI system prompt.
 *
 * Each profile changes how the bot sounds and how it handles:
 * - General tone
 * - Emoji usage
 * - Off-topic questions (deflection style)
 */

const { getPersona, getProgramContext, getEmojiMode, getOffTopicMode } = require('./settings');

// ── Persona definitions ───────────────────────────────────────────────────────

const PERSONAS = {
  funny: {
    label: 'Funny',
    emoji: '😄',
    tone: 'You have a sharp, warm sense of humour. Use well-timed jokes, light sarcasm, and playful phrasing — but always stay accurate and respectful. Never be mean-spirited.',
    emojiDefault: 'expressive',
  },
  serious: {
    label: 'Serious',
    emoji: '🎯',
    tone: 'You are precise, direct, and professional. Skip jokes. Deliver clean, well-structured answers. Emojis are minimal.',
    emojiDefault: 'none',
  },
  friendly: {
    label: 'Friendly',
    emoji: '😊',
    tone: 'You are warm, encouraging, and conversational — like a knowledgeable friend in the group. Light humour is welcome when it fits naturally.',
    emojiDefault: 'light',
  },
  professional: {
    label: 'Professional',
    emoji: '💼',
    tone: 'You are polished and confident. Speak clearly, avoid slang, and stay on-brand. A touch of warmth is fine but keep it formal enough for a work setting.',
    emojiDefault: 'light',
  },
};

// ── Emoji rules ───────────────────────────────────────────────────────────────

const EMOJI_RULES = {
  none:       'Do not use any emojis in your replies.',
  light:      'Use 1–2 emojis per reply maximum — only where they genuinely add warmth or clarity.',
  expressive: 'Use emojis freely and expressively to bring the message to life, but never overdo it to the point of being distracting.',
};

// ── Off-topic deflections ─────────────────────────────────────────────────────

const DEFLECTIONS = {
  funny: [
    "Uuuuh… I see what you did there 😏 Nice try! But I'm only here for {PROGRAM} questions — ask me something from the curriculum and I'll actually be useful 🎓",
    "Oooh a curve ball 🏏 '{QUESTION}'? Really? I appreciate the creativity but my brain is wired for {PROGRAM} stuff only 😄 Ask me something on topic!",
    "👀 I *see* you trying to take me off-script. Bold move. Sadly, '{QUESTION}' is way outside my lane — I'm a {PROGRAM} specialist, not a Google substitute 😂",
    "That's… a fascinating question 🤔 Unfortunately I left my general knowledge at home today. Hit me with something about {PROGRAM} though — that's where I shine ✨",
    "Haha, okay but no 😄 '{QUESTION}' is not exactly METI AI Program material. Ask me about the programme and I'll be your best resource!",
  ],
  serious: [
    "That question is outside the scope of {PROGRAM}. Please keep questions relevant to the programme.",
    "'{QUESTION}' is not related to {PROGRAM}. I'm only configured to answer programme-related questions.",
    "Off-topic. Please direct general questions elsewhere and stick to {PROGRAM} topics here.",
  ],
  friendly: [
    "That's a fun question but it's a bit outside what I cover here 😊 I'm set up specifically for {PROGRAM} — ask me something about the programme and I'll do my best!",
    "Ha, nice one! '{QUESTION}' is a little outside my area though 🙂 I'm your go-to for {PROGRAM} questions — try one of those!",
    "Good question, but not quite my department 😄 I'm here for {PROGRAM} — what would you like to know about the programme?",
  ],
  professional: [
    "This question falls outside the scope of {PROGRAM}. I'm configured to assist with programme-related topics only.",
    "'{QUESTION}' is not within my area of coverage. For {PROGRAM} questions, I'm at your service.",
    "I'm here to support {PROGRAM} participants with programme-related questions. Please redirect general queries appropriately.",
  ],
};

// ── Public API ────────────────────────────────────────────────────────────────

/** Build the persona + emoji block for the system prompt. */
function personaBlock() {
  const persona = getPersona();
  const profile = PERSONAS[persona] || PERSONAS.friendly;
  const emojiMode = getEmojiMode() || profile.emojiDefault;
  const emojiRule = EMOJI_RULES[emojiMode] || EMOJI_RULES.light;
  const program = getProgramContext() || 'this programme';

  const lines = [
    `PERSONA: ${profile.tone}`,
    `EMOJI: ${emojiRule}`,
  ];
  if (program) {
    lines.push(`CONTEXT: You are the assistant for ${program}. Keep all answers relevant to this programme.`);
  }
  return lines.join('\n');
}

/** Pick a random off-topic deflection for the current persona. */
function offTopicReply(question) {
  const persona = getPersona();
  const mode    = getOffTopicMode();
  if (mode === 'silent') return null; // return null = use BOT_NO_ANSWER (stay quiet)

  const pool    = DEFLECTIONS[persona] || DEFLECTIONS.friendly;
  const program = getProgramContext() || 'this programme';
  const template = pool[Math.floor(Math.random() * pool.length)];
  const short   = String(question || '').slice(0, 60) + (question?.length > 60 ? '…' : '');
  return template
    .replace(/{PROGRAM}/g, program)
    .replace(/{QUESTION}/g, short);
}

/** All persona metadata for the dashboard. */
function getAllPersonas() {
  return Object.entries(PERSONAS).map(([id, p]) => ({ id, label: p.label, emoji: p.emoji }));
}

module.exports = { personaBlock, offTopicReply, getAllPersonas };
