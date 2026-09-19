const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const { chunkText } = require('./chunking');

async function extractTextFromPdf(filePath) {
  const data = fs.readFileSync(filePath);
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy();
  }
}

async function processPdf(filePath) {
  const text = await extractTextFromPdf(filePath);
  return chunkText(text);
}

module.exports = { processPdf, extractTextFromPdf };