'use strict';
// Auto-ingest recent WhatsApp group messages into the knowledge base.
// Runs every 6 hours, ingests the last 48h from allowed groups,
// and replaces the previous auto-ingested document.

const db = require('../db');
const { statements } = require('../db/queries');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ingestFile, unlinkQuiet } = require('../processor/ingest');

const TZ = 'Africa/Maputo'; // CAT UTC+2
const SETTING_ENABLED  = 'auto_ingest_chat';
const SETTING_DOC_ID   = 'auto_ingest_doc_id';
const SETTING_LAST_RUN = 'auto_ingest_last_run';
const WINDOW_SECS      = 48 * 60 * 60;   // 48-hour rolling window
const INTERVAL_MS      = 6 * 60 * 60 * 1000; // refresh every 6 hours
const MIN_MESSAGES     = 5;              // skip if fewer new messages

let timer = null;
let running = false;

function getEnabled() {
  try {
    const r = statements.getSetting.get(SETTING_ENABLED);
    return r?.value !== 'off';
  } catch { return true; }
}

function getAllowedJids() {
  try {
    const r = statements.getSetting.get('allowed_groups');
    return JSON.parse(r?.value || '[]');
  } catch { return []; }
}

function catLabel(tsSeconds) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    month: 'numeric', day: 'numeric', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h12',
  }).format(new Date(tsSeconds * 1000));
}

function deleteDoc(docId) {
  try {
    const doc = statements.getDoc.get(docId);
    if (!doc) return;
    unlinkQuiet(doc.file_path);
    db.prepare('DELETE FROM qa_history WHERE document_id=?').run(docId);
    db.prepare('DELETE FROM chunks WHERE document_id=?').run(docId);
    db.prepare('DELETE FROM documents WHERE id=?').run(docId);
  } catch (err) {
    console.warn('[autoingest] deleteDoc error:', err.message);
  }
}

async function runAutoIngest() {
  if (!getEnabled() || running) return;
  running = true;
  try {
    const jids = getAllowedJids();
    if (!jids.length) return;

    const since = Math.floor(Date.now() / 1000) - WINDOW_SECS;

    // Placeholders for IN clause
    const placeholders = jids.map(() => '?').join(',');
    const messages = db.prepare(`
      SELECT ts, sender_name, body
      FROM chat_messages
      WHERE ts >= ? AND chat_jid IN (${placeholders}) AND from_me = 0 AND body != ''
      ORDER BY ts ASC
      LIMIT 5000
    `).all(since, ...jids);

    if (messages.length < MIN_MESSAGES) {
      console.log(`[autoingest] only ${messages.length} messages in window, skipping`);
      return;
    }

    // Format as WhatsApp-style chat export
    const lines = messages.map(m => {
      const time = catLabel(m.ts);
      const name = (m.sender_name || 'Member').replace(/\n/g, ' ');
      const body = (m.body || '').replace(/\n/g, '\n  ');
      return `[${time}] ${name}: ${body}`;
    });
    const content = lines.join('\n');

    const firstLabel = catLabel(messages[0].ts);
    const lastLabel  = catLabel(messages[messages.length - 1].ts);
    const title = `METI Chat Live Feed (${firstLabel} – ${lastLabel})`;

    // Write temp file
    const tmpPath = path.join(os.tmpdir(), `autoingest_${Date.now()}.txt`);
    fs.writeFileSync(tmpPath, content, 'utf8');

    try {
      // Delete old auto-ingested doc
      const prevRow = statements.getSetting.get(SETTING_DOC_ID);
      if (prevRow?.value) deleteDoc(parseInt(prevRow.value, 10));

      // Ingest fresh batch
      const result = await ingestFile(tmpPath, 'live_chat.txt', 'text', title);
      statements.setSetting.run(SETTING_DOC_ID, String(result.id));
      statements.setSetting.run(SETTING_LAST_RUN, String(Math.floor(Date.now() / 1000)));

      console.log(`[autoingest] done — ${messages.length} msgs → doc ${result.id}, ${result.chunkCount} chunks`);
    } finally {
      unlinkQuiet(tmpPath);
    }
  } catch (err) {
    console.error('[autoingest] error:', err.message || err);
  } finally {
    running = false;
  }
}

function startAutoIngest() {
  if (timer) clearInterval(timer);
  // First run 2 minutes after startup, then every 6 hours
  setTimeout(() => runAutoIngest().catch(console.error), 2 * 60 * 1000);
  timer = setInterval(() => runAutoIngest().catch(console.error), INTERVAL_MS);
  console.log('[autoingest] scheduler started (every 6h, 48h rolling window)');
}

function stopAutoIngest() {
  if (timer) { clearInterval(timer); timer = null; }
}

function getStatus() {
  const docRow  = statements.getSetting.get(SETTING_DOC_ID);
  const lastRow = statements.getSetting.get(SETTING_LAST_RUN);
  const docId   = docRow?.value ? parseInt(docRow.value, 10) : null;
  const doc     = docId ? statements.getDoc.get(docId) : null;
  return {
    enabled:     getEnabled(),
    docId,
    docTitle:    doc?.title || null,
    chunkCount:  doc?.chunk_count || 0,
    lastRunTs:   lastRow?.value ? parseInt(lastRow.value, 10) : null,
  };
}

module.exports = { startAutoIngest, stopAutoIngest, runAutoIngest, getStatus };
