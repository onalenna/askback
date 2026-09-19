const fs = require('fs');
const path = require('path');
const { extractDocumentText } = require('./office');
const { chunkText } = require('./chunking');

async function processDocument(filePath, filename = '') {
  const name = filename || path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const text = await extractDocumentText(buffer, name, '');
  if (!text) return [];
  return chunkText(`Document (${name}):\n${text}`);
}

module.exports = { processDocument };
