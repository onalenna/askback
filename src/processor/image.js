const fs = require('fs');
const path = require('path');
const { understandImage } = require('../ai/vision');
const { chunkText } = require('./chunking');

function mimeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
  };
  return map[ext] || 'image/jpeg';
}

async function processImage(filePath, filename = '') {
  const buffer = fs.readFileSync(filePath);
  const name = filename || path.basename(filePath);
  const text = await understandImage(buffer, mimeFromPath(name || filePath), {
    caption: `Knowledge file: ${name}`,
  });
  if (!text) return [];
  return chunkText(`Image (${name}):\n${text}`);
}

module.exports = { processImage, mimeFromPath };
