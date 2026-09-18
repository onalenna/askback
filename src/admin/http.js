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

function secretEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="askBack"');
  res.status(401).send('Password required');
}

function requireAdminAuth(req, res, next) {
  if (!publicAdmin()) return next();
  const password = adminPassword();
  if (!password) {
    res.status(500).send('Set ADMIN_PASSWORD before putting the admin panel online.');
    return;
  }

  const header = String(req.headers.authorization || '');
  const encoded = header.startsWith('Basic ') ? header.slice(6).trim() : '';
  let decoded = '';
  try {
    decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  } catch {
    unauthorized(res);
    return;
  }
  const colon = decoded.indexOf(':');
  const user = colon >= 0 ? decoded.slice(0, colon) : '';
  const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
  if (secretEqual(user, adminUser()) && secretEqual(pass, password)) {
    next();
    return;
  }
  unauthorized(res);
}

module.exports = {
  basePath,
  adminUser,
  adminPassword,
  publicAdmin,
  requireAdminAuth,
};
