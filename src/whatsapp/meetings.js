const { statements } = require('../db/queries');
const { getEmbedding, openai } = require('../ai/embeddings');
const { CHAT_MODEL } = require('../ai/embeddings');
const { polishAnswer } = require('../ai/generator');

/**
 * Meeting / call recording helpers.
 *
 * When a recording is uploaded on the Knowledge panel it is transcribed into
 * chunks like any other file. This module adds a second pass that turns that
 * transcript into a short, structured summary (Key points / Decisions / Action
 * items / When) so a member who missed the call can ask "what did I miss in the
 * last meeting" and get the summary instead of a raw transcript dump.
 *
 * The summary is stored as one extra chunk on the SAME document (so it is
 * searchable by the normal knowledge search) and is marked with a heading the
 * answer path can recognise.
 */

const SETTING_ENABLED = 'meeting_summaries';
/** Heading prepended to the stored summary chunk so we can find it again. */
const SUMMARY_HEADING = 'Meeting summary';
/** Document types we treat as recordings. */
const RECORDING_TYPES = new Set(['audio', 'video']);

/** @returns {'on'|'off'} whether auto-summaries of recordings are enabled. */
function getMeetingSummaries() {
  try {
    const row = statements.getSetting.get(SETTING_ENABLED);
    if (!row?.value) return 'on';
    return row.value === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

/** Turn the feature on or off. @returns {'on'|'off'} the saved value. */
function setMeetingSummaries(enabled) {
  const value = enabled ? 'on' : 'off';
  statements.setSetting.run(SETTING_ENABLED, value);
  return value;
}

/** True when a document type is a call/meeting recording. */
function isRecordingType(type) {
  return RECORDING_TYPES.has(String(type || '').toLowerCase());
}

/**
 * Build a structured summary of a transcript via the chat model.
 * Returns '' when the model has nothing usable (never throws to the caller).
 * @param {string} transcript full recording transcript
 * @param {string} title human title of the recording, used for context only
 */
async function summarizeTranscript(transcript, title = '') {
  const text = String(transcript || '').trim();
  if (!text) return '';
  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL(),
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            'You summarize a meeting or call transcript for people who missed it. Be clear and brief. Never invent things that were not said. Never mention knowledge files or sources. Never use -- or dash characters as punctuation.',
        },
        {
          role: 'user',
          content: [
            title ? `Recording: ${title}` : 'Recording',
            'Summarize the transcript below in this exact shape:',
            '',
            'Key points',
            '<3 to 6 short bullets of what was discussed>',
            '',
            'Decisions',
            '<what was decided, or "None noted">',
            '',
            'Action items',
            '<who should do what, or "None noted">',
            '',
            'When',
            '<any dates or times mentioned, or "None noted">',
            '',
            'Keep the whole summary under 200 words.',
            '',
            'Transcript:',
            text.slice(0, 12000),
          ].join('\n'),
        },
      ],
    });
    const raw = (completion.choices[0].message.content || '').trim();
    if (!raw) return '';
    return polishAnswer(raw);
  } catch (err) {
    console.warn('[meetings] summary failed:', err.message || err);
    return '';
  }
}

/**
 * After a recording is ingested, generate its summary and store it as an extra
 * searchable chunk on the same document. Best-effort: logs and returns on any
 * failure so a summary problem never breaks the upload.
 * @param {number} docId document id the chunks belong to
 * @param {string} type document type (only audio/video are summarized)
 * @param {string} title human title of the document
 */
async function summarizeRecordingDoc(docId, type, title = '') {
  if (getMeetingSummaries() === 'off') return;
  if (!isRecordingType(type)) return;
  if (!docId) return;

  try {
    const chunks = statements.allChunksByDoc.all(docId);
    const transcript = chunks
      .map((chunk) => chunk.content)
      .filter(Boolean)
      .join('\n');
    if (!transcript.trim()) return;

    const summary = await summarizeTranscript(transcript, title);
    if (!summary) return;

    const body = `${SUMMARY_HEADING}${title ? ` — ${title}` : ''}\n${summary}`;
    const nextIndex = chunks.length; // append after the transcript chunks
    const embedding = await getEmbedding(body);
    statements.insertChunk.run(docId, nextIndex, body, JSON.stringify(embedding));
    // Keep the document's chunk_count in step with what is stored.
    statements.updateDocChunks.run(nextIndex + 1, docId);
    console.log(`[meetings] stored summary for recording #${docId} (${title || 'untitled'})`);
  } catch (err) {
    console.warn('[meetings] could not summarize recording:', err.message || err);
  }
}

/**
 * Answer "what did I miss in the last meeting/call/recording".
 * Returns the newest recording's stored summary, or null when there is none.
 * @returns {{ text: string, title: string } | null}
 */
function newestMeetingSummary() {
  let doc;
  try {
    doc = statements.newestMeetingDoc.get();
  } catch (err) {
    console.warn('[meetings] lookup failed:', err.message || err);
    return null;
  }
  if (!doc) return null;

  const chunks = statements.allChunksByDoc.all(doc.id);
  const summaryChunk = chunks.find((chunk) =>
    String(chunk.content || '').startsWith(SUMMARY_HEADING)
  );

  const title = doc.title || doc.filename || 'the last recording';
  if (summaryChunk) {
    // Drop our internal heading line so the reply reads naturally.
    const lines = String(summaryChunk.content).split('\n');
    const bodyText = lines.slice(1).join('\n').trim() || summaryChunk.content;
    return { text: bodyText, title };
  }

  // No stored summary (e.g. summaries were off at upload time): fall back to
  // the raw transcript so the member still gets something useful.
  const transcript = chunks
    .map((chunk) => chunk.content)
    .join('\n')
    .slice(0, 1500)
    .trim();
  if (!transcript) return null;
  return { text: transcript, title };
}

module.exports = {
  SUMMARY_HEADING,
  getMeetingSummaries,
  setMeetingSummaries,
  isRecordingType,
  summarizeTranscript,
  summarizeRecordingDoc,
  newestMeetingSummary,
};
