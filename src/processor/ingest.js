const fs = require('fs');
const path = require('path');
const { statements } = require('../db/queries');
const { getEmbeddingsBatch } = require('../ai/embeddings');
const { processPdf } = require('./pdf');
const { processAudio } = require('./audio');
const { processText } = require('./text');
const { processImage } = require('./image');
const { processDocument } = require('./document');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

function mimeFor(filename, type) {
  const ext = path.extname(filename || '').toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.text': 'text/plain',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  if (map[ext]) return map[ext];
  if (type === 'pdf') return 'application/pdf';
  if (type === 'text') return 'text/plain';
  if (type === 'image') return 'image/jpeg';
  if (type === 'document') return 'application/octet-stream';
  return 'application/octet-stream';
}

function safeFilename(filename) {
  const base = path.basename(filename || 'file');
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'file';
}

function persistUpload(docId, srcPath, filename) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const dest = path.join(UPLOAD_DIR, `${docId}-${safeFilename(filename)}`);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

function unlinkQuiet(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

async function extractAndEmbed(docId, filePath, type, filename = '') {
  let chunks;
  if (type === 'pdf') {
    chunks = await processPdf(filePath);
  } else if (type === 'audio') {
    chunks = await processAudio(filePath);
  } else if (type === 'text') {
    chunks = processText(filePath);
  } else if (type === 'image') {
    chunks = await processImage(filePath, filename);
  } else if (type === 'document') {
    chunks = await processDocument(filePath, filename);
  } else {
    throw new Error(`Unsupported file type: ${type}`);
  }

  if (!chunks.length) {
    throw new Error('No text content could be extracted from this file.');
  }

  const embeddings = await getEmbeddingsBatch(chunks);
  statements.deleteChunksByDoc.run(docId);
  chunks.forEach((content, i) => {
    statements.insertChunk.run(docId, i, content, JSON.stringify(embeddings[i]));
  });
  statements.updateDocChunks.run(chunks.length, docId);
  return chunks.length;
}

function displayTitle(title, filename) {
  const label = String(title || '').replace(/\s+/g, ' ').trim();
  if (label) return label.slice(0, 120);
  const stem = String(filename || '').replace(/\.[^.]+$/, '');
  return (stem || filename || 'Untitled').slice(0, 120);
}

async function ingestFile(filePath, filename, type, title = '') {
  const mime = mimeFor(filename, type);
  const label = displayTitle(title, filename);
  const docId = statements.insertDoc.run(filename, type, '', mime, label).lastInsertRowid;
  let storedPath = '';

  try {
    storedPath = persistUpload(docId, filePath, filename);
    statements.updateDocFile.run(storedPath, mime, docId);
    const chunkCount = await extractAndEmbed(docId, filePath, type, filename);
    return {
      id: docId,
      filename,
      title: label,
      type,
      chunkCount,
      filePath: storedPath,
    };
  } catch (err) {
    statements.updateDocStatus.run('error', err.message, docId);
    throw err;
  }
}

async function replaceFile(docId, filePath, filename, type) {
  const existing = statements.getDoc.get(docId);
  if (!existing) {
    throw new Error('Document not found');
  }

  const mime = mimeFor(filename, type);
  let storedPath = '';

  try {
    storedPath = persistUpload(docId, filePath, filename);
    if (existing.file_path && existing.file_path !== storedPath) {
      unlinkQuiet(existing.file_path);
    }
    statements.updateDocMeta.run(
      filename,
      type,
      storedPath,
      mime,
      'processing',
      '',
      0,
      docId
    );
    const chunkCount = await extractAndEmbed(docId, filePath, type, filename);
    return {
      id: docId,
      filename,
      title: existing.title || displayTitle('', filename),
      type,
      chunkCount,
      filePath: storedPath,
    };
  } catch (err) {
    statements.updateDocStatus.run('error', err.message, docId);
    throw err;
  }
}

module.exports = { ingestFile, replaceFile, unlinkQuiet };
