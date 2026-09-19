const { statements } = require('../db/queries');
const { normalizeJid, isPersonJid } = require('./mentions');

const SETTING_KEY = 'admin_users';

function parsePhone(input) {
  let digits = String(input || '').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Use a full WhatsApp number with country code, like 26776123456.');
  }
  return digits;
}

function publicAdmin(admin) {
  return {
    id: admin.id,
    name: admin.name,
    phone: admin.phone,
  };
}

function readAdmins() {
  try {
    const parsed = JSON.parse(statements.getSetting.get(SETTING_KEY)?.value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        id: String(row?.id || ''),
        name: String(row?.name || '').trim(),
        phone: String(row?.phone || '').replace(/[^\d]/g, ''),
        jid: normalizeJid(row?.jid),
      }))
      .filter((row) => row.id && row.phone && isPersonJid(row.jid));
  } catch {
    return [];
  }
}

function writeAdmins(admins) {
  statements.setSetting.run(SETTING_KEY, JSON.stringify(admins));
  return admins.map(publicAdmin);
}

function listAdmins() {
  return readAdmins().map(publicAdmin);
}

function addAdmin({ name, phone }) {
  const displayName = String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!displayName) throw new Error('Give the admin a name.');
  const digits = parsePhone(phone);
  const jid = `${digits}@s.whatsapp.net`;
  const admins = readAdmins();
  if (admins.some((admin) => admin.phone === digits)) {
    throw new Error('That number is already an admin.');
  }
  admins.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: displayName,
    phone: digits,
    jid,
  });
  return writeAdmins(admins);
}

function removeAdmin(id) {
  const admins = readAdmins();
  const next = admins.filter((admin) => admin.id !== String(id || ''));
  if (next.length === admins.length) {
    throw new Error('Admin not found.');
  }
  return writeAdmins(next);
}

function getAdminJids() {
  return [...new Set(readAdmins().map((admin) => admin.jid).filter(Boolean))];
}

module.exports = {
  listAdmins,
  addAdmin,
  removeAdmin,
  getAdminJids,
};
