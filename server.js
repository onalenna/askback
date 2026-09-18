require('dotenv').config();

const path = require('path');
const express = require('express');
const { createAdminRouter } = require('./src/admin/routes');
const { startWhatsApp } = require('./src/whatsapp/client');

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(createAdminRouter());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'askback' });
});

app.listen(PORT, () => {
  console.log(`Admin panel: http://localhost:${PORT}`);
  console.log('Starting WhatsApp client (private + group)…');
  startWhatsApp().catch((err) => {
    console.error('Failed to start WhatsApp:', err.message || err);
  });
});
