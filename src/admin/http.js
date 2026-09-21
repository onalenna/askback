const crypto = require('crypto');

function basePath() {
  const raw = String(process.env.BASE_PATH || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function adminUser() {
  return String(process.env.ADMIN_USER || 'askback').trim() || 'askback';
}

function adminPassword() {
  return String(process.env.ADMIN_PASSWORD || '').trim();
}

function publicAdmin() {
  return Boolean(basePath()) || process.env.PUBLIC_ADMIN === '1';
}

function requireAuth() {
  if (publicAdmin()) return true;
  const flag = String(process.env.LOCAL_ADMIN_PASSWORD || '').trim().toLowerCase();
  return flag === '1' || flag === 'on' || flag === 'true';
}

function secretEqual(a, b) {
  const left  = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

// ── Session store (in-memory + SQLite persistence) ────────────────────────────
// Sessions are 32-byte random hex tokens stored in a cookie named `askback_sid`.
// TTL is 30 days; idle sessions pruned on startup.

const SESSION_COOKIE = 'askback_sid';
const SESSION_TTL_SECS = 30 * 24 * 60 * 60; // 30 days

let _sessionDb = null;
function sessionDb() {
  if (!_sessionDb) {
    // Lazy-load to avoid a require cycle at module evaluation time.
    _sessionDb = require('../db/index');
  }
  return _sessionDb;
}

function pruneOldSessions() {
  try {
    sessionDb().prepare(
      `DELETE FROM sessions WHERE last_seen < unixepoch() - ?`
    ).run(SESSION_TTL_SECS);
  } catch { /* sessions table not yet created */ }
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  try {
    sessionDb().prepare(
      `INSERT INTO sessions (token) VALUES (?)`
    ).run(token);
  } catch { /* ignore if table missing */ }
  return token;
}

function touchSession(token) {
  try {
    const row = sessionDb().prepare(
      `SELECT token FROM sessions WHERE token = ? AND last_seen > unixepoch() - ?`
    ).get(token, SESSION_TTL_SECS);
    if (!row) return false;
    sessionDb().prepare(
      `UPDATE sessions SET last_seen = unixepoch() WHERE token = ?`
    ).run(token);
    return true;
  } catch {
    return false;
  }
}

function destroySession(token) {
  try { sessionDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token); } catch { /* ignore */ }
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  return Object.fromEntries(
    raw.split(';').map((p) => {
      const [k, ...rest] = p.trim().split('=');
      return [k.trim(), decodeURIComponent(rest.join('='))];
    })
  );
}

function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SECS}; SameSite=Strict`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`
  );
}

// ── Login page HTML ───────────────────────────────────────────────────────────

function loginPageHtml(base, error) {
  const errHtml = error
    ? `<p style="color:#dc2626;font-size:13px;margin-bottom:12px">${error}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>askBack — Login</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,"Segoe UI",Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:36px 32px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.brand-icon{width:38px;height:38px;background:#1668b4;border-radius:8px;display:flex;align-items:center;justify-content:center}
.brand-icon svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.brand-name{font-size:20px;font-weight:800;color:#0f2a4a}
h1{font-size:15px;font-weight:600;color:#3a4f63;margin-bottom:20px}
label{display:block;font-size:13px;font-weight:500;color:#3a4f63;margin-bottom:5px}
input{width:100%;padding:9px 11px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;color:#1c2b3a;margin-bottom:14px}
input:focus{outline:none;border-color:#1668b4}
button{width:100%;padding:10px;background:#0f2a4a;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#1a3a5e}
</style>
</head>
<body>
<div class="card">
  <div class="brand">
    <div class="brand-icon"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
    <span class="brand-name">askBack</span>
  </div>
  <h1>Sign in to the admin panel</h1>
  ${errHtml}
  <form method="POST" action="${base}/login">
    <label for="u">Username</label>
    <input id="u" name="username" type="text" autocomplete="username" required autofocus />
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
  </form>
</div>
</body>
</html>`;
}

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAdminAuth(req, res, next) {
  if (!requireAuth()) return next();
  const password = adminPassword();
  if (!password) {
    res.status(500).send('Set ADMIN_PASSWORD before putting the admin panel online.');
    return;
  }

  // Valid session cookie → pass through.
  const token = getSessionToken(req);
  if (token && touchSession(token)) return next();

  // Redirect to login page.
  const base = basePath();
  res.redirect(302, `${base}/login`);
}

// Prune expired sessions once at startup (best-effort).
setTimeout(pruneOldSessions, 2000);

module.exports = {
  basePath,
  adminUser,
  adminPassword,
  publicAdmin,
  requireAuth,
  requireAdminAuth,
  requireAuth,
  // session helpers used by server.js login routes
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  loginPageHtml,
  secretEqual,
};
