require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const { createAdminRouter } = require('./src/admin/routes');
const { startWhatsApp } = require('./src/whatsapp/client');
const { basePath, publicAdmin, adminPassword, adminUser, requireAdminAuth } = require('./src/admin/http');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (publicAdmin() ? '0.0.0.0' : '127.0.0.1');
const BASE = basePath();
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');

if (publicAdmin() && !adminPassword()) {
  console.error('BASE_PATH or PUBLIC_ADMIN is set, but ADMIN_PASSWORD is empty. Refusing to start.');
  process.exit(1);
}

function renderIndex() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  return html.replaceAll('{{BASE}}', BASE);
}

const app = express();
if (publicAdmin()) app.set('trust proxy', 1);

const site = express.Router();
site.use(requireAdminAuth);
site.get(['/', '/index.html'], (_req, res) => {
  res.type('html').send(renderIndex());
});
site.use(express.static(PUBLIC_DIR, { index: false }));
site.use(createAdminRouter());
site.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'askback' });
});

if (BASE) {
  app.get(BASE, (_req, res) => res.redirect(302, `${BASE}/`));
  app.use(BASE, site);
} else {
  app.use(site);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'askback' });
});

const server = app.listen(PORT, HOST, () => {
  const local = `http://127.0.0.1:${PORT}${BASE || ''}/`;
  console.log(`Admin panel: ${local}`);
  if (publicAdmin()) {
    console.log(`Public path: ${BASE || '/'} (user ${adminUser()})`);
  }
  console.log('Starting WhatsApp client (private + group)…');
  startWhatsApp().catch((err) => {
    console.error('Failed to start WhatsApp:', err.message || err);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other askBack process, then start again.`);
    process.exit(1);
  }
  console.error('Failed to start:', err.message || err);
  process.exit(1);
});
