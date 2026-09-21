require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const { createAdminRouter } = require('./src/admin/routes');
const { startWhatsApp } = require('./src/whatsapp/client');
const {
  basePath, publicAdmin, adminPassword, adminUser,
  requireAdminAuth, requireAuth, secretEqual,
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  loginPageHtml,
} = require('./src/admin/http');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (publicAdmin() ? '0.0.0.0' : '127.0.0.1');
const BASE = basePath();
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');

if (requireAuth() && !adminPassword()) {
  console.error('Admin login is required (PUBLIC_ADMIN/BASE_PATH or LOCAL_ADMIN_PASSWORD set), but ADMIN_PASSWORD is empty. Refusing to start.');
  process.exit(1);
}

function renderIndex() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  return html.replaceAll('{{BASE}}', BASE);
}

const app = express();
if (publicAdmin()) app.set('trust proxy', 1);

// Register /health and login routes BEFORE the auth-protected site.
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'askback' });
});

// Login page (GET) and form submit (POST)
if (requireAuth()) {
  app.get(`${BASE}/login`, (_req, res) => {
    res.type('html').send(loginPageHtml(BASE, null));
  });
  app.post(`${BASE}/login`, express.urlencoded({ extended: false }), (req, res) => {
    const { username = '', password = '' } = req.body || {};
    if (secretEqual(username, adminUser()) && secretEqual(password, adminPassword())) {
      const token = createSession();
      setSessionCookie(res, token);
      res.redirect(302, `${BASE || '/'}`);
    } else {
      res.type('html').send(loginPageHtml(BASE, 'Incorrect username or password.'));
    }
  });
  app.get(`${BASE}/logout`, (req, res) => {
    const { getSessionToken } = require('./src/admin/http');
    destroySession(getSessionToken(req));
    clearSessionCookie(res);
    res.redirect(302, `${BASE}/login`);
  });
}

const site = express.Router();
site.use(requireAdminAuth);
site.get(['/', '/index.html'], (_req, res) => {
  res.type('html').send(renderIndex());
});
site.use(express.static(PUBLIC_DIR, { index: false }));
site.use(createAdminRouter());

if (BASE) {
  app.get(BASE, (_req, res) => res.redirect(302, `${BASE}/`));
  app.use(BASE, site);
} else {
  app.use(site);
}

const server = app.listen(PORT, HOST, () => {
  const local = `http://127.0.0.1:${PORT}${BASE || ''}/`;
  console.log(`Admin panel: ${local}`);
  if (publicAdmin()) {
    console.log(`Public path: ${BASE || '/'} (user ${adminUser()})`);
  }
  console.log('Starting WhatsApp client (private + group)…');
  try {
    const { syncStickersLibrary } = require('./src/stickers/library');
    const synced = syncStickersLibrary();
    console.log(
      `[stickers] library ${synced.dir} — ${synced.total} file(s)${synced.added ? `, +${synced.added} new` : ''} (replies off)`
    );
  } catch (err) {
    console.warn('[stickers] could not sync library:', err.message || err);
  }
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
