const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractTextFromPdf } = require('./pdf');

const MAX_TEXT = 40000;

function isPlainText(filename, mimetype) {
  const ext = path.extname(filename || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase();
  return (
    ['.txt', '.text', '.md', '.csv', '.log', '.json', '.xml', '.html', '.htm', '.rtf'].includes(ext) ||
    mime === 'text/plain' ||
    mime === 'text/csv' ||
    mime === 'text/markdown' ||
    mime === 'application/json'
  );
}

function looksLikeImage(filename, mimetype) {
  const ext = path.extname(filename || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase();
  return (
    ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic'].includes(ext) ||
    mime.startsWith('image/')
  );
}

function readUtf(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function decodeXml(xml) {
  return String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<\/si>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function zipEntry(filePath, entry) {
  try {
    return execFileSync('unzip', ['-p', filePath, entry], {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return execFileSync(
      'python3',
      [
        '-c',
        'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',
        filePath,
        entry,
      ],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }
    );
  }
}

function zipList(filePath) {
  try {
    return execFileSync('unzip', ['-Z', '-1', filePath], { encoding: 'utf8', timeout: 15000 });
  } catch {
    return execFileSync(
      'python3',
      ['-c', 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', filePath],
      { encoding: 'utf8', timeout: 15000 }
    );
  }
}

async function withTemp(buffer, ext, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askback-doc-'));
  const file = path.join(dir, `file${ext || '.bin'}`);
  fs.writeFileSync(file, buffer);
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function clip(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_TEXT) return t;
  return `${t.slice(0, MAX_TEXT)}\n…`;
}

function officeExt(filename, mimetype) {
  const ext = path.extname(filename || '').toLowerCase();
  if (['.docx', '.xlsx', '.pptx'].includes(ext)) return ext;
  const mime = String(mimetype || '').toLowerCase();
  if (mime.includes('wordprocessingml') || mime.includes('msword')) return '.docx';
  if (mime.includes('spreadsheetml') || mime.includes('excel')) return '.xlsx';
  if (mime.includes('presentationml') || mime.includes('powerpoint')) return '.pptx';
  return '';
}

function extractOfficeFile(file, ext) {
  if (ext === '.docx') {
    return decodeXml(zipEntry(file, 'word/document.xml').toString('utf8'));
  }
  if (ext === '.xlsx') {
    const names = zipList(file);
    const parts = [];
    if (names.includes('xl/sharedStrings.xml')) {
      parts.push(decodeXml(zipEntry(file, 'xl/sharedStrings.xml').toString('utf8')));
    }
    const sheets = names
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('xl/worksheets/sheet'));
    for (const sheet of sheets.slice(0, 8)) {
      parts.push(decodeXml(zipEntry(file, sheet).toString('utf8')));
    }
    return parts.filter(Boolean).join('\n');
  }
  if (ext === '.pptx') {
    const names = zipList(file)
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    names.sort();
    return names
      .slice(0, 20)
      .map((n) => decodeXml(zipEntry(file, n).toString('utf8')))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

async function extractDocumentText(buffer, filename, mimetype) {
  if (!buffer?.length) return '';
  const ext = path.extname(filename || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase();

  if (ext === '.pdf' || mime.includes('pdf')) {
    const text = await withTemp(buffer, '.pdf', (file) => extractTextFromPdf(file));
    return clip(text);
  }
  if (isPlainText(filename, mimetype)) {
    return clip(readUtf(buffer));
  }
  const office = officeExt(filename, mimetype);
  if (office) {
    return clip(await withTemp(buffer, office, (file) => extractOfficeFile(file, office)));
  }
  return '';
}

module.exports = { extractDocumentText, isPlainText, looksLikeImage };
